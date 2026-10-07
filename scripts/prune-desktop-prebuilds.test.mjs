import { test } from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pruneDesktopPrebuilds} from './prune-desktop-prebuilds.mjs';

async function fixture(t,targets) {
  const root=await mkdtemp(join(tmpdir(),'chimera prebuild fixture '));t.after(()=>rm(root,{recursive:true,force:true}));
  for (const name of ['bare-fs','bare-path','bare-url']) {
    await mkdir(join(root,'node_modules',name),{recursive:true});
    await writeFile(join(root,'node_modules',name,'index.js'),'preserve loader');
    for (const target of targets) { const dir=join(root,'node_modules',name,'prebuilds',target);await mkdir(dir,{recursive:true});await writeFile(join(dir,'addon.bare'),target); }
  }
  return root;
}
for (const platform of ['linux','darwin','win32']) for (const arch of ['x64','arm64']) {
  test(`native prebuilds preserve ${platform}-${arch} and drop foreign ABI binaries`,async t=>{
    const targets=['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64','android-x64','android-arm64','ios-arm64-simulator'];
    const root=await fixture(t,targets),removed=await pruneDesktopPrebuilds(root,platform,arch);
    assert.equal(removed.length,24);
    for (const name of ['bare-fs','bare-path','bare-url']) {
      assert.deepEqual(await readdir(join(root,'node_modules',name,'prebuilds')),[`${platform}-${arch}`]);
      assert.equal(await readFile(join(root,'node_modules',name,'prebuilds',`${platform}-${arch}`,'addon.bare'),'utf8'),`${platform}-${arch}`);
      assert.equal(await readFile(join(root,'node_modules',name,'index.js'),'utf8'),'preserve loader');
    }
    assert.deepEqual(await pruneDesktopPrebuilds(root,platform,arch),[]);
  });
}
test('missing native prebuild and unknown layout fail before deleting package entries',async t=>{
  for (const targets of [['android-x64'],['linux-x64','unknown-abi']]) {
    const root=await fixture(t,targets);
    await assert.rejects(pruneDesktopPrebuilds(root,'linux','x64'),/missing|Unreviewed/);
    assert.deepEqual((await readdir(join(root,'node_modules/bare-fs/prebuilds'))).sort(),targets.sort());
  }
});
