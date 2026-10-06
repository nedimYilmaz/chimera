// Build coverage belongs in the package job, where repository dependencies are installed.
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { checkPackedInstaller } from './npm-packed-checks.mjs';

test('repository build packs an offline CLI without desktop lifecycle hooks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chimera-npm-build-test-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('CHIMERA_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
  env.HOME = join(dir, 'home');
  try {
    execFileSync(process.execPath, [join(root, 'scripts/build-npm.mjs')], { cwd: root, env });
    const packed = JSON.parse(execFileSync('npm', ['pack', join(root, 'dist/npm'), '--offline', '--ignore-scripts', '--json', '--pack-destination', dir], { env, encoding: 'utf8' }));
    await checkPackedInstaller(join(dir, packed[0].filename));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
