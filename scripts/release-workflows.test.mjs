import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const cacheAction = 'actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809';
const cacheKey = "pnpm-store-v1-${{ runner.os }}-${{ runner.arch }}-node-${{ steps.node.outputs.node-version }}-pnpm-11.11.0-${{ hashFiles('pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/**') }}";

// These are bounded contracts for the three owned files, not a general YAML interpreter.
function steps(text, indent) {
  const starts = [...text.matchAll(new RegExp(`^ {${indent}}- `, 'gm'))];
  return starts.map((match, index) => text.slice(match.index, starts[index + 1]?.index));
}

function scalar(step, field, indent) {
  return step.match(new RegExp(`^(?: {${indent}}- | {${indent + 2}})${field}: (.+)$`, 'm'))?.[1];
}

function named(text, name, indent = 6) {
  const found = steps(text, indent).filter(step => scalar(step, 'name', indent) === name);
  assert.equal(found.length, 1, name);
  return found[0];
}

function required(step, indent) {
  assert.equal(scalar(step, 'if', indent), undefined, 'step must run on hits and misses, on every OS');
  assert.doesNotMatch(step, /continue-on-error/);
}

function trusted(expression) {
  assert.ok(expression, 'cache needs an explicit trust boundary');
  // Evaluate the workflow's actual Boolean expression against both PR event types, including
  // PR-target's base ref; GitHub cache scoping alone must not be our security contract.
  for (const event_name of ['push', 'workflow_dispatch', 'pull_request', 'pull_request_target']) {
    for (const ref of ['refs/heads/main', 'refs/tags/v0.1.2', 'refs/heads/feature', 'refs/pull/7/merge']) {
      const actual = runInNewContext(expression, {
        github: { event_name, ref }, startsWith: (value, prefix) => value.startsWith(prefix),
      }, { timeout: 100 });
      const expected = !event_name.startsWith('pull_request') &&
        (ref === 'refs/heads/main' || ref.startsWith('refs/tags/v'));
      assert.equal(actual, expected, `${event_name} ${ref}`);
    }
  }
}

function cacheContract(text, indent) {
  const all = steps(text, indent);
  const node = all.findIndex(step => step.includes('uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'));
  const pnpm = all.findIndex(step => scalar(step, 'run', indent) === 'npm install --global pnpm@11.11.0');
  const locate = all.findIndex(step => scalar(step, 'id', indent) === 'pnpm-store');
  const cache = all.findIndex(step => step.includes(`uses: ${cacheAction}`));
  const install = all.findIndex(step => scalar(step, 'run', indent) === 'pnpm install --frozen-lockfile');
  assert.ok(node >= 0 && node < pnpm && pnpm < locate && locate < cache && cache < install,
    'Node then pnpm then discovered store/cache then required frozen install');
  assert.equal(scalar(all[node], 'id', indent), 'node');
  assert.equal(scalar(all[node], 'node-version', indent + 2), "'24'");
  required(all[pnpm], indent);
  required(all[install], indent);
  assert.equal(scalar(all[locate], 'shell', indent), 'bash');
  assert.match(all[locate], /store_path=\$\(pnpm store path --silent\)\n/);
  assert.match(all[locate], /echo "path=\$store_path" >> "\$GITHUB_OUTPUT"/);
  trusted(scalar(all[locate], 'if', indent));
  trusted(scalar(all[cache], 'if', indent));
  assert.equal(scalar(all[cache], 'path', indent + 2), '${{ steps.pnpm-store.outputs.path }}', 'cache only the discovered content store');
  assert.equal(scalar(all[cache], 'key', indent + 2), cacheKey, 'cache key must preserve exact identity');
  assert.doesNotMatch(all[cache], /restore-keys|enableCrossOsArchive|continue-on-error/, 'cache must not use fallback or suppress errors');
  assert.equal(all.filter(step => /uses: actions\/cache/.test(step)).length, 1);
  assert.doesNotMatch(all[node], /\n\s+cache:/);
}

// Force both checkout styles before normalizing at the contract-input boundary. Canonical
// newlines keep literal mutations meaningful on Windows without relaxing any assertions.
function workflowInput(path, lineEnding) {
  const raw = read(path).replace(/\r?\n/g, lineEnding);
  assert.equal(raw.includes('\r\n'), lineEnding === '\r\n');
  return raw.replace(/\r\n/g, '\n');
}

for (const [label, lineEnding] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  const verify = workflowInput('.github/workflows/verify.yml', lineEnding);
  const npm = workflowInput('.github/workflows/npm-package.yml', lineEnding);
  const native = workflowInput('.github/actions/release-build-setup/action.yml', lineEnding);
  const packageJob = npm.split(/^  smoke:/m)[0];
  const smokeJob = npm.split(/^  smoke:/m)[1];

  for (const [name, text, indent] of [['Verify', verify, 6], ['npm package', packageJob, 6], ['native composite', native, 4]]) {
    test(`${label}: ${name}: trusted content store with full identity and required frozen install`, () => {
      // pnpm can follow packageManager rather than the globally installed version.
      assert.equal(JSON.parse(read('package.json')).packageManager, 'pnpm@11.11.0');
      cacheContract(text, indent);
      required(steps(text, indent).find(step => scalar(step, 'run', indent) === 'node scripts/audit-secrets.mjs'), indent);
    });
  }

  test(`${label}: cache contract rejects trust, identity, path, fallback and install-bypass regressions`, () => {
    cacheContract(verify, 6);
    const mutations = [
      [verify.replaceAll("github.event_name != 'pull_request_target'", 'true'), /pull_request_target refs\/heads\/main/],
      [verify.replaceAll("github.event_name != 'pull_request'", 'true'), /pull_request refs\/heads\/main/],
      [verify.replaceAll("github.ref == 'refs/heads/main'", 'true'), /push refs\/heads\/feature/],
      [verify.replace('-node-${{ steps.node.outputs.node-version }}', '-node-24'), /cache key must preserve exact identity/],
      [verify.replace('-pnpm-11.11.0-', '-pnpm-'), /cache key must preserve exact identity/],
      [verify.replace("'patches/**'", "'package.json'"), /cache key must preserve exact identity/],
      [verify.replace('${{ steps.pnpm-store.outputs.path }}', 'node_modules'), /cache only the discovered content store/],
      [verify.replace('          key: pnpm-store-', '          restore-keys: pnpm-store-\n          key: pnpm-store-'), /cache must not use fallback or suppress errors/],
      [verify.replace('      - run: pnpm install --frozen-lockfile', "      - run: pnpm install --frozen-lockfile\n        if: steps.cache.outputs.cache-hit != 'true'"), /step must run on hits and misses/],
      [verify.replace('pnpm install --frozen-lockfile', 'pnpm install'), /then required frozen install/],
    ];
    for (const [index, [mutated, reason]] of mutations.entries()) {
      assert.notEqual(mutated, verify, `cache mutation ${index} must change the fixture`);
      assert.throws(() => cacheContract(mutated, 6), reason);
    }
  });

  function coverageContract(text) {
    const portable = named(text, 'Portable source tests');
    assert.equal(scalar(portable, 'if', 6), "runner.os == 'Windows'", 'portable source checks must run only on Windows');
    assert.equal(scalar(portable, 'run', 6), 'pnpm exec vitest run --maxWorkers=4 packages/protocol/test packages/app/test packages/client/test/doctor.test.ts packages/core/test/paths-platform.test.ts');
    const unix = named(text, 'Full Unix source suite');
    assert.equal(scalar(unix, 'if', 6), "runner.os != 'Windows'");
    assert.match(unix, /^          pnpm exec vitest run --maxWorkers=4$/m, 'Unix must run the complete source suite');
    assert.doesNotMatch(unix, /continue-on-error|--exclude|--passWithNoTests/);
    const gates = named(text, 'Portable typecheck and native gate regressions');
    required(gates, 6);
    assert.equal(scalar(gates, 'run', 6), 'node --test scripts/typecheck.test.mjs');
    const contracts = named(text, 'Release cache and source coverage regressions');
    required(contracts, 6);
    assert.equal(scalar(contracts, 'run', 6), 'node --test scripts/release-workflows.test.mjs');
    assert.match(text, /os: \[macos-latest, ubuntu-24\.04, windows-latest\]/);
  }

  test(`${label}: Windows retains portable source checks; Unix retains the full superset; all OS retain gates`, () => {
    coverageContract(verify);
  });

  test(`${label}: coverage contract rejects duplicated Unix checks or a weakened full-suite gate`, () => {
    coverageContract(verify);
    for (const [mutated, reason] of [
      [verify.replace("if: runner.os == 'Windows'", "if: runner.os != 'Windows'"), /portable source checks must run only on Windows/],
      [verify.replace('          pnpm exec vitest run --maxWorkers=4\n', '          pnpm exec vitest run --maxWorkers=4 packages/protocol/test\n'), /Unix must run the complete source suite/],
      [verify.replace('        run: node --test scripts/typecheck.test.mjs', "        if: runner.os == 'Windows'\n        run: node --test scripts/typecheck.test.mjs"), /step must run on hits and misses/],
    ]) {
      assert.notEqual(mutated, verify, 'coverage mutation must change the fixture');
      assert.throws(() => coverageContract(mutated), reason);
    }
  });

  test(`${label}: npm smoke stays dependency-free and consumes the same candidate tarball on all three OS`, () => {
    assert.match(smokeJob, /needs: package/);
    assert.match(smokeJob, /os: \[ubuntu-24\.04, macos-latest, windows-latest\]/);
    assert.doesNotMatch(smokeJob, /actions\/cache|pnpm|npm install|cache:/);
    assert.match(packageJob, /node --test scripts\/npm-install\.test\.mjs scripts\/npm-uninstall\.test\.mjs scripts\/npm-install-integrations\.test\.mjs scripts\/npm-build\.test\.mjs/);
    assert.match(smokeJob, /node --test scripts\/npm-install\.test\.mjs scripts\/npm-uninstall\.test\.mjs/);
    assert.match(smokeJob, /name: chimera-npm-candidate/);
    assert.match(packageJob, /name: chimera-npm-candidate/);
    assert.match(smokeJob, /test "\$\{#artifacts\[@\]\}" -eq 1/);
    assert.match(smokeJob, /CHIMERA_NPM_ARTIFACT="\$\{artifacts\[0\]\}" node --test scripts\/npm-artifact\.test\.mjs/);
    assert.match(smokeJob, /npm run test:npm -- "\$\{artifacts\[0\]\}"/);
    assert.match(packageJob, /npm audit --omit=dev --audit-level=high --registry=https:\/\/registry\.npmjs\.org/);
  });
}
