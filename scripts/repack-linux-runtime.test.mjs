import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {repackLinuxRuntime, runtimeInventory} from './repack-linux-runtime.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'chimera opaque runtime '));
  t.after(() => rm(root, {recursive: true, force: true}));
  const runtime = join(root, 'runtime'), source = join(root, 'thin.AppImage'), plugin = join(root, 'plugin.AppImage');
  await mkdir(runtime);
  await mkdir(join(runtime, 'private'), {mode: 0o750});
  await writeFile(join(runtime, 'runtime.json'), JSON.stringify({version: '1.2.3', platform: 'linux', arch: 'x64'}));
  await writeFile(join(runtime, 'codex'), 'immutable static ELF', {mode: 0o755});
  await symlink('codex', join(runtime, 'codex-link'));
  await writeFile(source, 'original thin artifact', {mode: 0o755});
  await writeFile(plugin, 'output plugin', {mode: 0o755});
  return {runtime, source, plugin, version: '1.2.3', arch: 'x64'};
}

for (const fault of ['none', 'bytes', 'mode', 'directory-mode', 'link', 'plugin', 'embedded', 'offset', 'extractor']) {
  test(`opaque runtime repack ${fault}: preserves originals and checks final extracted content`, async t => {
    const f = await fixture(t), before = await runtimeInventory(f.runtime), calls = [];
    let appDir, temporary;
    const run = async (command, args, options) => {
      calls.push(command);
      if (command === f.source) {
        assert.deepEqual(args, ['--appimage-extract']);
        temporary = options.cwd;
        await mkdir(join(options.cwd, 'squashfs-root/usr/lib/chimera'), {recursive: true});
        if (fault === 'embedded') await mkdir(join(options.cwd, 'squashfs-root/usr/lib/chimera/runtime'));
      } else if (command === f.plugin) {
        assert.equal(args[0], '--appimage-extract-and-run'); assert.equal(args[1], '--appdir');
        appDir = args[2];
        assert.equal(await runtimeInventory(join(appDir, 'usr/lib/chimera/runtime')), before);
        assert.equal(options.env.ARCH, 'x86_64'); assert.equal(options.env.LDAI_VERSION, '1.2.3');
        if (fault === 'plugin') throw new Error('pack failed');
        await writeFile(options.env.LDAI_OUTPUT, 'complete artifact', {mode: 0o755});
      } else if (command !== 'unsquashfs') {
        assert.deepEqual(args, ['--appimage-offset']);
        return fault === 'offset' ? 'NaN\n' : '8\n';
      } else {
        assert.deepEqual(args.slice(0, 3), ['-no-progress', '-offset', '8']);
        assert.equal(args[3], '-dest');
        assert.equal(args[6], 'usr/lib/chimera/runtime');
        if (fault === 'extractor') throw new Error('unsquashfs failed');
        await cp(appDir, args[4], {recursive: true, verbatimSymlinks: true});
        const copy = join(args[4], 'usr/lib/chimera');
        if (fault === 'bytes') await writeFile(join(copy, 'runtime/codex'), 'patched ELF');
        if (fault === 'mode') await chmod(join(copy, 'runtime/codex'), 0o644);
        if (fault === 'directory-mode') await chmod(join(copy, 'runtime/private'), 0o700);
        if (fault === 'link') { await rm(join(copy, 'runtime/codex-link')); await symlink('wrong', join(copy, 'runtime/codex-link')); }
      }
    };
    if (fault === 'none') {
      await repackLinuxRuntime({...f, run});
      assert.equal(await readFile(f.source, 'utf8'), 'complete artifact');
      assert.equal(calls.length, 4);
    } else {
      await assert.rejects(repackLinuxRuntime({...f, run}), /changed|pack failed|already contains|Invalid AppImage|unsquashfs failed/);
      assert.equal(await readFile(f.source, 'utf8'), 'original thin artifact');
    }
    assert.equal(await runtimeInventory(f.runtime), before);
    await assert.rejects(lstat(temporary), {code: 'ENOENT'});
  });
}
test('wrong target and missing plugin fail before invoking a process', async t => {
  const f = await fixture(t);
  const run = () => assert.fail('unexpected process');
  await assert.rejects(repackLinuxRuntime({...f, arch: 'arm64', run}), /target mismatch/);
  await rm(f.plugin);
  await assert.rejects(repackLinuxRuntime({...f, run}), {code: 'ENOENT'});
});
