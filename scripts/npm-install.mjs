// Shipped inside the npm artifact. All downloads/build preparation precede service changes.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, rename, rm, lstat, readlink, symlink, chmod } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, win32, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const repo = 'nedimYilmaz/chimera';
const label = 'com.chimera.chimerad';
const marker = '# Chimera npm installer';
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const exists = async path => { try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

export function installPlan(manifest, { platform = process.platform, arch = process.arch, home = homedir(), env = process.env } = {}) {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported desktop target: ${platform}-${arch}`);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.test(manifest.version)) throw new Error('Invalid package version');
  const path = platform === 'win32' ? win32 : posix;
  const suffix = { darwin: '.tar.gz', linux: '.AppImage', win32: '.exe' }[platform];
  const asset = `chimera-desktop-${manifest.version}-${platform}-${arch}${suffix}`;
  const base = `https://github.com/${repo}/releases/download/v${manifest.version}`;
  const data = platform === 'win32' ? env.LOCALAPPDATA || path.join(home, 'AppData/Local') : path.join(home, '.local/share');
  const roaming = env.APPDATA || path.join(home, 'AppData/Roaming');
  const root = path.join(data, 'chimera');
  const plan = { platform, arch, home, version: manifest.version, asset, download: `${base}/${asset}`, checksums: `${base}/SHA256SUMS`, root,
    bin: platform === 'win32' ? path.join(root, 'bin') : path.join(home, '.local/bin'), state: path.join(home, '.chimera'),
    app: platform === 'darwin' ? path.join(home, 'Applications/chimera.app') : path.join(root, 'desktop', platform === 'win32' ? 'chimera.exe' : 'chimera.AppImage'),
  };
  if (platform === 'darwin') plan.plist = path.join(home, 'Library/LaunchAgents', `${label}.plist`);
  if (platform === 'linux') {
    // Match the CLI's service lookup, which uses ~/.config regardless of XDG_CONFIG_HOME.
    plan.serviceFile = path.join(home, '.config/systemd/user/chimerad.service');
    plan.shortcut = path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), 'applications/dev.chimera.desktop.desktop');
  }
  if (platform === 'win32') {
    plan.serviceFile = path.join(roaming, 'Microsoft/Windows/Start Menu/Programs/Startup/Chimera daemon.lnk');
    plan.shortcut = path.join(roaming, 'Microsoft/Windows/Start Menu/Programs/Chimera.lnk');
    plan.windowsPublisherThumbprint = manifest.chimeraRelease?.windowsPublisherThumbprint ?? null;
  }
  for (const value of Object.values(plan)) if (typeof value === 'string' && /[\r\n\0]/.test(value)) throw new Error('Installation paths must not contain control characters');
  return plan;
}

export function verifyChecksum(bytes, manifest, asset) {
  const matches = manifest.split(/\r?\n/).filter(line => line.endsWith(`  ${asset}`));
  if (matches.length !== 1 || !/^[a-f0-9]{64}  /.test(matches[0])) throw new Error(`Missing or ambiguous checksum for ${asset}`);
  if (createHash('sha256').update(bytes).digest('hex') !== matches[0].slice(0, 64)) throw new Error(`Checksum mismatch for ${asset}`);
}

export function launchAgent(plan, daemon, node, path) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(daemon)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>EnvironmentVariables</key><dict>
<key>HOME</key><string>${xml(homedir())}</string>
<key>CHIMERA_HOME</key><string>${xml(plan.state)}</string>
<key>PATH</key><string>${xml(path)}</string>
</dict>
<key>StandardOutPath</key><string>${xml(join(plan.state, 'daemon.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(plan.state, 'daemon.log'))}</string>
</dict></plist>\n`;
}

export async function download(url, limit) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Release download failed (${response.status}): ${url}. The matching public signed release must exist before installation.`);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Release download exceeds size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function quitMacDesktop(run = exec, pause = ms => new Promise(r => setTimeout(r, ms)), now = () => performance.now()) {
  // NSWorkspace enumerates running bundles without asking LaunchServices to resolve an
  // installed app. AppleScript's literal application-id reference fails at compile time
  // on a fresh machine, even inside an "is running" guard.
  const query = `ObjC.import('AppKit');
var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
var found = false;
for (var i = 0; i < apps.count; i++) {
  if (ObjC.unwrap(apps.objectAtIndex(i).bundleIdentifier) === 'dev.chimera.desktop') found = true;
}
found;`;
  const running = async (timeout = 15_000) => {
    const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', query], { timeout });
    if (!['true', 'false'].includes(stdout.trim())) throw new Error('Could not determine whether the Chimera desktop is running');
    return stdout.trim() === 'true';
  };
  if (!await running()) return;
  // Resolve the identity at runtime so compilation never needs a registered bundle.
  await run('/usr/bin/osascript', ['-e', 'set bundleID to "dev.chimera.desktop"\nif application id bundleID is running then\n tell application id bundleID to quit\nend if'], { timeout: 15_000 });
  // Queries and pauses share one monotonic budget: a slow positive query must
  // not reset the exit wait while the daemon is stopped for the bundle swap.
  const deadline = now() + 10_000;
  while (now() < deadline) {
    const remaining = deadline - now();
    if (remaining < 1) break;
    if (!await running(Math.floor(remaining))) return;
    const delay = Math.min(100, deadline - now());
    if (delay > 0) await pause(delay);
  }
  throw new Error('Existing Chimera desktop did not quit; installation rolled back');
}

export async function install(args = process.argv.slice(3)) {
  for (const arg of args) if (!['--dry-run', '--no-open'].includes(arg)) throw new Error(`Unknown install option: ${arg}`);
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const plan = installPlan(manifest);
  if (args.includes('--dry-run')) { console.log(JSON.stringify(plan, null, 2)); return; }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ is required');
  if (process.getuid?.() === 0) throw new Error('Run this installer as your normal user, without sudo.');
  if (process.env.CHIMERA_HOME && resolve(process.env.CHIMERA_HOME) !== plan.state) throw new Error('Combined desktop installation uses ~/.chimera. Unset CHIMERA_HOME, or use the existing source installer for custom state paths.');
  if (plan.platform !== 'darwin') return (await import('./npm-install-portable.mjs')).installPortable({ manifest, plan, args, packageRoot });
  return installMac({ manifest, plan, args, packageRoot });
}

// Dependencies are injectable for offline transaction tests; production uses the native
// commands and the client from the exact permanent npm payload being installed.
export async function installMac({ manifest, plan, args, packageRoot }, { run = exec, download: fetchRelease = download, ChimeraClient: Client } = {}) {
  const exec = run;
  await exec('git', ['--version']);
  await exec('npm', ['--version']);
  const service = `gui/${process.getuid()}/${label}`;
  const domain = `gui/${process.getuid()}`;
  const priorPlist = await exists(plan.plist) ? await readFile(plan.plist, 'utf8') : null;
  if (priorPlist && (!priorPlist.includes(label) || !priorPlist.includes('chimerad'))) throw new Error(`Unrecognized service at ${plan.plist}`);
  if (await exists(plan.app)) {
    const { stdout } = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(plan.app, 'Contents/Info.plist')]);
    if (stdout.trim() !== 'dev.chimera.desktop') throw new Error(`Another application owns ${plan.app}`);
  }
  const previousBins = new Map();
  for (const name of Object.keys(manifest.bin)) {
    const path = join(plan.bin, name), stat = await exists(path);
    if (!stat) { previousBins.set(name, null); continue; }
    if (stat.isSymbolicLink()) {
      const link = await readlink(path);
      if (!link.endsWith(`/bin/${name}.js`)) throw new Error(`Another installation owns ${path}`);
      previousBins.set(name, { link });
    } else {
      const text = await readFile(path, 'utf8');
      if (!text.includes(marker)) throw new Error(`Another installation owns ${path}`);
      previousBins.set(name, { text, mode: stat.mode });
    }
  }

  const temp = await mkdtemp(join(tmpdir(), 'chimera-install-'));
  let releaseDir, oldApp, newApp = false, changed = false, loaded = false, committed = false, retainRelease = false;
  try {
    console.log(`Downloading signed desktop ${plan.version} (${process.arch})…`);
    const checksums = await fetchRelease(plan.checksums, 1024 * 1024);
    const bytes = await fetchRelease(plan.download, 1024 * 1024 * 1024);
    verifyChecksum(bytes, checksums.toString('utf8'), plan.asset);
    const archive = join(temp, plan.asset);
    await writeFile(archive, bytes);
    const { stdout: listing } = await exec('/usr/bin/tar', ['-tzf', archive], { maxBuffer: 8 * 1024 * 1024 });
    if (!listing.trim() || listing.trim().split('\n').some(p => !p.startsWith('chimera.app/') || p.split('/').includes('..'))) throw new Error('Invalid desktop archive layout');
    await exec('/usr/bin/tar', ['-xzf', archive, '-C', temp]);
    const app = join(temp, 'chimera.app');
    const { stdout: bundleId } = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents/Info.plist')]);
    if (bundleId.trim() !== 'dev.chimera.desktop') throw new Error('Unexpected desktop bundle identifier');
    const { stdout: appVersion } = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')]);
    if (appVersion.trim() !== manifest.version) throw new Error('Desktop and CLI versions do not match');
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    await exec('/usr/sbin/spctl', ['--assess', '--type', 'execute', app]);
    await exec('/usr/bin/xcrun', ['stapler', 'validate', app]);

    console.log('Installing CLI into a permanent user directory…');
    await mkdir(join(plan.root, 'releases'), { recursive: true });
    releaseDir = await mkdtemp(join(plan.root, 'releases', `${plan.version}-`));
    // Repack this exact npm payload so npx and GitHub-tarball users get identical CLI bytes.
    const { stdout: packOutput } = await exec('npm', ['pack', packageRoot, '--ignore-scripts', '--json', '--pack-destination', temp], { maxBuffer: 4 * 1024 * 1024 });
    const packed = JSON.parse(packOutput);
    const tarball = join(temp, packed[0].filename);
    await exec('npm', ['install', '--prefix', releaseDir, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', tarball], { maxBuffer: 4 * 1024 * 1024 });
    const permanent = join(releaseDir, 'node_modules', manifest.name);
    const cli = join(permanent, manifest.bin.chimera);
    await exec(process.execPath, [cli, 'doctor']);
    await mkdir(dirname(plan.app), { recursive: true });
    await mkdir(plan.bin, { recursive: true });
    await mkdir(dirname(plan.plist), { recursive: true });
    await mkdir(plan.state, { recursive: true, mode: 0o700 });
    const ChimeraClient = Client ?? (await import(pathToFileURL(join(permanent, 'packages/client/src/client.js')).href)).ChimeraClient;
    loaded = await exec('/bin/launchctl', ['print', service]).then(() => true, () => false);
    changed = true;
    if (loaded) await exec('/bin/launchctl', ['bootout', service]);
    const previous = await ChimeraClient.connect({ home: plan.state, autostart: false }).catch(() => null);
    if (previous) { await previous.request('daemon.stop', {}).catch(() => {}); previous.close(); }
    let stopped = false;
    for (let i = 0; i < 100; i++) {
      const connected = await ChimeraClient.connect({ home: plan.state, autostart: false }).catch(() => null);
      if (!connected) { stopped = true; break; }
      connected.close(); await new Promise(r => setTimeout(r, 100));
    }
    if (!stopped) throw new Error('Existing daemon did not stop; installation rolled back');
    await quitMacDesktop(exec);
    if (await exists(plan.app)) {
      const backup = `${plan.app}.backup-${Date.now()}`;
      await rename(plan.app, backup);
      oldApp = backup;
    }
    // ditto handles different volumes and preserves the signed bundle's metadata.
    newApp = true;
    await exec('/usr/bin/ditto', [app, plan.app]);
    for (const [name, target] of Object.entries(manifest.bin)) {
      const path = join(plan.bin, name);
      await rm(path, { force: true });
      await writeFile(path, `#!/bin/sh\n${marker}\nexec ${quote(process.execPath)} ${quote(join(permanent, target))} "$@"\n`, { mode: 0o755 });
    }
    const searchPath = `${plan.bin}:${join(releaseDir, 'node_modules/.bin')}:${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`;
    await writeFile(plan.plist, launchAgent(plan, join(permanent, manifest.bin.chimerad), process.execPath, searchPath));
    await exec('/usr/bin/plutil', ['-lint', plan.plist]);
    await exec('/bin/launchctl', ['bootstrap', domain, plan.plist]);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      const connected = await ChimeraClient.connect({ home: plan.state, autostart: false }).catch(() => null);
      if (connected) { await connected.request('daemon.status', {}); connected.close(); ready = true; break; }
      await new Promise(r => setTimeout(r, 200));
    }
    if (!ready) throw new Error('Installed daemon failed its health check');
    committed = true;
    if (oldApp) await rm(oldApp, { recursive: true, force: true }).catch(() => console.warn(`Old app backup retained at ${oldApp}`));
    console.log(`Installed Chimera ${manifest.version}: ${plan.app}\nCLI: ${plan.bin}\nDaemon starts at login. User data: ${plan.state}`);
    if (!(process.env.PATH ?? '').split(':').includes(plan.bin)) console.log(`Add to your shell profile: export PATH="$HOME/.local/bin:$PATH"`);
    if (!args.includes('--no-open')) await exec('/usr/bin/open', [plan.app]).catch(error => console.warn(`Installed successfully; open ${plan.app} manually (${error.message}).`));
  } catch (error) {
    if (changed && !committed) {
      console.error('Restoring the previous app, CLI and service…');
      try {
      await exec('/bin/launchctl', ['bootout', service]).catch(() => {});
      if (newApp) await rm(plan.app, { recursive: true, force: true });
      if (oldApp) await rename(oldApp, plan.app);
      for (const [name, old] of previousBins) {
        const path = join(plan.bin, name);
        await rm(path, { force: true });
        if (old?.link) await symlink(old.link, path);
        else if (old) { await writeFile(path, old.text); await chmod(path, old.mode); }
      }
      if (priorPlist !== null) await writeFile(plan.plist, priorPlist);
      else await rm(plan.plist, { force: true });
      if (loaded) await exec('/bin/launchctl', ['bootstrap', domain, plan.plist]);
      } catch (rollbackError) {
        retainRelease = true;
        throw new AggregateError([error, rollbackError], `Installation and rollback failed. Recovery files retained at ${releaseDir}; app backup: ${oldApp ?? 'none'}. ${error.message}; ${rollbackError.message}`);
      }
    }
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
    if (releaseDir && !committed && !retainRelease) await rm(releaseDir, { recursive: true, force: true });
  }
}
