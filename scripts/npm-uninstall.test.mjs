import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';
import { daemonEndpoint } from '../packages/core/src/paths.ts';
import { uninstall, uninstallPlan } from './npm-uninstall.mjs';
import { cliLauncher, systemdUnit, desktopEntry, psCommand, psQuote } from './npm-install-platforms.mjs';

const manifest = { name: '@nedimyilmaz/chimera', version: '0.1.1', bin: { chimera: 'packages/client/bin/chimera.js', chimerad: 'packages/daemon/bin/chimerad.js', 'chimera-mcp': 'packages/mcp/bin/chimera-mcp.js' } };
const missing = path => Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' });
class FixtureFS {
  constructor(p) { this.p = p; this.entries = new Map(); this.removed = []; }
  set(path, value = '', kind = 'file') {
    this.entries.set(path, { value, kind });
    for (let parent = this.p.dirname(path); parent !== this.p.dirname(parent); parent = this.p.dirname(parent)) if (!this.entries.has(parent)) this.entries.set(parent, { kind: 'dir' });
  }
  mkdir(path) { this.set(path, '', 'dir'); }
  async lstat(path) { const e = this.entries.get(path); if (!e) throw missing(path); return { dev: e.dev ?? 1, uid: e.uid ?? 501, isSymbolicLink: () => e.kind === 'link', isDirectory: () => e.kind === 'dir', isFile: () => e.kind === 'file' }; }
  async readFile(path) { const e = this.entries.get(path); if (!e) throw missing(path); return e.value; }
  async readdir(path, options) {
    if (!this.entries.has(path)) throw missing(path);
    const rows = [...this.entries].filter(([name]) => this.p.dirname(name) === path && name !== path);
    return options?.withFileTypes ? rows.map(([name, e]) => ({ name: this.p.basename(name), isDirectory: () => e.kind === 'dir', isSymbolicLink: () => e.kind === 'link' })) : rows.map(([name]) => this.p.basename(name));
  }
  async rm(path) { this.removed.push(path); for (const name of [...this.entries.keys()]) if (name === path || name.startsWith(path + this.p.sep)) this.entries.delete(name); }
  async unlink(path) { assert.equal(this.entries.get(path)?.kind, 'link'); this.removed.push(path); this.entries.delete(path); }
  async rmdir(path) { assert.equal((await this.readdir(path)).length, 0); await this.rm(path); }
}

function fixture(platform = 'linux', custom = false, overrides = {}) {
  const p = platform === 'win32' ? win32 : posix, home = platform === 'win32' ? 'C:\\Users\\Fixture' : '/fixture/user';
  const env = { ...overrides, ...(custom ? { CHIMERA_HOME: p.join(home, 'custom-chimera') } : {}) };
  const plan = uninstallPlan(manifest, { platform, arch: 'x64', home, env });
  const io = new FixtureFS(p), calls = [], messages = [], credentials = new Map(), active = new Set([plan.defaultState, plan.state]);
  const release = p.join(plan.root, 'releases', '0.1.1-fixture'), pkg = p.join(release, 'node_modules', manifest.name), node = platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/local/bin/node';
  io.set(p.join(pkg, 'package.json'), JSON.stringify(manifest));
  for (const [name, target] of Object.entries(manifest.bin)) io.set(p.join(plan.bin, name + (platform === 'win32' ? '.cmd' : '')), cliLauncher(platform, node, p.join(pkg, target)));
  const service = plan.plist ?? plan.serviceFile;
  if (platform === 'darwin') {
    io.set(service, JSON.stringify({ Label: 'com.chimera.chimerad', 'ProgramArguments:1': p.join(pkg, manifest.bin.chimerad), 'EnvironmentVariables:CHIMERA_HOME': plan.defaultState }));
    io.set(p.join(plan.app, 'Contents/Info.plist'), JSON.stringify({ CFBundleIdentifier: 'dev.chimera.desktop' }));
  } else if (platform === 'linux') {
    io.set(plan.app, 'owned app'); io.set(service, systemdUnit({ ...plan, state: plan.defaultState }, p.join(pkg, manifest.bin.chimerad), node, '/fixture/path'));
    io.set(plan.shortcut, desktopEntry(plan)); io.mkdir('/proc');
  } else {
    io.set(plan.app, 'owned app');
    io.set(plan.shortcut, JSON.stringify({ target: plan.app, args: '', description: 'Chimera npm installer' }));
    io.set(service, JSON.stringify({ target: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: `-WindowStyle Hidden ${psCommand(`& ${psQuote(node)} ${psQuote(p.join(release, 'start-daemon.cjs'))}`).join(' ')}`, description: 'Chimera npm installer' }));
  }
  if (platform !== 'darwin') io.set(plan.receipt, JSON.stringify({ owner: 'chimera-npm', platform, files: [plan.app, plan.shortcut, service, ...plan.binPaths, plan.receipt] }));
  io.set(p.join(plan.state, 'config.json'), JSON.stringify({ accounts: [{ name: 'main', auth: { type: 'keychain', service: 'chimera:main' } }] }));
  io.set(p.join(plan.state, 'projects', 'managed', '.git', 'HEAD'), 'managed project');
  io.set(p.join(home, 'external-repo', '.git', 'HEAD'), 'external project');
  io.set(p.join(plan.cache, 'images', 'image.png'), 'shared app image');
  if (custom) io.set(p.join(plan.defaultState, 'config.json'), JSON.stringify({ accounts: [{ name: 'main', auth: { type: 'keychain', service: 'chimera:main' } }] }));
  credentials.set('chimera:main', 'chimera'); credentials.set('chimera:tailscale-authkey', 'chimera');
  const prefix = p.join(home, 'global'), globalRoot = p.join(prefix, ...(platform === 'win32' ? [] : ['lib']), 'node_modules'), globalDir = p.join(globalRoot, manifest.name);
  const faults = {};
  const run = async (cmd, args) => {
    const source = cmd === 'powershell.exe' ? Buffer.from(args.at(-1), 'base64').toString('utf16le') : '';
    calls.push({ cmd, args, source });
    if (args.includes('prefix')) return { stdout: prefix };
    if (args.includes('cache')) return { stdout: p.join(home, '.npm') };
    if (args.includes('root')) return { stdout: faults.foreignPrefix ? '/foreign/global' : globalRoot };
    if (args.includes('uninstall')) { if (faults.globalRemove) throw new Error('npm removal rejected'); await io.rm(globalDir); }
    if (cmd === '/usr/libexec/PlistBuddy') return { stdout: JSON.parse(await io.readFile(args.at(-1)))[args[1].slice('Print :'.length)] ?? '' };
    if (cmd === '/usr/bin/osascript') return { stdout: faults.desktop ? 'true' : 'false' };
    if (cmd === '/usr/bin/security') {
      const service = args[args.indexOf('-s') + 1];
      assert.ok(!args.includes('-w') && !args.includes('-g'), 'must never read secret values');
      if (!credentials.has(service)) throw Object.assign(new Error('missing'), { code: 44 });
      if (args[0] === 'find-generic-password') return { stdout: `"acct"<blob>="${credentials.get(service)}"\n"svce"<blob>="${service}"` };
      if (faults.credentialRemove) throw new Error('credential delete rejected');
      credentials.delete(service);
    }
    if (source.includes('GetFiles')) return { stdout: JSON.stringify(faults.unreachable ?? false) };
    if (source.includes('GetFolderPath')) return { stdout: JSON.stringify(p.join(home, 'AppData/Local')) };
    if (source.includes('Get-Item')) {
      const path = source.match(/-LiteralPath '((?:[^']|'')*)'/)[1].replaceAll("''", "'");
      assert.ok(!source.includes('-Recurse'));
      assert.ok(source.indexOf('ReparsePoint))') < source.indexOf('Get-ChildItem'), 'reparse check precedes enumeration');
      const rows = [...io.entries].filter(([name, entry]) => entry.kind === 'link' && (name === path || name.startsWith(path + p.sep))).map(([name]) => ({ path: name, linkType: faults.linkType ?? 'Unknown' }));
      return { stdout: JSON.stringify(rows) };
    }
    if (source.includes('CreateShortcut')) {
      const name = source.match(/CreateShortcut\('((?:[^']|'')*)'\)/)[1].replaceAll("''", "'");
      return { stdout: await io.readFile(name) };
    }
    if (source.includes('Get-Process') && faults.desktop) throw new Error('app running');
    if (args.includes('disable') || args.includes('bootout')) {
      if (faults.serviceStop) throw new Error('stop failed');
      active.delete(plan.defaultState);
    }
    if (args.includes('print') && !active.has(plan.defaultState)) throw Object.assign(new Error('not loaded'), { stderr: 'Could not find service' });
    return { stdout: '' };
  };
  const Client = { connect: async ({ home, autostart }) => {
    assert.equal(autostart, false);
    if (!active.has(home) || faults.unreachable) throw new Error('not reachable');
    return { request: async method => {
      if (method === 'daemon.status') return { protocolVersion: 1, codeRoot: faults.codeRoot ?? (faults.foreignDaemon ? p.join(home, 'foreign/src') : p.join(pkg, 'packages/daemon/src')) };
      if (faults.daemonStop) throw new Error('daemon stop failed');
      if (!faults.stubborn) active.delete(home);
      return {};
    }, close() {} };
  } };
  const hooks = { manifest, context: { platform, arch: 'x64', home, env }, fs: io, run, log: value => messages.push(value), ChimeraClient: Client, processAlive: async () => false, uid: () => 501, daemonEndpoint, isTTY: () => true, confirm: async text => { messages.push(text); return plan.state; }, pause: async () => {}, npmCommand: ['fixture-npm', []] };
  return { plan, io, hooks, calls, messages, credentials, faults, active, pkg, globalDir, p, home };
}

for (const platform of ['darwin', 'linux', 'win32']) for (const arch of ['x64', 'arm64']) test(`${platform}/${arch} enumerates fixed install, selected home and proven Tauri cache`, () => {
  const home = platform === 'win32' ? 'C:\\Users\\Fixture' : '/fixture/user';
  const p = platform === 'win32' ? win32 : posix;
  const plan = uninstallPlan(manifest, { platform, arch, home, env: { CHIMERA_HOME: p.join(home, 'custom') } });
  assert.equal(plan.state, p.join(home, 'custom')); assert.deepEqual(plan.preservedHomes, [p.join(home, '.chimera')]);
  assert.ok(plan.cache.endsWith('dev.chimera.desktop'));
});

for (const platform of ['darwin', 'linux', 'win32']) test(`${platform}: normal uninstall removes only owned installation and is idempotent`, async () => {
  const f = fixture(platform); await uninstall([], f.hooks);
  assert.ok(!f.io.entries.has(f.plan.app)); assert.ok(!f.io.entries.has(f.plan.root));
  assert.ok(f.io.entries.has(f.p.join(f.plan.state, 'config.json')));
  assert.ok(f.io.entries.has(f.p.join(f.plan.cache, 'images/image.png')));
  assert.equal(f.credentials.size, 2);
  assert.ok(!f.calls.some(c => c.args[0] === 'delete-generic-password'));
  await uninstall([], f.hooks);
});

test('dry-run with purge performs zero commands/stops/writes and reports both homes', async () => {
  const f = fixture('darwin', true); await uninstall(['--purge-data', '--dry-run'], f.hooks);
  assert.equal(f.calls.length, 0); assert.equal(f.io.removed.length, 0); assert.equal(f.credentials.size, 2);
  const plan = JSON.parse(f.messages[0]); assert.equal(plan.state, f.plan.state); assert.equal(plan.defaultState, f.plan.defaultState);
  assert.match(plan.npxCache, /preserved/);
});

test('selected custom purge preserves default-home shared credentials and external projects', async () => {
  const f = fixture('darwin', true);
  f.io.set(f.p.join(f.plan.state, 'config.d/ui.json'), JSON.stringify({ accounts: [{ name: 'private', auth: { type: 'oauth', tokenRef: 'chimera-oauth:private' } }] }));
  f.io.set(f.p.join(f.plan.state, 'secrets.json'), JSON.stringify({ secrets: [{ name: 'production/key' }] }));
  f.io.set(f.p.join(f.plan.state, 'mcpstore.json'), JSON.stringify({ browser: { type: 'http', auth: { kind: 'bearer', keychainRef: 'chimera:mcp:browser' } } }));
  for (const name of ['chimera-oauth:private', 'chimera:secret:production/key', 'chimera:mcp:browser']) f.credentials.set(name, 'chimera');
  await uninstall(['--purge-data'], f.hooks);
  assert.ok(!f.io.entries.has(f.plan.state)); assert.ok(!f.io.entries.has(f.plan.cache));
  assert.ok(f.io.entries.has(f.p.join(f.plan.defaultState, 'config.json')));
  assert.ok(f.io.entries.has(f.p.join(f.home, 'external-repo/.git/HEAD')));
  assert.deepEqual([...f.credentials.keys()], ['chimera:main', 'chimera:tailscale-authkey']);
  assert.match(f.messages[0], new RegExp(f.plan.defaultState)); assert.match(f.messages.at(-1), /Other homes preserved/);
  assert.ok(f.messages[0].includes(f.p.join(f.plan.state, 'projects')));
});

for (const reason of ['serviceStop', 'daemonStop', 'stubborn', 'desktop', 'foreignDaemon']) test(`failed ${reason} leaves payload and data intact`, async () => {
  const f = fixture(reason === 'serviceStop' ? 'linux' : 'win32'); f.faults[reason] = true;
  await assert.rejects(uninstall(['--purge-data'], f.hooks));
  assert.equal(f.io.removed.length, 0); assert.ok(f.io.entries.has(f.plan.app)); assert.ok(f.io.entries.has(f.p.join(f.plan.state, 'config.json')));
});

for (const defect of ['receipt', 'receipt-path', 'launcher', 'fake-exec-comment', 'desktop-entry', 'state-link', 'data-link', 'repository', 'foreign-reference', 'malformed-reference', 'foreign-owner', 'foreign-prefix']) test(`rejects ${defect} before stops/removal`, async () => {
  const f = fixture(defect === 'foreign-owner' ? 'darwin' : defect === 'data-link' ? 'win32' : 'linux');
  if (defect === 'receipt') f.io.set(f.plan.receipt, JSON.stringify({ owner: 'foreign', platform: 'linux', files: [f.plan.app] }));
  if (defect === 'receipt-path') f.io.set(f.plan.receipt, JSON.stringify({ owner: 'chimera-npm', platform: 'linux', files: ['/external/repo'] }));
  if (defect === 'launcher') f.io.set(f.plan.binPaths[0], 'foreign launcher');
  if (defect === 'fake-exec-comment') f.io.set(f.plan.binPaths[0], `#!/bin/sh\n# Chimera npm installer\n# ${f.pkg}/packages/client/bin/chimera.js\nexec /foreign/command\n`);
  if (defect === 'desktop-entry') f.io.set(f.plan.shortcut, '# Chimera npm installer\nExec=/foreign/app\n');
  if (defect === 'state-link') f.io.set(f.plan.state, '/foreign', 'link');
  if (defect === 'data-link') f.io.set(f.p.join(f.plan.state, 'projects/foreign'), '/external', 'link');
  if (defect === 'repository') f.io.set(f.p.join(f.plan.state, '.git/HEAD'), 'external checkout');
  if (defect === 'foreign-reference') f.io.set(f.p.join(f.plan.state, 'config.json'), JSON.stringify({ accounts: [{ name: 'main', auth: { type: 'keychain', service: 'provider:main' } }] }));
  if (defect === 'malformed-reference') f.io.set(f.p.join(f.plan.state, 'secrets.json'), JSON.stringify({ secrets: [{ name: '../foreign' }] }));
  if (defect === 'foreign-owner') f.credentials.set('chimera:main', 'another-app');
  if (defect === 'foreign-prefix') f.faults.foreignPrefix = true;
  await assert.rejects(uninstall(['--purge-data'], f.hooks)); assert.equal(f.io.removed.length, 0);
  assert.ok(!f.calls.some(c => c.args.includes('bootout') || c.args.includes('disable') || c.args[0] === 'delete-generic-password'));
});

for (const selected of ['/', '/fixture/user', '/fixture', 'relative/home']) test(`rejects unsafe selected home ${selected}`, () => {
  assert.throws(() => uninstallPlan(manifest, { platform: 'linux', arch: 'x64', home: '/fixture/user', env: { CHIMERA_HOME: selected } }));
});

test('interactive exact-path confirmation has no bypass and occurs before stop', async () => {
  for (const mode of ['noninteractive', 'wrong-path']) {
    const f = fixture('darwin'); if (mode === 'noninteractive') f.hooks.isTTY = () => false; else f.hooks.confirm = async () => 'yes';
    await assert.rejects(uninstall(['--purge-data'], f.hooks)); assert.equal(f.io.removed.length, 0); assert.equal(f.active.size, 1);
  }
});

test('exact global npm package/prefix is removed; package mismatch cannot authorize removal', async () => {
  const f = fixture('linux'); f.io.set(f.p.join(f.globalDir, 'package.json'), JSON.stringify(manifest));
  await uninstall([], f.hooks);
  const command = f.calls.find(c => c.args.includes('uninstall'));
  assert.deepEqual(command.args, ['uninstall', '--global', '--prefix', f.p.join(f.home, 'global'), '--ignore-scripts', '--no-audit', '--no-fund', manifest.name]);
  const bad = fixture('linux'); bad.io.set(bad.p.join(bad.globalDir, 'package.json'), JSON.stringify({ ...manifest, name: '@foreign/owner' }));
  await assert.rejects(uninstall([], bad.hooks), /Foreign global/); assert.equal(bad.io.removed.length, 0);
});

test('failed global or credential removal never proceeds to data purge', async () => {
  for (const reason of ['globalRemove', 'credentialRemove']) {
    const f = fixture('darwin'); f.faults[reason] = true;
    const link = f.p.join(f.plan.state, 'projects/managed/node_modules/dependency'); f.io.set(link, '/external/dependency', 'link');
    if (reason === 'globalRemove') f.io.set(f.p.join(f.globalDir, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(uninstall(['--purge-data'], f.hooks));
    assert.ok(f.io.entries.has(f.p.join(f.plan.state, 'config.json'))); assert.ok(f.io.entries.has(f.plan.cache));
    assert.ok(f.io.entries.has(link));
  }
});

test('verified npx-cache daemon can stop, while its npm-owned payload remains', async () => {
  const f = fixture('linux');
  const pkg = f.p.join(f.home, '.npm/_npx/fixture/node_modules/@nedimyilmaz/chimera');
  f.io.set(f.p.join(pkg, 'package.json'), JSON.stringify(manifest));
  f.faults.codeRoot = f.p.join(pkg, 'packages/daemon/src');
  await uninstall([], f.hooks);
  assert.ok(f.io.entries.has(f.p.join(pkg, 'package.json')));
  assert.equal(f.active.size, 0);
  const bad = fixture('linux'); bad.faults.codeRoot = bad.p.join(bad.home, '.npm/_npx/fixture/node_modules/@foreign/provider/packages/daemon/src');
  await assert.rejects(uninstall([], bad.hooks), /Unmanaged daemon/); assert.equal(bad.io.removed.length, 0);
});

test('cross-platform purge explicitly reports unsupported credential adapters instead of claiming erasure', async () => {
  const f = fixture('linux'); await uninstall(['--purge-data'], f.hooks);
  assert.equal(f.credentials.size, 2); assert.match(f.messages[0], /without a supported local ownership adapter/);
  assert.match(f.messages.at(-1), /Unsupported credential records retained/);
});

for (const defect of ['mcp-ref', 'overlay-link', 'linked-global', 'symlink-npx']) test(`rejects ${defect} without deletion or credential changes`, async () => {
  const f = fixture('darwin');
  if (defect === 'mcp-ref') f.io.set(f.p.join(f.plan.state, 'mcpstore.json'), JSON.stringify({ browser: { type: 'http', auth: { keychainRef: 'foreign:browser' } } }));
  if (defect === 'overlay-link') f.io.set(f.p.join(f.plan.state, 'config.d'), '/foreign', 'link');
  if (defect === 'linked-global') f.io.set(f.globalDir, '/external', 'link');
  if (defect === 'symlink-npx') {
    const pkg = f.p.join(f.home, '.npm/_npx/fixture/node_modules/@nedimyilmaz/chimera');
    f.io.set(pkg, '/external', 'link'); f.faults.codeRoot = f.p.join(pkg, 'packages/daemon/src');
  }
  await assert.rejects(uninstall(['--purge-data'], f.hooks)); assert.equal(f.io.removed.length, 0); assert.equal(f.credentials.size, 2);
});

test('Windows native known-folder cache is independent from installer LOCALAPPDATA override', async () => {
  const f = fixture('win32', false, { LOCALAPPDATA: 'C:\\OtherAppData' });
  assert.equal(f.plan.cache, 'C:\\OtherAppData\\dev.chimera.desktop');
  const native = f.p.join(f.home, 'AppData/Local/dev.chimera.desktop');
  f.io.set(f.p.join(native, 'images/image.png'), 'native cache');
  await uninstall(['--purge-data'], f.hooks);
  assert.match(f.messages[0], /AppData\\Local\\dev\.chimera\.desktop/);
  assert.ok(!f.io.entries.has(native)); assert.ok(f.io.entries.has(f.plan.cache));
});

test('unreachable live Windows pipe cannot count as a stopped daemon', async () => {
  const f = fixture('win32'); f.faults.unreachable = true;
  await assert.rejects(uninstall(['--purge-data'], f.hooks), /named-pipe daemon stopped/);
  assert.equal(f.io.removed.length, 0);
  const query = f.calls.find(c => c.source.includes('GetFiles'));
  assert.ok(query.source.includes(daemonEndpoint(f.plan.state, 'win32')));
});

test('Linux checks only same-user desktop provenance and rejects a running owned AppImage', async () => {
  const foreign = fixture('linux'); foreign.io.mkdir('/proc/10'); foreign.io.entries.get('/proc/10').uid = 0;
  const read = foreign.io.readFile.bind(foreign.io);
  foreign.io.readFile = async path => { if (path === '/proc/10/environ') throw new Error('foreign process must not be inspected'); return read(path); };
  await uninstall([], foreign.hooks);
  const own = fixture('linux'); own.io.set('/proc/11/environ', `APPIMAGE=${own.plan.app}\0`);
  await assert.rejects(uninstall([], own.hooks), /Close the installed Chimera desktop/);
  assert.equal(own.io.removed.length, 0);
  const inaccessible = fixture('linux'); inaccessible.io.mkdir('/proc/12');
  const baseRead = inaccessible.io.readFile.bind(inaccessible.io);
  inaccessible.io.readFile = async path => { if (path === '/proc/12/environ') throw Object.assign(new Error('denied'), { code: 'EACCES' }); return baseRead(path); };
  await assert.rejects(uninstall([], inaccessible.hooks), /Cannot establish desktop process ownership/);
  assert.equal(inaccessible.io.removed.length, 0);
});

test('a newly shared preserved-home credential is retained after stop', async () => {
  const f = fixture('darwin', true);
  f.io.set(f.p.join(f.plan.state, 'config.json'), JSON.stringify({ accounts: [{ name: 'private', auth: { type: 'keychain', service: 'chimera:private' } }] }));
  f.credentials.set('chimera:private', 'chimera');
  const connect = f.hooks.ChimeraClient.connect;
  f.hooks.ChimeraClient = { connect: async options => {
    const client = await connect(options), request = client.request;
    client.request = async method => {
      const result = await request(method);
      if (method === 'daemon.stop') f.io.set(f.p.join(f.plan.defaultState, 'config.json'), JSON.stringify({ accounts: [{ name: 'private', auth: { type: 'keychain', service: 'chimera:private' } }] }));
      return result;
    }; return client;
  } };
  await uninstall(['--purge-data'], f.hooks);
  assert.ok(f.credentials.has('chimera:private'));
  assert.match(f.messages.at(-1), /Shared credentials retained: chimera:private/);
});

test('real filesystem symlink purge guard preserves the external target', async () => {
  const fs = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const dir = await fs.mkdtemp(join(tmpdir(), 'chimera-uninstall-symlink-'));
  try {
    const home = join(dir, 'home'), external = join(dir, 'external');
    await fs.mkdir(home); await fs.mkdir(external); await fs.writeFile(join(external, 'keep.txt'), 'retained');
    await fs.symlink(external, join(home, '.chimera'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(uninstall(['--purge-data', '--dry-run'], { manifest, context: { platform: process.platform, arch: process.arch, home, env: {} }, run: () => { throw new Error('must not run a command'); } }), /symlink\/reparse/);
    assert.equal(await fs.readFile(join(external, 'keep.txt'), 'utf8'), 'retained');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

for (const selected of ['/fixture/user/.chimera/custom', '/fixture/user/.chimera/../']) test(`rejects selected/preserved-home overlap: ${selected}`, () => {
  assert.throws(() => uninstallPlan(manifest, { platform: 'linux', arch: 'x64', home: '/fixture/user', env: { CHIMERA_HOME: selected } }));
});

for (const mode of ['delayed-exit', 'never-exit', 'changed-pid']) test(`verified service shutdown ${mode} retains bounded process identity`, async () => {
  const f = fixture('linux'); let pauses = 0;
  const pidFile = f.p.join(f.plan.defaultState, 'daemon.pid'); f.io.set(pidFile, '7331');
  const run = f.hooks.run;
  f.hooks.run = async (cmd, args) => { const result = await run(cmd, args); if (mode === 'changed-pid' && args.includes('disable')) f.io.set(pidFile, '7332'); return result; };
  f.hooks.processAlive = async pid => { assert.equal(pid, 7331); return mode === 'never-exit' || pauses < 2; };
  f.hooks.pause = async () => { pauses++; };
  if (mode === 'delayed-exit') { await uninstall(['--purge-data'], f.hooks); assert.equal(pauses, 2); assert.ok(!f.io.entries.has(f.plan.state)); }
  else { await assert.rejects(uninstall(['--purge-data'], f.hooks), mode === 'never-exit' ? /did not stop/ : /identity changed/); assert.equal(f.io.removed.length, 0); assert.ok(f.io.entries.has(f.plan.app)); }
});

test('post-confirmation repository replacement is rejected before any removal', async () => {
  const f = fixture('darwin');
  f.hooks.confirm = async () => { f.io.set(f.p.join(f.plan.state, '.git/HEAD'), 'replaced repository'); return f.plan.state; };
  await assert.rejects(uninstall(['--purge-data'], f.hooks), /Refusing to purge a repository/);
  assert.equal(f.io.removed.length, 0); assert.equal(f.credentials.size, 2);
});

for (const replacement of ['symlink', 'mount']) test(`post-confirmation ${replacement} replacement is rejected without removal`, async () => {
  const f = fixture('darwin');
  f.hooks.confirm = async () => {
    if (replacement === 'symlink') f.io.set(f.plan.state, '/external/repo', 'link');
    else f.io.entries.get(f.p.join(f.plan.state, 'projects')).dev = 2;
    return f.plan.state;
  };
  await assert.rejects(uninstall(['--purge-data'], f.hooks), replacement === 'symlink' ? /symlink\/reparse/ : /cross-device/);
  assert.equal(f.io.removed.length, 0); assert.equal(f.credentials.size, 2);
});

test('managed dependency symlinks are unlinked without traversing their destination', { skip: process.platform === 'win32' }, async () => {
  const fs = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const dir = await fs.mkdtemp(join(tmpdir(), 'chimera-uninstall-nested-link-'));
  try {
    const home = join(dir, 'home'), state = join(home, '.chimera'), deps = join(state, 'projects/managed/node_modules'), external = join(dir, 'external-dependency');
    await fs.mkdir(deps, { recursive: true }); await fs.mkdir(external); await fs.writeFile(join(external, 'keep.txt'), 'external retained');
    await fs.symlink(external, join(deps, 'dependency'), 'dir');
    const hooks = { manifest, fs, context: { platform: 'darwin', arch: 'x64', home, env: {} }, uid: () => 501, isTTY: () => true, confirm: async () => state, log() {},
      ChimeraClient: { connect: async () => { throw new Error('absent'); } },
      run: async (cmd, args) => {
        if (cmd === '/usr/bin/security') throw Object.assign(new Error('missing'), { code: 44 });
        if (args.includes('prefix')) return { stdout: join(home, 'global') }; if (args.includes('root')) return { stdout: join(home, 'global/lib/node_modules') };
        if (args.includes('cache')) return { stdout: join(home, '.npm') }; if (cmd === '/usr/bin/osascript') return { stdout: 'false' };
        throw new Error('unexpected command');
      } };
    await uninstall(['--purge-data'], hooks);
    await assert.rejects(fs.lstat(state), { code: 'ENOENT' });
    assert.equal(await fs.readFile(join(external, 'keep.txt'), 'utf8'), 'external retained');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

for (const linkType of ['SymbolicLink', 'Junction']) test(`Windows classifies known nested ${linkType} for unlink only`, async () => {
  const f = fixture('win32'); f.faults.linkType = linkType;
  const external = f.p.join(f.home, 'external-dependency/keep.txt'), link = f.p.join(f.plan.state, 'projects/managed/node_modules/dependency');
  f.io.set(external, 'retained'); f.io.set(link, f.p.dirname(external), 'link');
  await uninstall(['--purge-data'], f.hooks);
  assert.ok(f.io.removed.includes(link)); assert.ok(f.io.entries.has(external));
});

test('Windows reparse process count is independent of ordinary file count', async () => {
  for (const count of [0, 3000]) {
    const f = fixture('win32');
    for (let index = 0; index < count; index++) f.io.set(f.p.join(f.plan.state, `logs/log-${index}.jsonl`), 'ordinary file');
    await uninstall(['--purge-data'], f.hooks);
    assert.equal(f.calls.filter(call => call.source.includes('Get-Item')).length, 6, 'one process per tree per three checks');
  }
});
