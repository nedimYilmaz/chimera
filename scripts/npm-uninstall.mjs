// Explicit CLI operation only: importing this file has no lifecycle side effects.
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { posix, win32, dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { installPlan } from './npm-install.mjs';
import { psCommand, psQuote, shQuote, cliLauncher, systemdUnit, desktopEntry } from './npm-install-platforms.mjs';

const execute = promisify(execFile);
const bundle = 'dev.chimera.desktop';
const label = 'com.chimera.chimerad';
const bins = { chimera: 'packages/client/bin/chimera.js', chimerad: 'packages/daemon/bin/chimerad.js', 'chimera-mcp': 'packages/mcp/bin/chimera-mcp.js' };
const accountName = /^[A-Za-z0-9_-]{1,200}$/;
const mcpName = /^[a-z0-9][a-z0-9-]{0,63}$/;
const secretName = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const pathFor = platform => platform === 'win32' ? win32 : posix;
const equal = (a, b, platform) => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (path, parent, p) => { const rel = p.relative(parent, path); return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel); };
const stat = async (io, path) => { try { return await io.lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const json = async (io, path) => { const s = await stat(io, path); if (!s) return null; if (s.isSymbolicLink()) throw new Error(`Refusing symlink metadata: ${path}`); try { return JSON.parse(await io.readFile(path, 'utf8')); } catch { throw new Error(`Invalid Chimera metadata: ${path}`); } };

export function uninstallPlan(manifest, context = {}) {
  const platform = context.platform ?? process.platform, home = context.home ?? homedir(), env = context.env ?? process.env;
  const plan = installPlan(manifest, { ...context, platform, home, env });
  const p = pathFor(platform);
  if (manifest.name !== '@nedimyilmaz/chimera' || Object.keys(bins).some(name => manifest.bin?.[name] !== bins[name]) || Object.keys(manifest.bin).length !== 3) throw new Error('Unrecognized Chimera npm package');
  const selected = env.CHIMERA_HOME || plan.state;
  if (!p.isAbsolute(selected) || !p.isAbsolute(home)) throw new Error('CHIMERA_HOME and user home must be absolute paths');
  plan.defaultState = plan.state;
  plan.state = p.normalize(selected);
  // This is the locked Tauri 2.11.5 + dirs 6.0.0 app_cache_dir contract, not a cache search.
  const cacheBase = platform === 'darwin' ? p.join(home, 'Library/Caches') : platform === 'win32' ? env.LOCALAPPDATA || p.join(home, 'AppData/Local') : env.XDG_CACHE_HOME && p.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : p.join(home, '.cache');
  plan.cache = p.join(cacheBase, bundle);
  plan.binPaths = Object.keys(bins).map(name => p.join(plan.bin, name + (platform === 'win32' ? '.cmd' : '')));
  plan.receipt = p.join(plan.root, 'install.json');
  plan.preservedHomes = equal(plan.state, plan.defaultState, platform) ? [] : [plan.defaultState];
  if (plan.preservedHomes.some(home => inside(plan.state, home, p) || inside(home, plan.state, p))) throw new Error('Selected and preserved Chimera homes must not overlap');
  plan.npmPackage = manifest.name;
  for (const value of [plan.state, plan.defaultState, plan.root, plan.cache, plan.app, plan.plist ?? plan.serviceFile, ...(plan.shortcut ? [plan.shortcut] : []), ...plan.binPaths]) {
    if (!p.isAbsolute(value) || plan.platform === 'win32' && p.parse(value).root.startsWith('\\\\') || /[\r\n\0]/.test(value) || equal(value, home, platform) || equal(value, p.parse(value).root, platform) || inside(home, value, p)) throw new Error(`Unsafe uninstall path: ${value}`);
  }
  for (const value of [plan.state, plan.defaultState]) if (equal(value, plan.root, platform) || inside(plan.root, value, p) || inside(value, plan.root, p)) throw new Error('State and installation paths must not overlap');
  if (plan.preservedHomes.some(home => equal(plan.cache, home, platform) || inside(plan.cache, home, p) || inside(home, plan.cache, p))) throw new Error('Shared app cache overlaps a preserved home');
  return plan;
}

async function safePath(io, path, plan) {
  const p = pathFor(plan.platform);
  // System aliases above the user's real home are allowed; aliases within a removal path aren't.
  const anchor = inside(path, plan.home, p) ? plan.home : p.parse(path).root;
  let cursor = path;
  while (!equal(cursor, anchor, plan.platform)) {
    const s = await stat(io, cursor);
    if (s?.isSymbolicLink()) throw new Error(`Refusing symlink/reparse uninstall path: ${cursor}`);
    const next = p.dirname(cursor); if (next === cursor) break; cursor = next;
  }
}

async function windowsReparseInventory(path, run) {
  // A single process per tree/pass. The stack never enters a reparse directory;
  // only reparse metadata is returned, regardless of the ordinary file count.
  const source = `$root=Get-Item -Force -LiteralPath ${psQuote(path)}; $found=[Collections.Generic.List[object]]::new(); $todo=[Collections.Generic.Stack[object]]::new(); $todo.Push($root);
while($todo.Count -gt 0) { $i=$todo.Pop(); if([bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $found.Add(@{ path=$i.FullName; linkType=$i.LinkType }); continue }; if($i.PSIsContainer) { foreach($child in Get-ChildItem -Force -LiteralPath $i.FullName) { if($child.PSIsContainer -or [bool]($child.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $todo.Push($child) } } } }; ConvertTo-Json -Compress -InputObject @($found.ToArray())`;
  const rows = JSON.parse((await run('powershell.exe', psCommand(source))).stdout), result = new Map();
  if (!Array.isArray(rows)) throw new Error(`Cannot classify Windows reparse tree: ${path}`);
  for (const row of rows) {
    if (typeof row.path !== 'string' || !win32.isAbsolute(row.path) || (!equal(row.path, path, 'win32') && !inside(row.path, path, win32)) || result.has(row.path.toLowerCase())) throw new Error(`Invalid Windows reparse inventory: ${path}`);
    result.set(row.path.toLowerCase(), row.linkType);
  }
  return result;
}

async function safeTree(io, path, plan, reparses, device, links = []) {
  await safePath(io, path, plan);
  const s = await stat(io, path);
  if (!s) return;
  if (!s.isDirectory()) throw new Error(`Expected a managed directory: ${path}`);
  if (device !== undefined && s.dev !== device) throw new Error(`Refusing cross-device data subtree: ${path}`);
  if (reparses?.has(path.toLowerCase())) throw new Error(`Refusing Windows reparse directory target: ${path}`);
  for (const entry of await io.readdir(path, { withFileTypes: true })) {
    const child = pathFor(plan.platform).join(path, entry.name);
    if (reparses?.has(child.toLowerCase())) {
      if (!['SymbolicLink', 'Junction'].includes(reparses.get(child.toLowerCase())) || !entry.isSymbolicLink()) throw new Error(`Refusing unclassified Windows reparse data: ${child}`);
      links.push(child); continue;
    }
    if (entry.isSymbolicLink()) {
      if (plan.platform === 'win32') throw new Error(`Inconsistent Windows reparse data: ${child}`);
      links.push(child); continue;
    }
    if (entry.isDirectory()) await safeTree(io, child, plan, reparses, s.dev, links);
  }
  return links;
}

async function purgeTrees(plan, io, run) {
  const links = [];
  for (const target of [plan.state, plan.cache]) {
    await safePath(io, target, plan);
    const reparses = plan.platform === 'win32' && await stat(io, target) ? await windowsReparseInventory(target, run) : undefined;
    const before = links.length;
    await safeTree(io, target, plan, reparses, undefined, links);
    if (reparses && links.length - before !== reparses.size) throw new Error(`Windows reparse inventory changed: ${target}`);
    if ((await Promise.all(['.git', '.hg', '.svn'].map(name => stat(io, pathFor(plan.platform).join(target, name))))).some(Boolean)) throw new Error(`Refusing to purge a repository: ${target}`);
  }
  return links;
}

// Config references select candidates, not authority. Native account/service attributes are
// verified separately without requesting password data, and preserved-home refs take priority.
export async function credentialRefs(io, home, platform) {
  const p = pathFor(platform), refs = new Set();
  const configPaths = [p.join(home, 'config.json')], overlays = p.join(home, 'config.d');
  if (await stat(io, overlays)) {
    if ((await stat(io, overlays)).isSymbolicLink()) throw new Error('Refusing symlink config overlays');
    for (const name of await io.readdir(overlays)) if (name.endsWith('.json')) configPaths.push(p.join(overlays, name));
  }
  for (const path of configPaths) {
    const config = await json(io, path); if (!config) continue;
    if (config.accounts !== undefined && !Array.isArray(config.accounts)) throw new Error(`Invalid accounts metadata: ${path}`);
    for (const a of config.accounts ?? []) {
      if (!accountName.test(a?.name ?? '')) throw new Error(`Invalid account name in ${path}`);
      if (a.auth?.type === 'keychain') {
        if (a.auth.service !== `chimera:${a.name}`) throw new Error(`Foreign credential reference in ${path}`);
        refs.add(a.auth.service);
      } else if (a.auth?.type === 'oauth') {
        if (a.auth.tokenRef !== `chimera-oauth:${a.name}`) throw new Error(`Foreign OAuth reference in ${path}`);
        refs.add(a.auth.tokenRef);
      }
    }
  }
  const secrets = await json(io, p.join(home, 'secrets.json'));
  if (secrets) {
    if (!Array.isArray(secrets.secrets)) throw new Error('Invalid secret metadata');
    for (const s of secrets.secrets) { if (!secretName.test(s?.name ?? '')) throw new Error('Invalid secret name'); refs.add(`chimera:secret:${s.name}`); }
  }
  const store = await json(io, p.join(home, 'mcpstore.json'));
  if (store) for (const [name, s] of Object.entries(store)) {
    if (!mcpName.test(name)) throw new Error('Invalid MCP-store name');
    if (s.auth !== undefined) { if (s.type !== 'http' || !['bearer', 'oauth'].includes(s.auth?.kind ?? 'bearer') || s.auth.keychainRef !== `chimera:mcp:${name}`) throw new Error('Foreign MCP credential reference'); refs.add(s.auth.keychainRef); }
  }
  // The fixed network key can be shared by two homes even without an explicit config ref.
  if (await stat(io, home)) refs.add('chimera:tailscale-authkey');
  return refs;
}

async function inventory(plan, manifest, io, run) {
  const p = pathFor(plan.platform), owned = [], roots = [];
  for (const target of [plan.root, plan.app, plan.plist ?? plan.serviceFile, plan.shortcut, ...plan.binPaths].filter(Boolean)) await safePath(io, target, plan);
  const receipt = await json(io, plan.receipt);
  const permitted = [plan.app, plan.shortcut, plan.serviceFile, ...plan.binPaths, plan.receipt].filter(Boolean);
  if (receipt && (receipt.owner !== 'chimera-npm' || receipt.platform !== plan.platform || !Array.isArray(receipt.files) || receipt.files.some(f => !permitted.includes(f)))) throw new Error('Foreign or invalid installation receipt');
  const releases = p.join(plan.root, 'releases');
  if (await stat(io, plan.root)) {
    const allowed = new Set(['releases', 'desktop', 'bin', 'install.json']);
    for (const name of await io.readdir(plan.root)) if (!allowed.has(name)) throw new Error(`Unmanaged installation content: ${p.join(plan.root, name)}`);
  }
  if (await stat(io, releases)) {
    for (const name of await io.readdir(releases)) {
      const release = p.join(releases, name); await safePath(io, release, plan);
      const pkg = p.join(release, 'node_modules', manifest.name); await safePath(io, pkg, plan);
      const metadata = await json(io, p.join(pkg, 'package.json'));
      if (metadata?.name !== manifest.name || Object.keys(bins).some(name => metadata.bin?.[name] !== bins[name])) throw new Error(`Unmanaged npm release: ${release}`);
      roots.push(pkg); owned.push(release);
    }
  }
  const daemonPaths = roots.map(root => p.join(root, bins.chimerad));
  for (const file of plan.binPaths) if (await stat(io, file)) {
    const text = await io.readFile(file, 'utf8');
    const name = p.basename(file).replace(/\.cmd$/, '');
    const expected = roots.map(root => p.join(root, bins[name]));
    const valid = expected.some(target => {
      if (plan.platform === 'win32') {
        const line = text.split('\r\n')[3];
        const suffix = ` "${target.replaceAll('%', '%%')}" %*`;
        if (!line?.endsWith(suffix)) return false;
        const node = line.slice(0, -suffix.length);
        if (!/^"[^"\r\n]+"$/.test(node)) return false;
        const decoded = node.slice(1, -1).replaceAll('%%', '%');
        return p.isAbsolute(decoded) && text === cliLauncher(plan.platform, decoded, target);
      }
      const line = text.split('\n')[2], suffix = ` ${shQuote(target)} "$@"`;
      if (!line?.startsWith('exec ') || !line.endsWith(suffix)) return false;
      const node = line.slice(5, -suffix.length);
      if (!node.startsWith("'") || !node.endsWith("'")) return false;
      const decoded = node.slice(1, -1).replaceAll("'\\''", "'");
      return p.isAbsolute(decoded) && shQuote(decoded) === node && text === cliLauncher(plan.platform, decoded, target);
    });
    if (!valid) throw new Error(`Foreign CLI launcher: ${file}`);
    owned.push(file);
  }
  const service = plan.plist ?? plan.serviceFile;
  if (await stat(io, service)) {
    if (plan.platform === 'darwin') {
      const read = async key => (await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, service])).stdout.trim();
      if (await read('Label') !== label || !daemonPaths.includes(await read('ProgramArguments:1')) || await read('EnvironmentVariables:CHIMERA_HOME') !== plan.defaultState) throw new Error(`Foreign login service: ${service}`);
    } else if (plan.platform === 'linux') {
      const text = await io.readFile(service, 'utf8');
      const decode = value => value.replace(/\\(["\\])/g, '$1').replaceAll('%%', '%');
      const args = [...(text.match(/^ExecStart=(.*)$/m)?.[1] ?? '').matchAll(/"((?:\\.|[^"\\])*)"/g)].map(m => decode(m[1]).replaceAll('$$', '$'));
      const path = text.match(/^Environment="PATH=(.*)"$/m)?.[1];
      if (args.length !== 2 || !daemonPaths.includes(args[1]) || path === undefined || text !== systemdUnit({ ...plan, state: plan.defaultState }, args[1], args[0], decode(path))) throw new Error(`Foreign login service: ${service}`);
      if (await stat(io, service + '.d')) throw new Error('Unmanaged systemd overrides must be removed explicitly');
    } else await verifyShortcut(run, service, { startup: true, plan, roots });
    owned.push(service);
  }
  if (await stat(io, plan.app)) {
    if (plan.platform === 'darwin') {
      if (!roots.length || (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', p.join(plan.app, 'Contents/Info.plist')])).stdout.trim() !== bundle) throw new Error(`Foreign desktop app: ${plan.app}`);
    } else if (!receipt?.files.includes(plan.app)) throw new Error(`Unowned desktop app: ${plan.app}`);
    owned.push(plan.app);
  }
  if (plan.shortcut && await stat(io, plan.shortcut)) {
    if (!receipt?.files.includes(plan.shortcut)) throw new Error('Unowned app shortcut');
    if (plan.platform === 'win32') await verifyShortcut(run, plan.shortcut, { plan });
    else if (await io.readFile(plan.shortcut, 'utf8') !== desktopEntry(plan)) throw new Error('Foreign desktop entry');
    owned.push(plan.shortcut);
  }
  for (const dir of [p.join(plan.root, 'desktop'), p.join(plan.root, 'bin')]) if (await stat(io, dir)) {
    for (const name of await io.readdir(dir)) if (!owned.includes(p.join(dir, name))) throw new Error(`Unmanaged installation file: ${p.join(dir, name)}`);
  }
  if (receipt) owned.push(plan.receipt);
  return { owned, roots, service: owned.includes(service) ? service : null };
}

async function verifyShortcut(run, file, { startup = false, plan, roots = [] }) {
  const result = await run('powershell.exe', psCommand(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(file)}); @{ target=$s.TargetPath; args=$s.Arguments; description=$s.Description } | ConvertTo-Json -Compress`));
  const link = JSON.parse(result.stdout);
  if (link.description !== 'Chimera npm installer') throw new Error(`Foreign shortcut: ${file}`);
  if (!startup) { if (!equal(link.target, plan.app, 'win32') || link.args) throw new Error(`Foreign shortcut target: ${file}`); return; }
  const encoded = link.args?.match(/-EncodedCommand ([A-Za-z0-9+/=]+)$/)?.[1];
  const source = encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : '';
  const expected = roots.map(root => win32.join(win32.dirname(win32.dirname(win32.dirname(root))), 'start-daemon.cjs'));
  const statement = source.split('\n').at(-1);
  const valid = expected.some(path => {
    const suffix = ` ${psQuote(path)}`;
    if (!statement?.startsWith('& ') || !statement.endsWith(suffix)) return false;
    const quoted = statement.slice(2, -suffix.length);
    if (!quoted.startsWith("'") || !quoted.endsWith("'")) return false;
    const node = quoted.slice(1, -1).replaceAll("''", "'");
    return win32.isAbsolute(node) && quoted === psQuote(node) && link.args === `-WindowStyle Hidden ${psCommand(`& ${psQuote(node)} ${psQuote(path)}`).join(' ')}`;
  });
  if (!equal(link.target, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32') || !valid) throw new Error(`Foreign startup target: ${file}`);

}

async function globalPackage(manifest, io, run, npm, plan) {
  const prefix = (await run(npm[0], [...npm[1], 'prefix', '--global'])).stdout.trim();
  const root = (await run(npm[0], [...npm[1], 'root', '--global'])).stdout.trim();
  const p = pathFor(plan.platform);
  if (!p.isAbsolute(prefix) || !p.isAbsolute(root) || root !== p.join(prefix, ...(plan.platform === 'win32' ? [] : ['lib']), 'node_modules')) throw new Error('Cannot prove global npm prefix');
  const dir = p.join(root, manifest.name); await safePath(io, dir, plan); const s = await stat(io, dir);
  if (!s) return null;
  if (s.isSymbolicLink()) throw new Error('Global npm package is a linked checkout; remove it explicitly');
  const pkg = await json(io, p.join(dir, 'package.json'));
  if (pkg?.name !== manifest.name || Object.keys(bins).some(name => pkg.bin?.[name] !== bins[name])) throw new Error('Foreign global npm package');
  return { prefix, dir };
}

async function ownedCredentials(plan, io, run) {
  const selected = await credentialRefs(io, plan.state, plan.platform), preserved = new Set();
  for (const home of plan.preservedHomes) for (const ref of await credentialRefs(io, home, plan.platform)) preserved.add(ref);
  const remove = [], retain = [...selected].filter(ref => preserved.has(ref));
  if (plan.platform !== 'darwin') return { remove, retain, unavailable: [...selected].filter(ref => !preserved.has(ref)) };
  for (const service of selected) {
    if (preserved.has(service)) continue;
    let stdout;
    try { stdout = (await run('/usr/bin/security', ['find-generic-password', '-s', service, '-a', 'chimera'])).stdout; }
    catch (e) { if (e.code === 44) continue; throw new Error(`Cannot establish credential ownership: ${service}`); }
    const attribute = name => stdout.match(new RegExp(`"${name}"<blob>="([^"\\n]*)"`))?.[1];
    if (attribute('acct') !== 'chimera' || attribute('svce') !== service) throw new Error(`Foreign credential ownership: ${service}`);
    remove.push(service);
  }
  return { remove, retain, unavailable: [] };
}

async function stateEntries(plan, io) {
  if (!await stat(io, plan.state)) return [];
  return (await io.readdir(plan.state)).sort().map(name => pathFor(plan.platform).join(plan.state, name));
}

async function prompt(plan, scope, hooks, io) {
  const text = `Permanently delete selected Chimera home ${plan.state} (state, history, accounts, managed projects/worktrees). Selected home contents: ${(await stateEntries(plan, io)).join(', ') || 'none'}. Shared app cache ${plan.cache}, and owned credential records: ${scope.remove.join(', ') || 'none'}.\nPreserved other homes: ${plan.preservedHomes.join(', ') || 'none'}. Shared credential records retained: ${scope.retain.join(', ') || 'none'}. Credential refs without a supported local ownership adapter remain: ${scope.unavailable.join(', ') || 'none'}.\nType the selected home path to confirm: `;
  if (!(hooks.isTTY ?? (() => process.stdin.isTTY && process.stdout.isTTY))()) throw new Error('Data purge requires an interactive terminal; no changes made');
  let answer;
  if (hooks.confirm) answer = await hooks.confirm(text);
  else { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { answer = await rl.question(text); } finally { rl.close(); } }
  if (answer !== plan.state) throw new Error('Purge confirmation did not match; no changes made');
}

async function desktopStopped(plan, io, run, uid) {
  if (plan.platform === 'darwin') {
    // Query exact bundle path, and ask for manual close: no other registered Chimera is quit.
    const query = `ObjC.import('AppKit'); var a=$.NSWorkspace.sharedWorkspace.runningApplications; var found=false; for(var i=0;i<a.count;i++){ if(ObjC.unwrap(a.objectAtIndex(i).bundleURL.path)===${JSON.stringify(plan.app)}) found=true; } found;`;
    const answer = (await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', query])).stdout.trim();
    if (answer !== 'false') throw new Error('Close the installed Chimera desktop and retry; no files removed');
  } else if (plan.platform === 'win32') {
    await run('powershell.exe', psCommand(`if (Get-Process | Where-Object { $_.Path -eq ${psQuote(plan.app)} }) { throw 'Close the installed Chimera desktop and retry' }`));
  } else {
    for (const pid of await io.readdir('/proc')) if (/^\d+$/.test(pid)) {
      const processDir = await stat(io, `/proc/${pid}`);
      if (!processDir || processDir.uid !== uid) continue;
      let env; try { env = await io.readFile(`/proc/${pid}/environ`, 'utf8'); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') continue; throw new Error('Cannot establish desktop process ownership; no files removed'); }
      if (env.split('\0').includes(`APPIMAGE=${plan.app}`)) throw new Error('Close the installed Chimera desktop and retry; no files removed');
    }
  }
}

async function daemonClients(plan, roots, Client, io, alive, cache, manifest, run, endpoint, stopping) {
  const result = [], p = pathFor(plan.platform);
  for (const home of new Set([plan.defaultState, plan.state])) {
    let client;
    await safePath(io, p.join(home, 'daemon.pid'), plan);
    if (plan.platform !== 'win32') await safePath(io, p.join(home, 'daemon.sock'), plan);
    try { client = await Client.connect({ home, autostart: false }); } catch {
      const pid = await stat(io, p.join(home, 'daemon.pid')) ? Number(await io.readFile(p.join(home, 'daemon.pid'), 'utf8')) : null;
      const known = stopping?.get(home);
      if (known !== undefined) {
        if (pid !== null && pid !== known) throw new Error(`Daemon identity changed while stopping at ${home}`);
        if (await alive(known)) { result.push({ home, client: null, pid: known }); continue; }
      }
      if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 1 || await alive(pid))) throw new Error(`Cannot establish daemon stopped at ${home}`);
      if (pid === null && plan.platform !== 'win32' && await stat(io, p.join(home, 'daemon.sock'))) throw new Error(`Cannot establish daemon stopped at ${home}`);
      if (plan.platform === 'win32') {
        const present = JSON.parse((await run('powershell.exe', psCommand(`ConvertTo-Json -Compress -InputObject ([System.IO.Directory]::GetFiles('\\\\.\\pipe\\') -contains ${psQuote(endpoint(home, 'win32'))})`))).stdout);
        if (present !== false) throw new Error(`Cannot establish named-pipe daemon stopped at ${home}`);
      }
      continue;
    }
    try {
      const status = await client.request('daemon.status', {});
      let owned = roots.some(root => equal(status.codeRoot ?? '', p.join(root, 'packages/daemon/src'), plan.platform));
      if (!owned && typeof status.codeRoot === 'string') {
        const pkg = p.resolve(status.codeRoot, '../../..'), cacheRoot = p.join(cache, '_npx');
        const parts = p.relative(cacheRoot, pkg).split(p.sep);
        if (parts.length === 4 && /^[A-Za-z0-9_-]+$/.test(parts[0]) && parts.slice(1).join('/') === 'node_modules/@nedimyilmaz/chimera' && equal(status.codeRoot, p.join(pkg, 'packages/daemon/src'), plan.platform)) {
          await safePath(io, pkg, plan);
          const metadata = await json(io, p.join(pkg, 'package.json'));
          owned = metadata?.name === manifest.name && Object.keys(bins).every(name => metadata.bin?.[name] === bins[name]);
        }
      }
      if (status.protocolVersion !== 1 || !owned) throw new Error(`Unmanaged daemon at ${home}; stop it explicitly before uninstall`);
      const pid = await stat(io, p.join(home, 'daemon.pid')) ? Number(await io.readFile(p.join(home, 'daemon.pid'), 'utf8')) : null;
      if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 1)) throw new Error(`Invalid daemon PID at ${home}`);
      if (stopping?.has(home) && pid !== stopping.get(home)) throw new Error(`Daemon identity changed while stopping at ${home}`);
      result.push({ home, client, pid });
    } catch (e) { client.close(); for (const item of result) item.client?.close(); throw e; }
  }
  return result;
}

export async function uninstall(args = process.argv.slice(3), hooks = {}) {
  for (const arg of args) if (!['--purge-data', '--dry-run'].includes(arg)) throw new Error(`Unknown uninstall option: ${arg}`);
  const io = hooks.fs ?? fs, run = hooks.run ?? ((cmd, argv) => execute(cmd, argv, { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true }));
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = hooks.manifest ?? await json(io, join(packageRoot, 'package.json'));
  const plan = uninstallPlan(manifest, hooks.context), p = pathFor(plan.platform), log = hooks.log ?? console.log;
  const purge = args.includes('--purge-data');
  for (const target of [plan.state, plan.defaultState, ...(purge ? [plan.cache] : [])]) await safePath(io, target, plan);
  if (args.includes('--dry-run')) {
    const refs = purge ? [...await credentialRefs(io, plan.state, plan.platform)] : [];
    log(JSON.stringify({ ...plan, cache: plan.platform === 'win32' ? 'Native LocalApplicationData/dev.chimera.desktop (resolved before purge confirmation)' : plan.cache, dryRun: true, purgeData: purge, selectedHomeContents: purge ? await stateEntries(plan, io) : [], credentialCandidates: refs, ownershipChecks: 'required before removal', globalNpm: 'only exact verified package/prefix', npxCache: 'preserved (npm-owned)' }, null, 2));
    return;
  }
  if ((hooks.uid ?? process.getuid)?.() === 0) throw new Error('Run uninstall as your normal user, without sudo');
  if (plan.platform === 'win32') await run('powershell.exe', psCommand("if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run uninstall without administrator elevation' }"));
  if (plan.platform === 'win32') {
    // dirs 6 obtains this via the native known-folder API, not LOCALAPPDATA overrides.
    const native = JSON.parse((await run('powershell.exe', psCommand("ConvertTo-Json -Compress -InputObject ([Environment]::GetFolderPath('LocalApplicationData'))"))).stdout);
    if (typeof native !== 'string' || !win32.isAbsolute(native) || /[\r\n\0]/.test(native)) throw new Error('Cannot establish native Chimera app cache path');
    plan.cache = win32.join(native, bundle);
    if (win32.parse(plan.cache).root.startsWith('\\\\') || equal(plan.cache, plan.home, plan.platform) || inside(plan.home, plan.cache, p)) throw new Error('Unsafe native Chimera app cache path');
    if (plan.preservedHomes.some(home => equal(plan.cache, home, plan.platform) || inside(plan.cache, home, p) || inside(home, plan.cache, p))) throw new Error('Native app cache overlaps preserved home');
    if (purge) await safePath(io, plan.cache, plan);
  }
  const catalog = await inventory(plan, manifest, io, run);
  const npm = hooks.npmCommand ?? (process.platform === 'win32' ? [process.execPath, [process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]] : ['npm', []]);
  const global = await globalPackage(manifest, io, run, npm, plan);
  const cache = (await run(npm[0], [...npm[1], 'config', 'get', 'cache'])).stdout.trim();
  if (!p.isAbsolute(cache) || /[\r\n\0]/.test(cache)) throw new Error('Cannot establish npm cache provenance');
  const credentials = purge ? await ownedCredentials(plan, io, run) : { remove: [], retain: [], unavailable: [] };
  if (purge) {
    await purgeTrees(plan, io, run);
    await prompt(plan, credentials, hooks, io);
  }
  // All stop checks precede removal. No PID kill, automatic daemon launch or foreign app quit.
  await desktopStopped(plan, io, run, (hooks.uid ?? process.getuid)?.());
  const Client = hooks.ChimeraClient ?? (await import(pathToFileURL(join(packageRoot, 'packages/client/src/client.js')).href)).ChimeraClient;
  const endpoint = plan.platform === 'win32' ? hooks.daemonEndpoint ?? (await import(pathToFileURL(join(packageRoot, 'packages/core/src/paths.js')).href)).daemonEndpoint : null;
  const alive = hooks.processAlive ?? (pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw new Error('Cannot determine daemon liveness'); } });
  const clients = await daemonClients(plan, [...catalog.roots, ...(global ? [global.dir] : [])], Client, io, alive, cache, manifest, run, endpoint);
  const stopping = new Map(clients.filter(({ pid }) => pid !== null).map(({ home, pid }) => [home, pid]));
  try {
    if (catalog.service && plan.platform === 'darwin') {
      const service = `gui/${(hooks.uid ?? process.getuid)()}/${label}`;
      let loaded = false; try { await run('/bin/launchctl', ['print', service]); loaded = true; } catch (e) { if (!/Could not find service|service not found/i.test(e.stderr ?? '')) throw new Error('Cannot establish launchd service state'); }
      if (loaded) await run('/bin/launchctl', ['bootout', service]);
    } else if (catalog.service && plan.platform === 'linux') await run('systemctl', ['--user', 'disable', '--now', 'chimerad.service']);
    // Windows startup is a plain shortcut; remove it only after every daemon has stopped.
    for (const { client } of clients) client.close();
    const active = await daemonClients(plan, [...catalog.roots, ...(global ? [global.dir] : [])], Client, io, alive, cache, manifest, run, endpoint, stopping);
    try { for (const { client } of active) if (client) await client.request('daemon.stop', {}); } finally { for (const { client } of active) client?.close(); }
  } finally { for (const { client } of clients) client.close(); }
  for (let attempt = 0; attempt < 50; attempt++) {
    const remaining = await daemonClients(plan, [...catalog.roots, ...(global ? [global.dir] : [])], Client, io, alive, cache, manifest, run, endpoint, stopping);
    for (const { client } of remaining) client?.close();
    if (!remaining.length) break;
    if (attempt === 49) throw new Error('Chimera daemon did not stop; payload and data retained');
    await (hooks.pause ?? (ms => new Promise(r => setTimeout(r, ms))))(200);
  }
  // Recheck after stop/confirmation to detect replaced targets before any removal.
  await inventory(plan, manifest, io, run);
  const currentGlobal = await globalPackage(manifest, io, run, npm, plan);
  if (JSON.stringify(currentGlobal) !== JSON.stringify(global)) throw new Error('Global npm ownership changed; no files removed');
  if (purge) {
    await purgeTrees(plan, io, run);
    const current = await ownedCredentials(plan, io, run);
    if (current.remove.some(ref => !credentials.remove.includes(ref))) throw new Error('Purge credential scope changed; no files removed');
    credentials.remove = current.remove; credentials.retain = current.retain; credentials.unavailable = current.unavailable;
  }
  const releasesRoot = p.join(plan.root, 'releases');
  const ordered = [...catalog.owned.filter(path => !inside(path, releasesRoot, p) && path !== plan.receipt), ...catalog.owned.filter(path => inside(path, releasesRoot, p)), ...catalog.owned.filter(path => path === plan.receipt)];
  for (const target of ordered) {
    await safePath(io, target, plan); await io.rm(target, { recursive: true, force: true });
  }
  if (catalog.service && plan.platform === 'linux') await run('systemctl', ['--user', 'daemon-reload']);
  if (global) await run(npm[0], [...npm[1], 'uninstall', '--global', '--prefix', global.prefix, '--ignore-scripts', '--no-audit', '--no-fund', manifest.name]);
  if (plan.platform === 'win32' && catalog.owned.some(path => plan.binPaths.includes(path))) await run('powershell.exe', psCommand(`$old=[Environment]::GetEnvironmentVariable('Path','User'); $next=($old -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ine ${psQuote(plan.bin)} }) -join ';'; [Environment]::SetEnvironmentVariable('Path',$next,'User')`));
  for (const dir of [p.join(plan.root, 'releases'), p.join(plan.root, 'desktop'), p.join(plan.root, 'bin'), plan.root]) if (await stat(io, dir)) { await safePath(io, dir, plan); await io.rmdir(dir); }
  if (purge) {
    const links = await purgeTrees(plan, io, run);
    for (const service of credentials.remove) { try { await run('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', 'chimera']); } catch (e) { if (e.code !== 44) throw new Error(`Owned credential removal failed: ${service}; data retained`); } }
    for (const link of links) {
      await safePath(io, p.dirname(link), plan);
      if (!(await stat(io, link))?.isSymbolicLink()) throw new Error(`Data link changed after validation: ${link}`);
      await io.unlink(link);
    }
    await io.rm(plan.cache, { recursive: true, force: true }); await io.rm(plan.state, { recursive: true, force: true });
  }
  log(`Chimera owned installation removed. ${purge ? `Selected data removed: ${plan.state}; shared app cache: ${plan.cache}.` : `Data and credentials preserved: ${plan.state}.`} ${plan.preservedHomes.length ? `Other homes preserved: ${plan.preservedHomes.join(', ')}.` : ''} ${credentials.retain.length ? `Shared credentials retained: ${credentials.retain.join(', ')}.` : ''} ${credentials.unavailable.length ? `Unsupported credential records retained: ${credentials.unavailable.join(', ')}.` : ''} Npx cache and external repositories/provider credentials preserved.`);
}
