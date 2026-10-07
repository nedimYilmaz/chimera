// Sign nested Mach-O code before Tauri seals the app. Never apply the webview host's
// entitlements to Node/Bun: their JIT engines need their own hardened-runtime grants.
import { open, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('macOS signing host required');
const identity = process.env.APPLE_SIGNING_IDENTITY;
if (!identity?.startsWith('Developer ID Application: ')) throw new Error('APPLE_SIGNING_IDENTITY must be a Developer ID Application identity');
const root = resolve(process.argv[2] ?? 'packages/app/src-tauri/standalone/runtime');
const temp = await mkdtemp(join(tmpdir(), 'chimera-runtime-sign-'));
const plist = keys => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${keys.map(key => `<key>${key}</key><true/>`).join('')}</dict></plist>`;
// Least privilege per binary. Each grant is the minimum that binary needs under the hardened runtime:
//  jit     V8/JavaScriptCore-style JITs (node, claude, Chrome headless shell).
//  python  loads wheels the app downloads at first use (Laya's torch), which are not signed by us, so
//          library validation must be off; ctypes/libffi closures need unsigned executable memory.
//  driver  exactly the entitlements cua-driver's own Developer ID signature carries (apple-events,
//          screen-capture). The TCC grants themselves belong to the Chimera app that hosts it.
const profiles = {
  jit: ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory'],
  python: ['com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.cs.disable-library-validation'],
  driver: ['com.apple.security.automation.apple-events', 'com.apple.security.device.screen-capture'],
};
const profileFor = name => {
  if (['node', 'claude', 'chrome-headless-shell'].includes(name)) return 'jit';
  if (/^python3(\.\d+)?$/.test(name)) return 'python';
  if (name === 'cua-driver') return 'driver';
  return null;
};
const entitlements = {};
for (const [name, keys] of Object.entries(profiles)) { entitlements[name] = join(temp, `${name}.plist`); await writeFile(entitlements[name], plist(keys)); }
let count = 0;
let signingKeychain;
const security = args => {
  try { return execFileSync('/usr/bin/security', args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error(`Runtime signing keychain operation failed: ${args[0]}`); }
};
// Tauri imports CI certificates only during its build. Nested runtime signing happens earlier,
// so use a private keychain here; never import release keys into the builder's login keychain.
const keychains = process.env.APPLE_CERTIFICATE
  ? [...security(['list-keychains', '-d', 'user']).toString().matchAll(/"([^"\n]+)"/g)].map(m => m[1]) : null;
async function prepareKeychain() {
  if (!process.env.APPLE_CERTIFICATE) return;
  if (!process.env.APPLE_CERTIFICATE_PASSWORD) throw new Error('APPLE_CERTIFICATE_PASSWORD is required');
  const certificate = join(temp, 'identity.p12');
  await writeFile(certificate, Buffer.from(process.env.APPLE_CERTIFICATE, 'base64'), { mode: 0o600 });
  signingKeychain = join(temp, 'runtime.keychain-db');
  const password = randomBytes(32).toString('hex');
  security(['create-keychain', '-p', password, signingKeychain]);
  security(['unlock-keychain', '-p', password, signingKeychain]);
  security(['import', certificate, '-k', signingKeychain, '-P', process.env.APPLE_CERTIFICATE_PASSWORD, '-T', '/usr/bin/codesign']);
  security(['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, signingKeychain]);
}

async function sign(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { await sign(path); continue; }
    if (!entry.isFile()) continue;
    const fd = await open(path, 'r');
    const magic = Buffer.alloc(4);
    try { await fd.read(magic, 0, 4, 0); } finally { await fd.close(); }
    if (!['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic.toString('hex'))) continue;
    const args = ['--force', '--sign', identity, '--timestamp', '--options', 'runtime'];
    if (signingKeychain) args.push('--keychain', signingKeychain);
    const profile = profileFor(basename(path));
    if (profile) args.push('--entitlements', entitlements[profile]);
    execFileSync('/usr/bin/codesign', [...args, path], { stdio: ['ignore', 'ignore', 'pipe'] });
    count++;
  }
}
try { await prepareKeychain(); await sign(root); console.log(`Signed ${count} embedded Mach-O files`); }
finally {
  try { if (signingKeychain) security(['delete-keychain', signingKeychain]); }
  finally {
    try { if (keychains) security(['list-keychains', '-d', 'user', '-s', ...keychains]); }
    finally { await rm(temp, { recursive: true, force: true }); }
  }
}
