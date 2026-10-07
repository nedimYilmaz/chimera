// Give native outputs the exact version/architecture names selected by the shared installer.
import { readFile, copyFile, mkdir, readdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { installPlan } from './npm-install.mjs';
import { verifyNativeHeader, verifyWindowsSignature, psCommand } from './npm-install-platforms.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform === 'darwin') {
  await import('./package-macos-release.mjs');
} else {
  const manifest = JSON.parse(await readFile(join(root, 'dist/npm/package.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(root, 'packages/app/src-tauri/tauri.conf.json'), 'utf8'));
  if (manifest.version !== config.version) throw new Error('Tauri and npm package versions must match');
  const plan = installPlan(manifest);
  const build = join(root, 'packages/app/src-tauri/target/release');
  let source = process.argv[2] && resolve(process.argv[2]);
  if (!source) {
    if (process.platform === 'win32') source = join(build, 'chimera-app.exe');
    else {
      const files = (await readdir(join(build, 'bundle/appimage'))).filter(f => f.endsWith('.AppImage') && f.includes(`_${manifest.version}_`));
      if (files.length !== 1) throw new Error('Pass the exact freshly built AppImage path; output directory is missing or ambiguous');
      source = join(build, 'bundle/appimage', files[0]);
    }
  }
  const bytes = await readFile(source);
  verifyNativeHeader(bytes, process.platform, process.arch);
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', psCommand(verifyWindowsSignature(source, plan.windowsPublisherThumbprint)), { stdio: 'inherit' });
    const { psQuote } = await import('./npm-install-platforms.mjs');
    execFileSync('powershell.exe', psCommand(`if ((Get-Item -LiteralPath ${psQuote(source)}).VersionInfo.ProductVersion -ne ${psQuote(plan.version)}) { throw 'Built app version mismatch' }`), { stdio: 'inherit' });
  } else if (!basename(source).includes(`_${manifest.version}_`)) {
    throw new Error('AppImage filename must contain the matching Tauri release version');
  }
  if (process.platform === 'linux') {
    // Verify the final repacked resources outside their AppDir.
    // The npm installer copies this same runtime to a permanent, independently located daemon.
    const temp = await mkdtemp(join(tmpdir(), 'chimera-packaged-runtime-'));
    try {
      execFileSync(source, ['--appimage-extract'], { cwd: temp, stdio: 'ignore', timeout: 180_000 });
      const resources = join(temp, 'squashfs-root/usr/lib/chimera/runtime');
      const runtime = JSON.parse(await readFile(join(resources, 'runtime.json'), 'utf8'));
      if (runtime.version !== manifest.version || runtime.platform !== process.platform || runtime.arch !== process.arch) throw new Error('Packaged runtime version/target mismatch');
      execFileSync(process.execPath, [join(root, 'scripts/test-desktop-runtime.mjs'), resources], { stdio: 'inherit', timeout: 180_000 });
    } finally { await rm(temp, {recursive:true,force:true}); }
  }
  await mkdir(join(root, 'dist'), { recursive: true });
  const artifact = join(root, 'dist', plan.asset);
  await copyFile(source, artifact);
  console.log(artifact);
  console.log('Generate SHA256SUMS with scripts/release-checksums.mjs for all release assets.');
}
