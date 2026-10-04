// Linux and Windows share a per-user file transaction; no machine-wide package manager is needed.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, lstat, readlink, symlink, copyFile, chmod, rm, readdir } from 'node:fs/promises';
import { dirname, join, resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { download, verifyChecksum } from './npm-install.mjs';
import { installerMarker, psQuote, psCommand, systemdUnit, desktopEntry, cliLauncher, windowsShortcut, windowsDaemonStart, verifyWindowsSignature, verifyNativeHeader, webviewProbe } from './npm-install-platforms.mjs';

const execute = promisify(execFile);
const exists = async path => { try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const delay = ms => new Promise(r => setTimeout(r, ms));

export async function snapshotFiles(paths, dir) {
  const snapshots = [];
  for (const path of paths) {
    const stat = await exists(path), snapshot = { path };
    if (stat?.isSymbolicLink()) snapshot.link = await readlink(path);
    else if (stat) {
      if (!stat.isFile()) throw new Error(`Refusing to overwrite a non-file: ${path}`);
      snapshot.backup = join(dir, `backup-${snapshots.length}`); snapshot.mode = stat.mode;
      await copyFile(path, snapshot.backup);
    }
    snapshots.push(snapshot);
  }
  return snapshots;
}

export async function restoreFiles(snapshots) {
  for (const item of [...snapshots].reverse()) {
    await rm(item.path, { force: true });
    if (item.link) await symlink(item.link, item.path);
    else if (item.backup) { await copyFile(item.backup, item.path); await chmod(item.path, item.mode); }
  }
}

export async function installPortable({ manifest, plan, args, packageRoot }, hooks = {}) {
  // Injected process/download adapters let tests exercise platform failure paths without touching OS services.
  const run = hooks.run ?? ((cmd, argv, opts = {}) => execute(cmd, argv, { windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...opts }));
  const get = hooks.download ?? download;
  const powershell = (source, opts) => run('powershell.exe', psCommand(source), opts);
  const windows = plan.platform === 'win32';
  await run('git', ['--version']);
  let npm = hooks.npmCommand ?? ['npm', []];
  if (windows) {
    const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), process.env.APPDATA && join(process.env.APPDATA, 'npm/node_modules/npm/bin/npm-cli.js')];
    const entry = await (async () => { for (const path of candidates) if (path?.endsWith('npm-cli.js') && await exists(path)) return path; })();
    if (!entry && !hooks.npmCommand) throw new Error('Cannot locate npm-cli.js. Install Node.js 24+ with npm, then retry.');
    if (!hooks.npmCommand) npm = [process.execPath, [entry]];
    // Validate the release publisher before any download or native execution.
    verifyWindowsSignature(plan.app, plan.windowsPublisherThumbprint);
    await powershell("if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this installer from a normal, non-administrator terminal' }");
  } else {
    if (!hooks.run && !process.report.getReport().header.glibcVersionRuntime) throw new Error('Linux desktop releases require glibc; musl/Alpine is not supported');
    // is-system-running returns nonzero for degraded systems; show-environment verifies the user bus instead.
    await run('systemctl', ['--user', 'show-environment']).catch(() => { throw new Error('A running systemd user session is required for desktop installation'); });
  }
  const receiptPath = join(plan.root, 'install.json');
  const receipt = await exists(receiptPath) ? JSON.parse(await readFile(receiptPath, 'utf8')) : null;
  if (receipt && receipt.owner !== 'chimera-npm') throw new Error('Unrecognized installation receipt');
  const binPaths = Object.keys(manifest.bin).map(name => join(plan.bin, name + (windows ? '.cmd' : '')));
  for (const path of [plan.app, plan.shortcut, plan.serviceFile, ...binPaths]) {
    const stat = await exists(path);
    if (!stat) continue;
    if (receipt?.files?.includes(path)) continue;
    if (stat.isFile() && (path === plan.serviceFile && !windows || binPaths.includes(path))) {
      if ((await readFile(path, 'utf8')).includes(installerMarker)) continue;
    }
    throw new Error(`Existing unmanaged file at ${path}; remove or migrate that installation first`);
  }
  const temp = await mkdtemp(join(tmpdir(), 'chimera-install-'));
  let releaseDir, snapshots, clientClass, changed = false, committed = false, retain = false, active = false, enabled = false, serviceWritten = false, oldUserPath, pathChanged = false;
  try {
    console.log(`Downloading desktop ${plan.version} (${plan.platform}-${plan.arch})…`);
    const sums = await get(plan.checksums, 1024 * 1024);
    const bytes = await get(plan.download, 1024 * 1024 * 1024);
    verifyChecksum(bytes, sums.toString('utf8'), plan.asset);
    verifyNativeHeader(bytes, plan.platform, plan.arch);
    const artifact = join(temp, plan.asset);
    await writeFile(artifact, bytes, { mode: 0o755 });
    if (windows) {
      await powershell(verifyWindowsSignature(artifact, plan.windowsPublisherThumbprint));
      const info = await powershell(`$v = (Get-Item -LiteralPath ${psQuote(artifact)}).VersionInfo.ProductVersion; if ($v -ne ${psQuote(plan.version)}) { throw 'Desktop and CLI versions do not match' }`);
      void info;
      if ((await powershell(webviewProbe)).stdout.trim() !== 'installed') {
        console.log('Installing Microsoft WebView2 runtime…');
        const bootstrap = join(temp, 'MicrosoftEdgeWebview2Setup.exe');
        await writeFile(bootstrap, await get('https://go.microsoft.com/fwlink/p/?LinkId=2124703', 16 * 1024 * 1024));
        await powershell(`$s = Get-AuthenticodeSignature -LiteralPath ${psQuote(bootstrap)}; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(,|$)') { throw 'Invalid Microsoft WebView2 installer signature' }`);
        await run(bootstrap, ['/silent', '/install'], { timeout: 180_000 });
        if ((await powershell(webviewProbe)).stdout.trim() !== 'installed') throw new Error('WebView2 installation did not complete');
      }
    } else {
      // The runtime probe neither mounts FUSE nor starts the desktop UI.
      await run(artifact, ['--appimage-version']);
    }
    console.log('Preparing permanent CLI installation…');
    await mkdir(join(plan.root, 'releases'), { recursive: true });
    releaseDir = await mkdtemp(join(plan.root, 'releases', `${plan.version}-`));
    const pack = JSON.parse((await run(npm[0], [...npm[1], 'pack', packageRoot, '--ignore-scripts', '--json', '--pack-destination', temp])).stdout);
    await run(npm[0], [...npm[1], 'install', '--prefix', releaseDir, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', join(temp, pack[0].filename)]);
    const permanent = join(releaseDir, 'node_modules', manifest.name);
    await run(process.execPath, [join(permanent, manifest.bin.chimera), 'doctor']);
    clientClass = hooks.ChimeraClient ?? (await import(pathToFileURL(join(permanent, 'packages/client/src/client.js')).href)).ChimeraClient;
    const searchPath = [plan.bin, join(releaseDir, 'node_modules/.bin'), dirname(process.execPath), process.env.PATH ?? ''].join(delimiter);
    const daemon = join(permanent, manifest.bin.chimerad);
    const startScript = join(releaseDir, 'start-daemon.cjs');
    if (windows) await writeFile(startScript, windowsDaemonStart(daemon, process.execPath, plan.state, searchPath));
    const files = [plan.app, plan.shortcut, plan.serviceFile, ...binPaths, receiptPath];
    for (const file of files) await mkdir(dirname(file), { recursive: true });
    await mkdir(plan.state, { recursive: true, mode: 0o700 });
    snapshots = await snapshotFiles(files, temp);
    if (!windows) {
      active = await run('systemctl', ['--user', 'is-active', '--quiet', 'chimerad.service']).then(() => true, () => false);
      enabled = await run('systemctl', ['--user', 'is-enabled', '--quiet', 'chimerad.service']).then(() => true, () => false);
    }
    changed = true;
    if (active) await run('systemctl', ['--user', 'stop', 'chimerad.service']);
    // Remove logon activation while Windows files are being replaced.
    if (windows) await rm(plan.serviceFile, { force: true });
    const previous = await clientClass.connect({ home: plan.state, autostart: false }).catch(() => null);
    if (previous) { await previous.request('daemon.stop', {}).catch(() => {}); previous.close(); }
    await waitDaemon(clientClass, plan.state, false);
    if (windows) {
      await powershell(`Get-Process | Where-Object { $_.Path -eq ${psQuote(plan.app)} } | ForEach-Object { if (-not $_.CloseMainWindow()) { throw 'Close the running Chimera app, then retry' }; if (-not $_.WaitForExit(15000)) { throw 'Chimera app did not close' } }`);
    } else if (await exists(plan.app)) {
      // AppImage's /proc/exe points at its extracted ELF. APPIMAGE names the exact parent image.
      const procRoot = hooks.procRoot ?? '/proc';
      for (const pid of await readdir(procRoot)) {
        if (!/^\d+$/.test(pid)) continue;
        let environment;
        try { environment = await readFile(join(procRoot, pid, 'environ'), 'utf8'); } catch { continue; }
        if (environment.split('\0').includes(`APPIMAGE=${plan.app}`)) throw new Error('Close the running Chimera desktop app, then retry the upgrade');
      }
    }
    await rm(plan.app, { force: true });
    await copyFile(artifact, plan.app);
    await chmod(plan.app, 0o755);
    for (const [name, target] of Object.entries(manifest.bin)) {
      const file = join(plan.bin, name + (windows ? '.cmd' : ''));
      await rm(file, { force: true });
      await writeFile(file, cliLauncher(plan.platform, process.execPath, join(permanent, target)), { mode: 0o755 });
    }
    if (windows) {
      await powershell(windowsShortcut(plan.shortcut, plan.app));
      // Encoded PowerShell starts Node hidden; no execution-policy changes or scheduled-task privileges.
      const start = `Start-Process -WindowStyle Hidden -FilePath ${psQuote(process.execPath)} -ArgumentList ${psQuote(`"${startScript}"`)}`;
      const psExe = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      await powershell(windowsShortcut(plan.serviceFile, psExe, `-WindowStyle Hidden ${psCommand(start).join(' ')}`, true));
      await run(process.execPath, [startScript]);
    } else {
      await writeFile(plan.shortcut, desktopEntry(plan));
      await writeFile(plan.serviceFile, systemdUnit(plan, daemon, process.execPath, searchPath));
      serviceWritten = true;
      await run('systemctl', ['--user', 'daemon-reload']);
      await run('systemctl', ['--user', 'enable', '--now', 'chimerad.service']);
    }
    await waitDaemon(clientClass, plan.state, true);
    await writeFile(receiptPath, JSON.stringify({ owner: 'chimera-npm', version: plan.version, platform: plan.platform, arch: plan.arch, files }, null, 2));
    if (windows) {
      const prior = await powershell("ConvertTo-Json -Compress -InputObject ([Environment]::GetEnvironmentVariable('Path', 'User'))");
      oldUserPath = JSON.parse(prior.stdout.trim());
      const entries = (oldUserPath ?? '').split(';').filter(Boolean);
      if (!entries.some(p => p.toLowerCase() === plan.bin.toLowerCase())) {
        pathChanged = true;
        await powershell(`[Environment]::SetEnvironmentVariable('Path', ${psQuote([...entries, plan.bin].join(';'))}, 'User')`);
      }
    }
    committed = true;
    console.log(`Installed Chimera ${plan.version}: ${plan.app}\nCLI: ${plan.bin}\nDaemon starts at login. User data: ${plan.state}`);
    console.log(windows ? 'CLI added to your user PATH; open a new terminal to use it.' : 'If needed, add to your shell profile: export PATH="$HOME/.local/bin:$PATH"');
    if (!args.includes('--no-open')) {
      if (windows) await powershell(`Start-Process -FilePath ${psQuote(plan.app)}`).catch(e => console.warn(`Open the app manually: ${e.message}`));
      else {
        const child = spawn(plan.app, ['--appimage-extract-and-run'], { detached: true, stdio: 'ignore' });
        child.on('error', e => console.warn(`Open the app manually: ${e.message}`)); child.unref();
      }
    }
  } catch (error) {
    if (changed && !committed) {
      try {
        if (!windows && serviceWritten) await run('systemctl', ['--user', 'disable', '--now', 'chimerad.service']);
        else if (windows) {
          const c = await clientClass.connect({ home: plan.state, autostart: false }).catch(() => null);
          if (c) { await c.request('daemon.stop', {}).catch(() => {}); c.close(); }
          await waitDaemon(clientClass, plan.state, false);
        }
        await restoreFiles(snapshots);
        if (pathChanged) await powershell(`[Environment]::SetEnvironmentVariable('Path', ${oldUserPath === null ? '$null' : psQuote(oldUserPath)}, 'User')`);
        if (!windows) {
          await run('systemctl', ['--user', 'daemon-reload']);
          if (enabled) await run('systemctl', ['--user', 'enable', 'chimerad.service']);
          if (active) await run('systemctl', ['--user', 'start', 'chimerad.service']);
        }
      } catch (rollbackError) {
        retain = true;
        throw new Error(`Install failed: ${error.message}. Rollback failed: ${rollbackError.message}. Recovery files retained at ${temp} and ${releaseDir}`);
      }
    }
    throw error;
  } finally {
    if (!retain) await rm(temp, { recursive: true, force: true });
    if (releaseDir && !committed && !retain) await rm(releaseDir, { recursive: true, force: true });
  }
}

async function waitDaemon(Client, home, ready) {
  for (let i = 0; i < 100; i++) {
    const client = await Client.connect({ home, autostart: false }).catch(() => null);
    if (client) {
      try { if (ready) { await client.request('daemon.status', {}); return; } } finally { client.close(); }
    } else if (!ready) return;
    await delay(200);
  }
  throw new Error(ready ? 'Installed daemon failed its health check' : 'Existing daemon did not stop');
}
