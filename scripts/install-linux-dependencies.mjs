#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const packages = ['libwebkit2gtk-4.1-dev', 'build-essential', 'libxdo-dev', 'libssl-dev',
  'librsvg2-dev', 'libayatana-appindicator3-dev', 'patchelf', 'xdg-utils', 'squashfs-tools'];
const mirrors = {
  amd64: ['https://archive.ubuntu.com/ubuntu', 'https://mirrors.edge.kernel.org/ubuntu'],
  arm64: ['https://ports.ubuntu.com/ubuntu-ports', 'https://mirrors.ocf.berkeley.edu/ubuntu-ports'],
};

// Keep the runner's sources untouched. Every mirror must pass Ubuntu's existing archive
// keyring and freshness checks; changing a download host never changes package trust.
export function installLinuxDependencies({ arch, codename, run = spawnSync, temporaryRoot = tmpdir() }) {
  if (!Object.hasOwn(mirrors, arch) || !['jammy', 'noble'].includes(codename)) {
    throw new Error(`Unsupported Ubuntu release/architecture: ${codename}/${arch}`);
  }
  const directory = mkdtempSync(join(temporaryRoot, 'chimera-apt-'));
  chmodSync(directory, 0o755);
  try {
    for (const [index, mirror] of mirrors[arch].entries()) {
      console.log(`Installing Linux prerequisites from ${mirror}`);
      const lists = join(directory, `lists-${index}`);
      mkdirSync(lists);
      const source = join(directory, 'ubuntu.list');
      writeFileSync(source, ['', '-updates', '-security', '-backports'].map(suffix =>
        `deb [arch=${arch} signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] ${mirror} ${codename}${suffix} main restricted universe multiverse\n`).join(''));
      const options = ['-o', `Dir::Etc::sourcelist=${source}`, '-o', 'Dir::Etc::sourceparts=-',
        '-o', `Dir::State::lists=${lists}`, '-o', 'APT::Update::Error-Mode=any',
        '-o', 'Acquire::Retries=0', '-o', 'Acquire::http::Timeout=15', '-o', 'Acquire::https::Timeout=15'];
      const invoke = (args, timeout) => run('apt-get', [...options, ...args], {
        stdio: 'inherit', env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
        ...(timeout ? { timeout } : {}),
      }).status === 0;
      if (!invoke(['update'], 90_000)) continue;
      // Download separately: a timeout may stop network I/O but must never interrupt dpkg
      // halfway through configuring packages. Only network phases can switch mirrors.
      if (!invoke(['install', '--download-only', '-y', ...packages], 480_000)) continue;
      if (!invoke(['install', '--no-download', '-y', ...packages])) {
        throw new Error('Linux prerequisite installation failed after verified downloads');
      }
      return;
    }
    throw new Error('All Ubuntu mirrors failed; refusing to build without verified prerequisites');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error('Run this CI prerequisite installer as root on Ubuntu');
  }
  const release = Object.fromEntries(readFileSync('/etc/os-release', 'utf8').split('\n')
    .filter(line => /^[A-Z_]+=/.test(line)).map(line => {
      const equal = line.indexOf('=');
      return [line.slice(0, equal), line.slice(equal + 1).replace(/^"|"$/g, '')];
    }));
  if (release.ID !== 'ubuntu') throw new Error('This installer supports Ubuntu only');
  const arch = spawnSync('dpkg', ['--print-architecture'], { encoding: 'utf8' });
  if (arch.status !== 0) throw new Error('Could not determine Debian architecture');
  installLinuxDependencies({ arch: arch.stdout.trim(), codename: release.VERSION_CODENAME });
}
