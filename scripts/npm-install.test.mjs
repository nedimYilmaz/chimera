import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installPlan, verifyChecksum, launchAgent } from './npm-install.mjs';
import { systemdUnit, desktopEntry, cliLauncher, psCommand, windowsShortcut, verifyNativeHeader, verifyWindowsSignature } from './npm-install-platforms.mjs';
import { installPortable, snapshotFiles, restoreFiles } from './npm-install-portable.mjs';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

test('pins desktop asset and checksum to CLI version and architecture', () => {
  const plan = installPlan({ version: '1.2.3' }, { platform: 'darwin', arch: 'arm64', home: '/Users/test space' });
  assert.equal(plan.download, 'https://github.com/nedimYilmaz/chimera/releases/download/v1.2.3/chimera-desktop-1.2.3-darwin-arm64.tar.gz');
  assert.equal(plan.checksums, 'https://github.com/nedimYilmaz/chimera/releases/download/v1.2.3/SHA256SUMS');
  assert.equal(plan.app, '/Users/test space/Applications/chimera.app');
  assert.throws(() => installPlan({ version: '../latest' }), /Invalid package version/);
  assert.throws(() => installPlan({ version: '1.0.0' }, { platform: 'freebsd' }), /Unsupported/);
});

test('one release contract covers all six OS/architecture targets with native paths', () => {
  for (const platform of ['darwin', 'linux', 'win32']) for (const arch of ['arm64', 'x64']) {
    const plan = installPlan({ version: '2.3.4' }, { platform, arch, home: platform === 'win32' ? 'C:\\Users\\Ada Test' : '/home/ada', env: {} });
    assert.ok(plan.asset.startsWith(`chimera-desktop-2.3.4-${platform}-${arch}.`));
    assert.equal(plan.platform, platform);
    if (platform === 'linux') assert.equal(plan.serviceFile, '/home/ada/.config/systemd/user/chimerad.service');
    if (platform === 'win32') {
      assert.equal(plan.app, 'C:\\Users\\Ada Test\\AppData\\Local\\chimera\\desktop\\chimera.exe');
      assert.ok(plan.serviceFile.endsWith('Startup\\Chimera daemon.lnk'));
    }
  }
  assert.throws(() => installPlan({ version: '1.0.0' }, { platform: 'linux', arch: 'ia32' }), /Unsupported/);
});

test('Linux service and desktop entries escape paths without invoking a shell', () => {
  const plan = { state: '/home/a b/10%/.chimera', app: '/home/a b/$app.AppImage' };
  const unit = systemdUnit(plan, '/path/$daemon.js', '/node path/node', '/bin:10%');
  assert.ok(unit.includes('ExecStart="/node path/node" "/path/$$daemon.js"'));
  assert.ok(unit.includes('10%%'));
  assert.ok(unit.includes('Restart=on-failure'));
  const entry = desktopEntry(plan);
  assert.ok(entry.includes('--appimage-extract-and-run'));
  assert.ok(entry.includes('Terminal=false'));
  assert.ok(!entry.includes('sh -c'));
});

test('Windows launchers and PowerShell escape command metacharacters and do not change execution policy', () => {
  const launcher = cliLauncher('win32', 'C:\\Node !\\node.exe', 'C:\\50%\\app.js');
  assert.ok(launcher.includes('DisableDelayedExpansion'));
  assert.ok(launcher.includes('50%%'));
  const script = windowsShortcut("C:\\O'Neil\\app.lnk", 'C:\\App & Co\\app.exe');
  const args = psCommand(script);
  assert.ok(!args.includes('-ExecutionPolicy'));
  assert.ok(Buffer.from(args.at(-1), 'base64').toString('utf16le').includes("O''Neil"));
  assert.throws(() => verifyWindowsSignature('app.exe', null), /thumbprint/);
  assert.ok(verifyWindowsSignature('app.exe', 'a'.repeat(40)).includes('TimeStamperCertificate'));
});

test('native Windows PowerShell parses generated shortcut and signature commands', { skip: process.platform !== 'win32' }, () => {
  const samples = [windowsShortcut("C:\\O'Neil\\Chimera.lnk", 'C:\\App & Co\\chimera.exe'), verifyWindowsSignature('C:\\app.exe', 'a'.repeat(40))];
  for (const source of samples) {
    const data = Buffer.from(source).toString('base64');
    execFileSync('powershell.exe', psCommand(`$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')); $e = $null; $t = $null; $null = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$t, [ref]$e); if ($e.Count) { throw ($e | Out-String) }`));
  }
});

function nativeBytes(platform, arch = 'x64') {
  const bytes = Buffer.alloc(128);
  if (platform === 'linux') {
    Buffer.from('7f454c460201', 'hex').copy(bytes); Buffer.from('414902', 'hex').copy(bytes, 8);
    bytes.writeUInt16LE(arch === 'x64' ? 62 : 183, 18);
  } else {
    bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 68);
  }
  return bytes;
}

test('rejects wrong-architecture and malformed native downloads before executing them', () => {
  for (const platform of ['linux', 'win32']) {
    verifyNativeHeader(nativeBytes(platform), platform, 'x64');
    assert.throws(() => verifyNativeHeader(nativeBytes(platform), platform, 'arm64'), /architecture|matching/);
    assert.throws(() => verifyNativeHeader(Buffer.from('not executable'), platform, 'x64'));
  }
});

test('file rollback restores binary shortcuts and existing contents, removing new files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chimera-transaction-'));
  try {
    const old = join(dir, 'old.lnk'), fresh = join(dir, 'new');
    const bytes = Buffer.from([0, 2, 255, 4]);
    await writeFile(old, bytes);
    const snapshots = await snapshotFiles([old, fresh], dir);
    await writeFile(old, 'replacement'); await writeFile(fresh, 'new');
    await restoreFiles(snapshots);
    assert.deepEqual(await readFile(old), bytes);
    await assert.rejects(lstat(fresh), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const platform of ['linux', 'win32']) for (const fail of [false, true]) {
  test(`${platform} shared install ${fail ? 'rolls back a failed activation' : 'activates app, CLI and login startup'}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chimera-installer-test-'));
    const root = join(dir, 'root'), oldApp = join(root, 'desktop/app');
    const plan = { platform, arch: 'x64', version: '1.0.0', root, bin: join(root, 'bin'), state: join(dir, 'state'), app: oldApp,
      shortcut: join(root, 'app-shortcut'), serviceFile: join(root, 'service'), asset: `desktop.${platform}`, download: 'https://test.invalid/app', checksums: 'https://test.invalid/sums', windowsPublisherThumbprint: 'a'.repeat(40) };
    const binName = join(plan.bin, `chimera${platform === 'win32' ? '.cmd' : ''}`);
    const managed = [oldApp, plan.shortcut, plan.serviceFile, binName];
    await mkdir(join(root, 'desktop'), { recursive: true }); await mkdir(plan.bin);
    for (const file of managed) await writeFile(file, `old:${file}`);
    await writeFile(join(root, 'install.json'), JSON.stringify({ owner: 'chimera-npm', files: managed }));
    const payload = nativeBytes(platform), hash = createHash('sha256').update(payload).digest('hex');
    let running = false, failed = false;
    const calls = [];
    const run = async (cmd, args) => {
      const script = cmd === 'powershell.exe' ? Buffer.from(args.at(-1), 'base64').toString('utf16le') : '';
      calls.push({ cmd, args, script });
      if (args.includes('pack')) return { stdout: '[{"filename":"package.tgz"}]' };
      if (script.includes('$found = $false')) return { stdout: 'installed' };
      if (script.includes('ConvertTo-Json')) return { stdout: '"C:\\\\Existing"' };
      if (args.includes('is-active') || args.includes('is-enabled')) throw new Error('not running');
      if (args.includes('disable') || args.includes('stop')) running = false;
      const activating = args.includes('--now') && args.includes('enable') || args[0]?.endsWith('start-daemon.cjs');
      if (activating) { if (fail && !failed) { failed = true; throw new Error('simulated activation failure'); } running = true; }
      // Materialize the binary shortcut that PowerShell would create, inside our temporary root only.
      if (script.includes('CreateShortcut')) {
        const match = script.match(/CreateShortcut\('([^']+)'\)/);
        await writeFile(match[1], 'new shortcut');
      }
      return { stdout: '' };
    };
    const Client = { connect: async () => {
      if (!running) throw new Error('not running');
      return { request: async method => { if (method === 'daemon.stop') running = false; return { protocolVersion: 1 }; }, close() {} };
    } };
    try {
      const task = installPortable({ manifest: { name: '@test/chimera', bin: { chimera: 'cli.js', chimerad: 'daemon.js' } }, plan, args: ['--no-open'], packageRoot: dir },
        { run, procRoot: dir, npmCommand: ['test-npm', []], ChimeraClient: Client, download: async url => url.endsWith('/sums') ? Buffer.from(`${hash}  ${plan.asset}\n`) : payload });
      if (fail) {
        await assert.rejects(task, /simulated activation failure/);
        for (const file of managed) assert.equal(await readFile(file, 'utf8'), `old:${file}`);
      } else {
        await task;
        assert.deepEqual(await readFile(oldApp), payload);
        assert.equal(JSON.parse(await readFile(join(root, 'install.json'), 'utf8')).version, '1.0.0');
        assert.ok((await readFile(binName, 'utf8')).includes('Chimera npm installer'));
      }
      if (platform === 'win32') assert.ok(calls.some(c => c.script.includes('Get-AuthenticodeSignature')));
      else assert.ok(calls.some(c => c.args.includes('--appimage-version')));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('rejects corrupt, missing and duplicated checksums before extraction', () => {
  const bytes = Buffer.from('release payload');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const entry = `${hash}  desktop.tar.gz`;
  verifyChecksum(bytes, `${entry}\n`, 'desktop.tar.gz');
  assert.throws(() => verifyChecksum(Buffer.from('corrupt'), entry, 'desktop.tar.gz'), /mismatch/);
  assert.throws(() => verifyChecksum(bytes, entry, 'other.tar.gz'), /Missing/);
  assert.throws(() => verifyChecksum(bytes, `${entry}\n${entry}`, 'desktop.tar.gz'), /ambiguous/);
});

test('launchd arguments escape XML and retain absolute Node and daemon locations', () => {
  const plan = { state: '/Users/A & B/.chimera' };
  const plist = launchAgent(plan, '/stable/daemon.js', '/node with space/node', '/A&B/bin');
  assert.ok(plist.includes('<string>/node with space/node</string><string>/stable/daemon.js</string>'));
  assert.ok(plist.includes('/Users/A &amp; B/.chimera'));
  assert.ok(plist.includes('/A&amp;B/bin'));
  assert.ok(!plist.includes('CHIMERA_BACKEND'));
});
