import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareInstalledIntegrations } from './npm-install-integrations.mjs';
import { prepareIntegrations } from './prepare-desktop-integrations.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'chimera integrations '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'signed app/runtime'), permanent = join(dir, 'npm payload');
  await mkdir(join(source, 'integrations'), { recursive: true });
  await mkdir(join(source, 'node/bin'), { recursive: true });
  const plan = { platform: 'darwin', arch: 'arm64', version: '1.2.3', state: join(dir, 'state') };
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...plan }));
  await writeFile(join(source, 'integrations/manifest.json'), JSON.stringify({ schemaVersion: 1, platform: plan.platform, arch: plan.arch }));
  await writeFile(join(source, 'node/bin/node'), 'test binary');
  await writeFile(join(source, 'prepare-integrations.mjs'), 'test setup');
  return { dir, source, permanent, plan };
}

test('verified desktop runtime becomes visible to the permanent npm daemon; model setup is awaited', async t => {
  const f = await fixture(t), calls = [];
  const root = await prepareInstalledIntegrations({ ...f, run: async (cmd, args, options) => {
    calls.push({ cmd, args });
    assert.equal(await readFile(cmd, 'utf8'), 'test binary');
    assert.equal(options.timeout, 45 * 60_000);
  } });
  assert.equal(root, join(f.permanent, 'desktop-runtime'));
  assert.deepEqual(calls, [{ cmd: join(root, 'node/bin/node'), args: [join(root, 'prepare-integrations.mjs'), f.plan.state, f.plan.version] }]);
});

test('missing resources, wrong version and model failure refuse preparation', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(prepareInstalledIntegrations({ ...f, plan: { ...f.plan, version: '1.2.4' }, run: async () => { calls++; } }), /mismatch/);
  await assert.rejects(prepareInstalledIntegrations({ ...f, run: async () => { calls++; throw new Error('model hash mismatch'); } }), /model hash mismatch/);
  assert.equal(calls, 1);
  await assert.rejects(prepareInstalledIntegrations({ ...f, run: async () => { calls++; } }), /existing prepared runtime/);
  await rm(join(f.source, 'integrations/manifest.json'));
  await assert.rejects(prepareInstalledIntegrations({ ...f, run: async () => { calls++; } }), /ENOENT/);
  assert.equal(calls, 1);
});

for (const initial of ['not-installed', 'ready', 'failed']) {
  test(`model setup ${initial}: only verified completion counts as installed`, async t => {
    const f = await fixture(t); let state = initial, installs = 0, idle = 0;
    const ctx = { manifest: { integrations: { laya: { state: 'managed-download' } } } };
    const load = async name => name === 'builtin-integrations' ? {
      loadBuiltInContext: () => ctx,
      resolveBuiltIns: () => ({ laya: { status: { state, reason: 'model checksum mismatch' } } }),
    } : name === 'mcpstore' ? { McpStoreRegistry: class {} } : {
      installLaya: options => { installs++; assert.equal(options.onReconciled, undefined); },
      layaInstallIdle: async () => { idle++; if (initial !== 'failed') state = 'ready'; },
    };
    const run = () => prepareIntegrations({ root: f.source, home: f.plan.state, version: f.plan.version, host: f.plan, load, log() {} });
    if (initial === 'failed') await assert.rejects(run(), /model checksum mismatch/); else await run();
    assert.equal(installs, initial === 'ready' ? 0 : 1);
    assert.equal(idle, installs);
  });
}

test('preparation rejects incomplete built-ins before model or daemon activity', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareIntegrations({ root: f.source, home: f.plan.state, version: f.plan.version, host: f.plan,
    load: async name => { assert.equal(name, 'builtin-integrations'); return { loadBuiltInContext: () => ({}), resolveBuiltIns: () => ({ desktop: { status: { state: 'unavailable', reason: 'driver missing' } } }) }; }, log() {} }), /driver missing/);
});

test('real setup CLI runs through a symlinked installation path instead of silently skipping setup', { skip: process.platform === 'win32' }, async t => {
  const { symlink } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const f = await fixture(t);
  await writeFile(join(f.source, 'runtime.json'), JSON.stringify({ version: f.plan.version, platform: process.platform, arch: process.arch }));
  await writeFile(join(f.source, 'package.json'), '{"type":"module"}');
  await mkdir(join(f.source, 'packages/core/src'), { recursive: true });
  await writeFile(join(f.source, 'packages/core/src/builtin-integrations.js'), `export const loadBuiltInContext = () => ({ manifest: { integrations: { laya: { state: 'managed-download' } } } }); export const resolveBuiltIns = () => ({ laya: { status: { state: 'ready' } } });`);
  const script = await readFile(new URL('./prepare-desktop-integrations.mjs', import.meta.url), 'utf8');
  await writeFile(join(f.source, 'prepare-integrations.mjs'), script);
  const alias = join(f.dir, 'installed alias');
  await symlink(f.source, alias);
  const output = execFileSync(process.execPath, [join(alias, 'prepare-integrations.mjs'), f.plan.state, f.plan.version], { encoding: 'utf8' });
  assert.match(output, /Laya model verified and ready/);
});


test('release paths require the runtime build, smoke, signing and standalone resource configuration', async () => {
  const read = async name => (await readFile(new URL('../' + name, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const shell = await read('scripts/release-macos-app.sh');
  const native = await read('.github/workflows/desktop-package.yml');
  const contract = value => {
    const stage = value.indexOf('node scripts/build-desktop-runtime.mjs');
    const smoke = value.indexOf('node scripts/test-desktop-runtime.mjs');
    const bundle = value.indexOf('--config src-tauri/tauri.standalone.conf.json');
    assert.ok(stage >= 0 && smoke > stage && bundle > smoke, 'runtime staging and smoke must precede standalone bundling');
  };
  contract(shell); contract(native);
  assert.ok(shell.indexOf('node scripts/sign-desktop-runtime.mjs') > shell.indexOf('node scripts/test-desktop-runtime.mjs'));
  for (const source of [shell, native]) {
    for (const item of ['node scripts/build-desktop-runtime.mjs', '--config src-tauri/tauri.standalone.conf.json']) {
      const mutant = source.replace(item, 'removed');
      assert.notEqual(mutant, source);
      assert.throws(() => contract(mutant), /staging and smoke/);
    }
  }
  const config = JSON.parse(await read('packages/app/src-tauri/tauri.standalone.conf.json'));
  assert.equal(config.bundle.resources['standalone/runtime/'], 'runtime/');
  assert.match(await read('scripts/build-npm.mjs'), /'npm-install-integrations.mjs'/);
});

for (const state of ['not-installed', 'ready', 'failed', 'unsupported-platform', 'service-only']) {
  test(`standalone first open: ${state} never defers setup to a tool call`, async t => {
    const { execFileSync } = await import('node:child_process');
    const f = await fixture(t), root = join(f.dir, 'bootstrap runtime');
    await mkdir(join(root, 'node_modules/dugite/build/lib'), { recursive: true });
    await mkdir(join(root, 'packages/client/src'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(join(root, 'node_modules/dugite/build/lib/git-environment.js'), 'exports.setupEnvironment = () => ({env:process.env,gitLocation:process.execPath});');
    await writeFile(join(root, 'packages/client/src/client.js'), `
      import assert from 'node:assert/strict';
      const calls = [];
      export const ChimeraClient = { connect: async () => ({
        request: async (method, args) => {
          calls.push(method);
          if (method === 'daemon.status') return {protocolVersion:1};
          if (method === 'computerUse.builtins.status') return {integrations:[{id:'laya',state:${JSON.stringify(state)}}]};
          assert.equal(method, 'computerUse.builtins.install'); assert.deepEqual(args,{id:'laya'}); return {};
        },
        close: () => console.log(JSON.stringify(calls)),
      }) };
    `);
    await writeFile(join(root, 'bootstrap.mjs'), await readFile(new URL('./desktop-bootstrap.mjs', import.meta.url)));
    const output = execFileSync(process.execPath, [join(root, 'bootstrap.mjs'), ...(state === 'service-only' ? ['--service-only'] : [])], {encoding:'utf8'});
    const calls = JSON.parse(output.trim().split('\n').at(-1));
    assert.deepEqual(calls, ['daemon.status', ...(state === 'service-only' ? [] : ['computerUse.builtins.status']), ...(state === 'not-installed' ? ['computerUse.builtins.install'] : [])]);
  });
}
