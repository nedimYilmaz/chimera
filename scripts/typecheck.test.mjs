import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, 'scripts/typecheck.mjs');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'chimera typecheck '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  write('package.json', '{"type":"module"}');
  write('packages/.keep', '');
  write('scripts/.keep', '');
  copyFileSync(script, join(dir, 'scripts/typecheck.mjs'));
  const compiler = (status = 0) => {
    write('node_modules/typescript/package.json', '{"name":"typescript"}');
    write('node_modules/typescript/bin/tsc', `
      require('node:fs').writeFileSync('invocation.json', JSON.stringify({
        argv: process.argv.slice(2), cwd: process.cwd()
      }));
      process.exit(${status});
    `);
  };
  const run = () => spawnSync(process.execPath, [join(dir, 'scripts/typecheck.mjs')], {
    // Invoking outside the repository must still resolve that repository's projects/compiler.
    cwd: tmpdir(), encoding: 'utf8',
  });
  return { dir, write, compiler, run };
}

test('discovers every immediate package project with spaces, omitting non-projects and nested fixtures', t => {
  const f = fixture(t);
  for (const name of ['z-new-package', 'app', 'a package with spaces']) {
    f.write(`packages/${name}/tsconfig.json`, '{}');
  }
  f.write('packages/no-config/package.json', '{}');
  f.write('packages/no-config/fixture/tsconfig.json', '{}');
  f.write('packages/not-a-directory', '');
  f.compiler();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'invocation.json'), 'utf8')), {
    argv: ['-b', join('packages', 'a package with spaces', 'tsconfig.json'),
      join('packages', 'app', 'tsconfig.json'), join('packages', 'z-new-package', 'tsconfig.json')],
    cwd: realpathSync(f.dir),
  });
});

test('preserves a real compiler subprocess failure exit status', t => {
  const f = fixture(t);
  f.write('packages/app/tsconfig.json', '{}');
  f.compiler(7);
  assert.equal(f.run().status, 7);
});

test('empty project discovery fails visibly', t => {
  const f = fixture(t);
  f.compiler();
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No package tsconfig.json projects found/);
});

test('missing TypeScript compiler fails visibly', t => {
  const f = fixture(t);
  f.write('packages/app/tsconfig.json', '{}');
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot find module 'typescript\/bin\/tsc'/);
});

test('literal glob reproduces TS5083 without depending on the host shell', () => {
  const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [compiler, '-b', 'packages/*/tsconfig.json'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /TS5083/);
});

const workflow = readFileSync(join(root, '.github/workflows/verify.yml'), 'utf8');
const commands = [
  'pnpm typecheck',
  'pnpm --filter @chimera/app build',
  'cargo test --manifest-path packages/app/src-tauri/Cargo.toml --locked',
];

function requiredNativeCommands(text) {
  const steps = text.split(/^      - /m).slice(1);
  const native = steps.filter(step => commands.some(command => step.includes(command)));
  assert.equal(native.length, 3, 'native commands must be separate required steps');
  return native.map((step, index) => {
    assert.match(step, /^name: Native /);
    assert.match(step, /^        if: inputs\.native_build$/m);
    assert.doesNotMatch(step, /continue-on-error|always\(|failure\(/);
    const runs = [...step.matchAll(/^        run: (.+)$/gm)];
    assert.deepEqual(runs.map(match => match[1]), [commands[index]]);
    return runs[0][1];
  });
}

test('workflow runs portable regressions and gates each native command on prior success', () => {
  assert.match(workflow, /^        run: node --test scripts\/typecheck\.test\.mjs$/m);
  assert.deepEqual(requiredNativeCommands(workflow), commands);
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.typecheck,
    'node scripts/typecheck.mjs');
});

test('workflow guard rejects the old multiline block and error suppression', () => {
  assert.throws(() => requiredNativeCommands(`      - name: Native verification
        if: inputs.native_build
        run: |
          ${commands.join('\n          ')}
  `));
  assert.throws(() => requiredNativeCommands(workflow.replace(
    'run: pnpm typecheck', 'continue-on-error: true\n        run: pnpm typecheck')));
});

test('injected native failures stop later steps and cannot be masked by a later success', () => {
  const native = requiredNativeCommands(workflow);
  // This models GitHub's default success dependency using real child exit codes;
  // hosted Windows remains the authority for PowerShell and native compilation.
  for (const failure of [-1, 0, 1, 2]) {
    const invoked = [];
    let status = 0;
    for (const [index, command] of native.entries()) {
      invoked.push(command);
      status = spawnSync(process.execPath, ['-e', `process.exit(${index === failure ? 9 : 0})`]).status;
      if (status !== 0) break;
    }
    assert.equal(status, failure === -1 ? 0 : 9);
    assert.deepEqual(invoked, commands.slice(0, failure === -1 ? 3 : failure + 1));
  }
  // Red control: the former block kept running native commands after the injected failure.
  let maskedStatus;
  for (const index of [0, 1, 2]) {
    maskedStatus = spawnSync(process.execPath, ['-e', `process.exit(${index === 0 ? 9 : 0})`]).status;
  }
  assert.equal(maskedStatus, 0);
});
