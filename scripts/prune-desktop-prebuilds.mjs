import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

// These packages distribute Bare addons for every OS in one npm tarball. linuxdeploy scans
// all ELF resources and aborts on Android's ABI; a native desktop ships only its own prebuild.
export async function pruneDesktopPrebuilds(root, platform, arch) {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported runtime prebuild target');
  const target = `${platform}-${arch}`, removed = [];
  for (const name of ['bare-fs', 'bare-path', 'bare-url']) {
    const dir = join(root, 'node_modules', name, 'prebuilds');
    const entries = await readdir(dir, {withFileTypes:true}).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!entries) continue;
    if (!entries.some(entry => entry.name === target && entry.isDirectory())) throw new Error(`${name} is missing the ${target} prebuild`);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^(android|darwin|ios|linux|win32)-(arm|arm64|ia32|x64)(-simulator)?$/.test(entry.name)) throw new Error(`Unreviewed ${name} prebuild layout: ${entry.name}`);
    }
    for (const entry of entries) if (entry.name !== target) {
      await rm(join(dir, entry.name), {recursive:true});
      removed.push(`${name}/${entry.name}`);
    }
  }
  return removed;
}
