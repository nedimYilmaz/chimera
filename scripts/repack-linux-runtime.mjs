// linuxdeploy must finish dependency rewriting before opaque provider runtimes are added.
import {cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {homedir, tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

export async function runtimeInventory(root) {
  const entries = [];
  async function walk(relative) {
    const path = join(root, relative), stat = await lstat(path);
    if (stat.isSymbolicLink()) entries.push([relative, 'link', await readlink(path)]);
    else if (stat.isDirectory()) {
      entries.push([relative, 'dir', stat.mode & 0o777]);
      for (const name of (await readdir(path)).sort()) await walk(join(relative, name));
    } else if (stat.isFile()) entries.push([relative, 'file', stat.mode & 0o777, createHash('sha256').update(await readFile(path)).digest('hex')]);
    else throw new Error('Unsupported runtime filesystem entry');
  }
  await walk('');
  return JSON.stringify(entries);
}

export async function repackLinuxRuntime({source, runtime, plugin, version, arch = process.arch, run = execFileSync}) {
  for (const path of [source, plugin]) {
    const stat = await lstat(path);
    if (!stat.isFile() || !(stat.mode & 0o111)) throw new Error('AppImage and packaging plugin must be regular executables');
  }
  const metadata = JSON.parse(await readFile(join(runtime, 'runtime.json'), 'utf8'));
  if (metadata.version !== version || metadata.platform !== 'linux' || metadata.arch !== arch) throw new Error('Runtime version/target mismatch');
  const before = await runtimeInventory(runtime);
  const temp = await mkdtemp(join(tmpdir(), 'chimera-appimage-runtime-'));
  try {
    const thin = join(temp, 'thin'), verify = join(temp, 'verify');
    await mkdir(thin); await mkdir(verify);
    await run(source, ['--appimage-extract'], {cwd: thin, stdio: 'ignore', timeout: 180_000});
    const appDir = join(thin, 'squashfs-root'), destination = join(appDir, 'usr/lib/chimera/runtime');
    try { await lstat(destination); throw new Error('Thin AppImage already contains a runtime'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(destination), {recursive: true});
    await cp(runtime, destination, {recursive: true, dereference: false, verbatimSymlinks: true});
    const output = join(temp, 'complete.AppImage');
    // This is Tauri's already downloaded output plugin, not linuxdeploy or its GTK plugin.
    await run(plugin, ['--appimage-extract-and-run', '--appdir', appDir], {
      cwd: temp, stdio: 'inherit', timeout: 900_000,
      env: {...process.env, APPIMAGE_EXTRACT_AND_RUN: '1', ARCH: arch === 'arm64' ? 'aarch64' : 'x86_64', LDAI_OUTPUT: output, LDAI_VERSION: version},
    });
    // The type2 runtime's --appimage-extract creates every directory as 0700,
    // regardless of its archived mode. Read the actual SquashFS metadata instead
    // of weakening the mode check or attributing that extractor change to packing.
    const offsetText = String(await run(output, ['--appimage-offset'], {encoding: 'utf8', stdio: 'pipe', timeout: 30_000})).trim();
    const offset = Number(offsetText);
    if (!/^[1-9]\d*$/.test(offsetText) || !Number.isSafeInteger(offset) || offset >= (await lstat(output)).size) throw new Error('Invalid AppImage filesystem offset');
    await run('unsquashfs', ['-no-progress', '-offset', offsetText, '-dest', join(verify, 'squashfs-root'), output, 'usr/lib/chimera/runtime'], {stdio: 'ignore', timeout: 180_000});
    if (await runtimeInventory(join(verify, 'squashfs-root/usr/lib/chimera/runtime')) !== before) throw new Error('Packaged runtime bytes, modes or links changed');
    // Keep the original artifact on any packing or verification failure.
    const replacement = source + '.complete';
    try { await cp(output, replacement); await rename(replacement, source); }
    finally { await rm(replacement, {force: true}); }
    console.log('AppImage runtime bytes, modes and links preserved');
  } finally { await rm(temp, {recursive: true, force: true}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'linux') throw new Error('Linux packaging host required');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const {version} = JSON.parse(await readFile(join(root, 'dist/npm/package.json'), 'utf8'));
  const directory = join(root, 'packages/app/src-tauri/target/release/bundle/appimage');
  const names = (await readdir(directory)).filter(name => name.endsWith('.AppImage') && name.includes(`_${version}_`));
  if (names.length !== 1) throw new Error('Expected exactly one freshly built thin AppImage');
  await repackLinuxRuntime({source: join(directory, names[0]), version,
    runtime: join(root, 'packages/app/src-tauri/standalone/runtime'),
    plugin: join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'tauri/linuxdeploy-plugin-appimage.AppImage')});
}
