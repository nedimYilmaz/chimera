// Sign nested Mach-O code before Tauri seals the app. Never apply the webview host's
// entitlements to Node/Bun: their JIT engines need their own hardened-runtime grants.
import { open, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('macOS signing host required');
const identity = process.env.APPLE_SIGNING_IDENTITY;
if (!identity?.startsWith('Developer ID Application: ')) throw new Error('APPLE_SIGNING_IDENTITY must be a Developer ID Application identity');
const root = resolve(process.argv[2] ?? 'packages/app/src-tauri/standalone/runtime');
const temp = await mkdtemp(join(tmpdir(), 'chimera-runtime-sign-'));
const entitlements = join(temp, 'jit.plist');
await writeFile(entitlements, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>');
let count = 0;
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
    if (['node', 'claude'].includes(basename(path))) args.push('--entitlements', entitlements);
    execFileSync('/usr/bin/codesign', [...args, path], { stdio: ['ignore', 'ignore', 'pipe'] });
    count++;
  }
}
try { await sign(root); console.log(`Signed ${count} embedded Mach-O files`); }
finally { await rm(temp, { recursive: true, force: true }); }
