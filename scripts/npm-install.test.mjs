import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installPlan, verifyChecksum, launchAgent, quitMacDesktop, installMac } from './npm-install.mjs';
import { systemdUnit, desktopEntry, cliLauncher, psCommand, windowsShortcut, verifyNativeHeader, verifyWindowsSignature } from './npm-install-platforms.mjs';
import { installPortable, snapshotFiles, restoreFiles } from './npm-install-portable.mjs';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

function macQuery(source, identifiers) {
  return runInNewContext(source, {
    ObjC: { import() {}, unwrap: value => value },
    $: { NSWorkspace: { sharedWorkspace: { runningApplications: {
      count: identifiers.length, objectAtIndex: i => ({ bundleIdentifier: identifiers[i] }),
    } } } },
  });
}

for (const identifiers of [[], ['other.chimera.desktop', null], ['dev.chimera.desktop.helper']]) {
  test(`macOS skips graceful quit for absent/not-running exact bundle: ${JSON.stringify(identifiers)}`, async () => {
    let queries = 0;
    await quitMacDesktop(async (cmd, args) => {
      assert.equal(cmd, '/usr/bin/osascript');
      assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e']);
      queries++;
      return { stdout: String(macQuery(args[3], identifiers)) };
    });
    assert.equal(queries, 1);
  });
}

test('macOS quits the exact running bundle gracefully and waits for exit', async () => {
  let running = true, quits = 0, queries = 0, pauses = 0;
  await quitMacDesktop(async (cmd, args, options) => {
    assert.equal(cmd, '/usr/bin/osascript');
    assert.ok(options.timeout > 0 && options.timeout <= 15_000);
    if (args[0] === '-l') {
      queries++;
      return { stdout: String(macQuery(args[3], running ? ['dev.chimera.desktop'] : [])) };
    }
    assert.deepEqual(args, ['-e', 'set bundleID to "dev.chimera.desktop"\nif application id bundleID is running then\n tell application id bundleID to quit\nend if']);
    quits++;
    return { stdout: '' };
  }, async () => { pauses++; running = false; });
  assert.equal(quits, 1); assert.equal(queries, 3); assert.equal(pauses, 1);
});

test('macOS preserves detection, permission and quit failures', async () => {
  for (const phase of ['detection', 'quit', 'after-quit']) {
    const failure = new Error(`${phase}: permission denied (-1743)`);
    let queries = 0;
    await assert.rejects(quitMacDesktop(async (_cmd, args) => {
      if (args[0] === '-l') {
        queries++;
        if (phase === 'detection' || phase === 'after-quit' && queries > 1) throw failure;
        return { stdout: 'true' };
      }
      if (phase === 'quit') throw failure;
      return { stdout: '' };
    }), error => error === failure);
  }
  await assert.rejects(quitMacDesktop(async () => ({ stdout: '' })), /Could not determine/);
  let time = 0;
  await assert.rejects(quitMacDesktop(async () => ({ stdout: 'true' }), async ms => { time += ms; }, () => time), /did not quit/);
  assert.equal(time, 10_000);
});

test('macOS slow positive exit queries share one deadline rather than extending the budget', async () => {
  let time = 0, queries = 0;
  const timeouts = [], pauses = [];
  await assert.rejects(quitMacDesktop(async (_cmd, args, { timeout }) => {
    if (args[0] !== '-l') { assert.equal(timeout, 15_000); return { stdout: '' }; }
    timeouts.push(timeout);
    queries++;
    if (queries === 2) time += 6000;
    if (queries === 3) time += 3800;
    assert.ok(queries <= 3, 'deadline must prevent another query');
    return { stdout: 'true' };
  }, async ms => { pauses.push(ms); time += ms; }, () => time), /did not quit/);
  assert.deepEqual(timeouts, [15_000, 10_000, 3900]);
  assert.deepEqual(pauses, [100, 100]);
  assert.equal(time, 10_000);
});

test('macOS stubborn app caps the last pause and preserves a timed-out query error', async () => {
  let time = 0, queries = 0;
  const pauses = [];
  await assert.rejects(quitMacDesktop(async (_cmd, args, { timeout }) => {
    if (args[0] === '-l' && ++queries > 1) {
      assert.equal(timeout, 10_000 - time);
      time += 30;
    }
    return { stdout: 'true' };
  }, async ms => { pauses.push(ms); time += ms; }, () => time), /did not quit/);
  assert.equal(time, 10_000);
  assert.equal(pauses.at(-1), 90);
  const failure = new Error('query subprocess timed out');
  time = 0; queries = 0;
  await assert.rejects(quitMacDesktop(async (_cmd, args, { timeout }) => {
    if (args[0] === '-l' && ++queries > 1) {
      assert.equal(timeout, 10_000);
      time += timeout;
      throw failure;
    }
    return { stdout: 'true' };
  }, async ms => { time += ms; }, () => time), error => error === failure);
  assert.equal(time, 10_000); assert.equal(queries, 2);
});

test('native macOS compilation reproduces old first-install failure without targeting Chimera', { skip: process.platform !== 'darwin' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chimera-compile-test-'));
  const missing = `dev.chimera.installer-test.missing-${process.pid}`;
  try {
    const old = spawnSync('/usr/bin/osacompile', ['-o', join(dir, 'old.scpt'), '-e', `if application id "${missing}" is running then\n tell application id "${missing}" to quit\nend if`], { encoding: 'utf8' });
    assert.notEqual(old.status, 0); assert.match(old.stderr, /-1728/);
    execFileSync('/usr/bin/osacompile', ['-o', join(dir, 'new.scpt'), '-e', `set bundleID to "${missing}"\nif application id bundleID is running then\n tell application id bundleID to quit\nend if`]);
    await quitMacDesktop(async (cmd, args) => {
      assert.equal(args[0], '-l'); // Never execute any quit command against a live app.
      return { stdout: execFileSync(cmd, [...args.slice(0, 3), args[3].replaceAll('dev.chimera.desktop', missing)], { encoding: 'utf8' }) };
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const scenario of ['fresh', 'closed', 'running', 'detection-error', 'quit-error', 'activation-error']) {
  test(`macOS offline installation transaction: ${scenario}`, async t => {
    // The mocked macOS transaction needs a UID even when this suite runs on Windows.
    const uid = Object.getOwnPropertyDescriptor(process, 'getuid');
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => 501 });
    t.after(() => { if (uid) Object.defineProperty(process, 'getuid', uid); else delete process.getuid; });
    const dir = await mkdtemp(join(tmpdir(), 'chimera-mac-install-test-'));
    const plan = installPlan({ version: '1.0.0' }, { platform: 'darwin', arch: 'arm64', home: dir });
    const manifest = { name: '@test/chimera', version: plan.version, bin: { chimera: 'cli.js', chimerad: 'daemon.js' } };
    const bin = join(plan.bin, 'chimera'), oldPlist = 'com.chimera.chimerad old chimerad';
    const existing = scenario !== 'fresh', failure = scenario.endsWith('error');
    const payload = Buffer.from('offline signed app fixture'), hash = createHash('sha256').update(payload).digest('hex');
    const calls = [];
    let appRunning = ['running', 'quit-error'].includes(scenario), daemonRunning = existing;
    let originalBinMode;
    await mkdir(plan.bin, { recursive: true });
    if (existing) {
      await mkdir(plan.app, { recursive: true }); await writeFile(join(plan.app, 'old'), 'original bundle');
      await writeFile(bin, '# Chimera npm installer\noriginal CLI', { mode: 0o755 });
      // Windows reports host permissions rather than POSIX executable bits.
      originalBinMode = (await lstat(bin)).mode & 0o777;
      if (process.platform !== 'win32') assert.equal(originalBinMode, 0o755);
      await mkdir(join(dir, 'Library/LaunchAgents'), { recursive: true }); await writeFile(plan.plist, oldPlist);
    }
    const run = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === '/usr/bin/osascript') {
        if (args[0] === '-l') {
          if (scenario === 'detection-error') throw new Error('detection denied');
          return { stdout: String(macQuery(args[3], appRunning ? ['dev.chimera.desktop'] : [])) };
        }
        if (scenario === 'quit-error') throw new Error('quit denied (-1743)');
        appRunning = false;
      }
      if (cmd === '/usr/libexec/PlistBuddy') return { stdout: args[1].includes('Version') ? plan.version : 'dev.chimera.desktop' };
      if (args[0] === '-tzf') return { stdout: 'chimera.app/Contents/Info.plist\n' };
      if (args.includes('pack')) return { stdout: '[{"filename":"fixture.tgz"}]' };
      if (cmd === '/usr/bin/ditto') { await mkdir(args[1]); await writeFile(join(args[1], 'new'), 'new bundle'); }
      if (cmd === '/bin/launchctl') {
        if (args[0] === 'print' && !existing) throw new Error('not loaded');
        if (args[0] === 'bootout') daemonRunning = false;
        if (args[0] === 'bootstrap') {
          if (scenario === 'activation-error' && await readFile(plan.plist, 'utf8') !== oldPlist) throw new Error('activation denied');
          daemonRunning = true;
        }
      }
      return { stdout: '' };
    };
    const Client = { connect: async () => {
      if (!daemonRunning) throw new Error('not running');
      return { request: async method => { if (method === 'daemon.stop') daemonRunning = false; return {}; }, close() {} };
    } };
    try {
      const task = installMac({ manifest, plan, args: ['--no-open'], packageRoot: dir }, {
        run, ChimeraClient: Client,
        download: async url => url === plan.checksums ? Buffer.from(`${hash}  ${plan.asset}\n`) : payload,
      });
      if (failure) {
        await assert.rejects(task, /detection denied|quit denied|activation denied/);
        assert.equal(await readFile(join(plan.app, 'old'), 'utf8'), 'original bundle');
        assert.equal(await readFile(bin, 'utf8'), '# Chimera npm installer\noriginal CLI');
        assert.equal((await lstat(bin)).mode & 0o777, originalBinMode);
        assert.equal(await readFile(plan.plist, 'utf8'), oldPlist);
        assert.equal(daemonRunning, true);
        assert.deepEqual(await readdir(join(plan.root, 'releases')), []);
      } else {
        await task;
        assert.equal(await readFile(join(plan.app, 'new'), 'utf8'), 'new bundle');
        assert.match(await readFile(bin, 'utf8'), /Chimera npm installer/);
        assert.match(await readFile(plan.plist, 'utf8'), /ProgramArguments/);
        assert.equal(daemonRunning, true);
      }
      assert.equal(calls.filter(c => c.cmd === '/usr/bin/osascript' && c.args[0] === '-e').length, ['running', 'quit-error'].includes(scenario) ? 1 : 0);
      assert.ok(!calls.some(c => /pkill|killall|\/open$/.test(c.cmd)));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

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
