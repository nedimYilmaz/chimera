import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { checkPackedInstaller } from './npm-packed-checks.mjs';

const artifact = process.env.CHIMERA_NPM_ARTIFACT;
assert.ok(artifact?.endsWith('.tgz'), 'Set CHIMERA_NPM_ARTIFACT to the downloaded tarball; no build fallback');

test('downloaded npm artifact has no desktop lifecycle hook and an offline dry-run', async () => {
  const result = await checkPackedInstaller(artifact);
  assert.equal(result.platform, process.platform);
  console.log(`PASS downloaded artifact ${result.name}@${result.version} (${result.platform})`);
});

for (const defect of ['lifecycle', 'version', 'network']) {
  test(`packed installer checks reject a ${defect} regression`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chimera-packed-negative-'));
    try {
      // Mutate a private copy; the candidate used by all smoke checks remains untouched.
      execFileSync('tar', ['-xzf', resolve(artifact), '-C', dir]);
      const base = join(dir, 'package'), path = join(base, 'package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      if (defect === 'lifecycle') manifest.scripts = { postinstall: 'node desktop-install.js' };
      if (defect === 'version') manifest.version = '999.0.0';
      await writeFile(path, JSON.stringify(manifest));
      if (defect === 'network') {
        const cli = join(base, manifest.bin.chimera);
        const source = await readFile(cli, 'utf8');
        await writeFile(cli, source.replace(/^(#![^\n]*\n)/, "$1if (process.argv.includes('--dry-run')) await fetch('https://test.invalid/release');\n"));
      }
      const broken = join(dir, 'broken.tgz');
      execFileSync('tar', ['-czf', broken, '-C', dir, 'package']);
      await assert.rejects(checkPackedInstaller(broken), error => {
        if (defect === 'network') assert.match(error.stderr.toString(), /must remain offline/);
        else assert.equal(error.code, 'ERR_ASSERTION');
        return true;
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
