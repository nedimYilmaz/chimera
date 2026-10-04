// A native installer, not an npm bootstrap: no developer tools are needed on the user's PC.
import { execFileSync } from 'node:child_process';
import { readdir, stat, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'packages/app');
const output = join(root, 'dist/standalone');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit', timeout: 3_600_000 });
if (process.platform === 'darwin' && (!process.env.APPLE_SIGNING_IDENTITY?.startsWith('Developer ID Application: ') || !process.env.APPLE_KEYCHAIN_PROFILE)) {
  throw new Error('Set APPLE_SIGNING_IDENTITY and APPLE_KEYCHAIN_PROFILE (notarytool credentials) before building a macOS release.');
}
run(process.execPath, ['scripts/build-desktop-runtime.mjs']);
run(process.execPath, ['scripts/test-desktop-runtime.mjs']);
if (process.platform === 'darwin') run(process.execPath, ['scripts/sign-desktop-runtime.mjs']);
const started = Date.now();
const tauri = join(app, 'node_modules/@tauri-apps/cli/tauri.js');
const bundles = process.platform === 'darwin' ? 'dmg' : process.platform === 'win32' ? 'nsis' : 'appimage,deb,rpm';
run(process.execPath, [tauri, 'build', '--config', 'src-tauri/tauri.standalone.conf.json', '--bundles', bundles], app);
const bundle = join(app, 'src-tauri/target/release/bundle');
await mkdir(output, { recursive: true });
const artifacts = [];
for (const [dir, extension] of (process.platform === 'darwin' ? [['dmg', '.dmg']] : process.platform === 'win32' ? [['nsis', '.exe']] : [['appimage', '.AppImage'], ['deb', '.deb'], ['rpm', '.rpm']])) {
  for (const name of await readdir(join(bundle, dir))) {
    const path = join(bundle, dir, name);
    if (!name.endsWith(extension) || (await stat(path)).mtimeMs < started) continue;
    if (process.platform === 'darwin') {
      run('xcrun', ['notarytool', 'submit', path, '--keychain-profile', process.env.APPLE_KEYCHAIN_PROFILE, '--wait']);
      run('xcrun', ['stapler', 'staple', path]);
      run('xcrun', ['stapler', 'validate', path]);
      run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', path]);
    }
    const target = join(output, name);
    await copyFile(path, target);
    const sha256 = createHash('sha256').update(await readFile(target)).digest('hex');
    artifacts.push({ name, sha256 });
  }
}
if (!artifacts.length) throw new Error('No fresh installer produced');
await writeFile(join(output, `SHA256SUMS-${process.platform}-${process.arch}`), artifacts.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n');
console.log(`Standalone installers: ${output}`);
if (process.platform === 'win32') console.log('Windows release candidates require Authenticode verification before public distribution.');
