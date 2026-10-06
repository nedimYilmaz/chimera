// These checks use only Node and the host tar tool, never the repository build or npm dependencies.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';

function runArchiveTar(artifact, dir, create, { env, run = execFileSync } = {}) {
  // GNU tar treats a drive-letter archive filename as a remote host. Node opens
  // the exact file; both GNU and BSD tar use '-' for the inherited byte stream.
  const fd = openSync(resolve(artifact), create ? 'w' : 'r');
  try {
    run('tar', [create ? '-czf' : '-xzf', '-', ...(create ? ['package'] : [])],
      { cwd: resolve(dir), env, stdio: create ? ['ignore', fd, 'pipe'] : [fd, 'pipe', 'pipe'] });
  } finally { closeSync(fd); }
}

export function extractPackedArtifact(artifact, dir, options) {
  runArchiveTar(artifact, dir, false, options);
}

export function createPackedArtifact(artifact, dir, options) {
  runArchiveTar(artifact, dir, true, options);
}

export async function checkPackedInstaller(artifact) {
  assert.ok(artifact?.endsWith('.tgz'), 'A packed npm artifact is required');
  const dir = await mkdtemp(join(tmpdir(), 'chimera-packed-installer-test-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('CHIMERA_') && !['NODE_OPTIONS', 'NODE_PATH', 'XDG_DATA_HOME'].includes(key)));
  env.HOME = env.USERPROFILE = join(dir, 'home');
  env.LOCALAPPDATA = join(env.HOME, 'AppData', 'Local');
  env.APPDATA = join(env.HOME, 'AppData', 'Roaming');
  try {
    extractPackedArtifact(artifact, dir, { env });
    const base = join(dir, 'package');
    const manifest = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'));
    // Plain npm installation must not start a desktop installation, including with --global.
    assert.equal(manifest.scripts, undefined);
    for (const file of ['npm-install.mjs', 'npm-install-portable.mjs', 'npm-install-platforms.mjs']) {
      await lstat(join(base, 'scripts', file));
    }
    assert.match(await readFile(join(base, 'scripts/npm-install.mjs'), 'utf8'), /NSWorkspace/);
    // A dry-run that attempts a release download must fail, even on a networked runner.
    const guard = join(dir, 'offline.mjs');
    await writeFile(guard, `import http from 'node:http';\nimport https from 'node:https';\nconst blocked = () => { throw new Error('Packed installer must remain offline'); };\nglobalThis.fetch = blocked;\nhttp.get = http.request = https.get = https.request = blocked;\n`);
    const cli = join(base, manifest.bin.chimera);
    const run = args => execFileSync(process.execPath, ['--import', pathToFileURL(guard).href, cli, ...args],
      { cwd: dir, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(run(['--version']).trim(), manifest.version);
    const plan = JSON.parse(run(['install', '--dry-run']));
    assert.equal(plan.version, manifest.version);
    assert.ok(plan.download.includes(`/v${manifest.version}/`));
    assert.equal(plan.home, env.HOME);
    for (const path of [plan.app, plan.root, plan.bin, plan.state, plan.plist ?? plan.serviceFile, plan.shortcut].filter(Boolean)) {
      await assert.rejects(lstat(path), { code: 'ENOENT' });
    }
    return { name: manifest.name, version: manifest.version, platform: plan.platform };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
