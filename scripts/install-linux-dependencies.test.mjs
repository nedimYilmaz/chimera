import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { installLinuxDependencies } from './install-linux-dependencies.mjs';

function recorder(statuses) {
  const calls = [];
  const run = (command, args, options) => {
    const source = args.find(arg => arg.startsWith('Dir::Etc::sourcelist=')).split('=')[1];
    calls.push({ command, args, options, source, contents: readFileSync(source, 'utf8') });
    return { status: statuses.length ? statuses.shift() : 0 };
  };
  return { calls, run };
}

test('DNS timeout falls back with isolated signed sources, then installs only downloaded packages', () => {
  const { calls, run } = recorder([null, 0, 0, 0]);
  installLinuxDependencies({ arch: 'amd64', codename: 'jammy', run });
  assert.equal(calls.length, 4);
  assert.match(calls[0].contents, /https:\/\/archive.ubuntu.com\/ubuntu/);
  assert.match(calls[1].contents, /https:\/\/mirrors.edge.kernel.org\/ubuntu/);
  assert.ok(calls[2].args.includes('--download-only'));
  assert.ok(calls[3].args.includes('--no-download'));
  assert.equal(calls[3].options.timeout, undefined, 'do not interrupt dpkg');
  for (const call of calls) {
    assert.equal(call.command, 'apt-get');
    assert.match(call.contents, /signed-by=\/usr\/share\/keyrings\/ubuntu-archive-keyring.gpg/);
    assert.match(call.contents, /jammy-security/);
    assert.ok(call.args.includes('Dir::Etc::sourceparts=-'));
    assert.doesNotMatch(call.args.join(' ') + call.contents, /trusted=yes|allow-unauthenticated|AllowInsecure|Check-Valid-Until=false/);
  }
  assert.equal(existsSync(dirname(calls[0].source)), false);
});

test('ARM package download failure retries through the ports mirror before any dpkg operation', () => {
  const { calls, run } = recorder([0, 100, 0, 0, 0]);
  installLinuxDependencies({ arch: 'arm64', codename: 'noble', run });
  assert.equal(calls.length, 5);
  assert.match(calls[2].contents, /mirrors.ocf.berkeley.edu\/ubuntu-ports/);
  assert.match(calls[2].contents, /arch=arm64/);
  assert.equal(calls.filter(call => call.args.includes('--no-download')).length, 1);
});

test('all mirror failures fail closed and clean temporary sources', () => {
  const { calls, run } = recorder([100, 100]);
  assert.throws(() => installLinuxDependencies({ arch: 'amd64', codename: 'jammy', run }), /All Ubuntu mirrors failed/);
  assert.equal(calls.length, 2);
  assert.equal(existsSync(dirname(calls[0].source)), false);
});

test('dpkg failure is surfaced without retrying installation against another mirror', () => {
  const { calls, run } = recorder([0, 0, 100]);
  assert.throws(() => installLinuxDependencies({ arch: 'amd64', codename: 'jammy', run }), /installation failed/);
  assert.equal(calls.length, 3);
});

test('unsupported distribution or architecture cannot execute apt', () => {
  const run = () => assert.fail('apt must not run');
  assert.throws(() => installLinuxDependencies({ arch: 'amd64', codename: 'unknown', run }), /Unsupported/);
  assert.throws(() => installLinuxDependencies({ arch: 'unknown', codename: 'jammy', run }), /Unsupported/);
});
