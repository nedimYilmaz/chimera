import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPackedInstaller, extractPackedArtifact, createPackedArtifact } from './npm-packed-checks.mjs';

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
      extractPackedArtifact(artifact, dir);
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
      createPackedArtifact(broken, dir);
      await assert.rejects(checkPackedInstaller(broken), error => {
        if (defect === 'network') assert.match(error.stderr.toString(), /must remain offline/);
        else assert.equal(error.code, 'ERR_ASSERTION');
        return true;
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('archive streams round-trip through host tar with spaces and preserve candidate bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chimera packed archive '));
  const before = await readFile(artifact);
  try {
    const source = join(dir, 'source space'), target = join(dir, 'target space');
    await mkdir(source);
    await mkdir(target);
    // On POSIX a literal drive-colon name also exercises GNU tar's remote-host syntax.
    const copy = join(dir, process.platform === 'win32' ? 'input space.tgz' : 'D:\\input space.tgz');
    const output = join(dir, process.platform === 'win32' ? 'output space.tgz' : 'D:\\output space.tgz');
    await copyFile(artifact, copy);
    extractPackedArtifact(copy, source);
    createPackedArtifact(output, source);
    extractPackedArtifact(output, target);
    for (const path of ['package.json', 'scripts/npm-install.mjs', 'scripts/npm-install-portable.mjs', 'scripts/npm-install-platforms.mjs']) {
      assert.deepEqual(await readFile(join(target, 'package', path)), await readFile(join(source, 'package', path)));
    }
    assert.deepEqual(await readFile(copy), before);
    assert.deepEqual(await readFile(artifact), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const create of [false, true]) {
  test(`archive ${create ? 'creation' : 'extraction'} closes descriptors on success and propagates failures`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chimera packed argv '));
    try {
      const archive = join(dir, 'archive space.tgz');
      const destination = relative(process.cwd(), dir);
      await writeFile(archive, 'test bytes');
      const env = { PATH: process.env.PATH };
      const failure = Object.assign(new Error('tar failed'), { status: 128, stderr: Buffer.from('tar stderr') });
      for (const error of [undefined, failure, Object.assign(new Error('spawn failed'), { code: 'ENOENT' })]) {
        let fd, calls = 0;
        const run = (command, args, options) => {
          calls++;
          assert.equal(command, 'tar');
          assert.deepEqual(args, [create ? '-czf' : '-xzf', '-', ...(create ? ['package'] : [])]);
          assert.equal(options.cwd, dir);
          assert.equal(options.env, env);
          fd = options.stdio[create ? 1 : 0];
          assert.equal(typeof fd, 'number');
          assert.ok(fstatSync(fd).isFile());
          assert.deepEqual(options.stdio, create ? ['ignore', fd, 'pipe'] : [fd, 'pipe', 'pipe']);
          if (error) throw error;
        };
        const invoke = () => (create ? createPackedArtifact : extractPackedArtifact)(archive, destination, { env, run });
        if (error) assert.throws(invoke, caught => caught === error);
        else invoke();
        assert.equal(calls, 1);
        assert.throws(() => fstatSync(fd), { code: 'EBADF' });
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('packed checks reject missing input and host tar rejects malformed archives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chimera-packed-invalid-'));
  try {
    await assert.rejects(checkPackedInstaller(), /packed npm artifact is required/);
    await assert.rejects(checkPackedInstaller(join(dir, 'missing.tgz')), { code: 'ENOENT' });
    const invalid = join(dir, 'invalid.tgz');
    await writeFile(invalid, 'not a gzip archive');
    assert.throws(() => extractPackedArtifact(invalid, dir), error => error.status !== 0 && error.stderr.length > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
