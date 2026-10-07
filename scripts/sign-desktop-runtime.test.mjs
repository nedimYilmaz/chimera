import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

for (const scenario of ['success', 'missing-identity', 'sign-failure', 'import-failure']) {
  test(`private runtime signing keychain: ${scenario}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'chimera signing contract '));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = join(dir, 'runtime'), report = join(dir, 'calls.json');
    await mkdir(root);
    await writeFile(join(root, 'node'), Buffer.from('cffaedfe', 'hex'));
    const original = await readFile(new URL('./sign-desktop-runtime.mjs', import.meta.url), 'utf8');
    const stub = `
      import assert from 'node:assert/strict';
      import {writeFileSync, readFileSync, statSync} from 'node:fs';
      Object.defineProperty(process, 'platform', {value:'darwin'});
      const calls=[]; let searchable=false;
      process.on('exit', () => writeFileSync(${JSON.stringify(report)}, JSON.stringify(calls)));
      const execFileSync = (command, args) => {
        calls.push({command,args:args.map((v,i)=>['-P','-p','-k'].includes(args[i-1]) ? '<redacted>' : v)});
        if (command === '/usr/bin/security') {
          if (args[0] === 'list-keychains' && !args.includes('-s')) return Buffer.from('    "/original/login.keychain-db"\\n');
          if (args[0] === 'list-keychains' && args.includes('-s')) searchable=args[4] !== '/original/login.keychain-db';
          if (args[0] === 'import') {
            if (${JSON.stringify(process.platform !== 'win32')}) assert.equal(statSync(args[1]).mode & 0o777, 0o600);
            assert.equal(readFileSync(args[1],'utf8'),'fixture certificate');
            if (${JSON.stringify(scenario)} === 'import-failure') throw Error('arbitrary secret P12_SECRET');
          }
          if (args[0] === 'find-identity') {
            assert.equal(searchable,true);
            return Buffer.from(${JSON.stringify(scenario)} === 'missing-identity' ? '0 valid identities found' : '1) ${'A'.repeat(40)} "Developer ID Application: Fixture"\\n');
          }
          return Buffer.from('');
        }
        assert.equal(command,'/usr/bin/codesign');
        assert.equal(searchable,true,'private signing key must be searchable');
        assert.equal(args[args.indexOf('--sign')+1], '${'A'.repeat(40)}');
        assert.ok(args.includes('--keychain'));
        assert.ok(args.includes('--timestamp'));
        if (${JSON.stringify(scenario)} === 'sign-failure') throw Error('fixture signing failure');
        return Buffer.from('');
      };
    `;
    const script = original.replace("import { execFileSync } from 'node:child_process';", stub);
    assert.notEqual(script, original);
    const path = join(dir, 'sign.mjs'); await writeFile(path, script);
    const child = spawnSync(process.execPath, [path, root], {encoding:'utf8', env:{...process.env,
      APPLE_SIGNING_IDENTITY:'Developer ID Application: Fixture', APPLE_CERTIFICATE:Buffer.from('fixture certificate').toString('base64'), APPLE_CERTIFICATE_PASSWORD:'P12_SECRET'}});
    assert.equal(child.status, scenario === 'success' ? 0 : 1, child.stderr);
    assert.doesNotMatch(child.stderr, /P12_SECRET|fixture certificate/);
    const calls = JSON.parse(await readFile(report,'utf8'));
    const deleted = calls.find(call => call.command === '/usr/bin/security' && call.args[0] === 'delete-keychain');
    assert.ok(deleted, 'private keychain cleanup is required after failure or success');
    assert.deepEqual(calls.at(-1).args, ['list-keychains','-d','user','-s','/original/login.keychain-db']);
    await assert.rejects(readFile(deleted.args[1]), {code:'ENOENT'});
    const imported = calls.find(call => call.command === '/usr/bin/security' && call.args[0] === 'import');
    assert.ok(imported);
    await assert.rejects(readFile(imported.args[1]), {code:'ENOENT'}); // actual fixture certificate must be erased
    assert.equal(calls.filter(call=>call.command==='/usr/bin/codesign').length, ['success','sign-failure'].includes(scenario)?1:0);
  });
}
