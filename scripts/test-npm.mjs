// Exercise the packed artifact outside the checkout: repository dependencies must not mask gaps.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const artifact = process.argv[2];
if (!artifact?.endsWith('.tgz')) throw new Error('Usage: npm run test:npm -- /absolute/path/to/package.tgz');
const dir = await mkdtemp(join(tmpdir(), 'chimera-npm-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CHIMERA_') && !['NODE_PATH', 'NODE_OPTIONS'].includes(key)));
env.CHIMERA_HOME = join(dir, 'state');
env.CHIMERA_BACKEND = 'fake';
env.CHIMERA_PARENT_PID = String(process.pid);
env.CHIMERA_LAUNCHD_LABEL = `dev.chimera.npm-test.${process.pid}`;
env.CHIMERA_SYSTEMD_UNIT = `chimera-npm-test-${process.pid}.service`;

function run(command, args, timeout = 30_000) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} failed (${code}): ${stderr}\n${stdout}`));
      else resolveRun(stdout);
    });
  });
}

let client, mcp;
try {
  const npm = process.env.npm_execpath;
  const args = ['install', '--prefix', dir, '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0', '--fetch-timeout=20000', '--registry=https://registry.npmjs.org', '--cache', join(tmpdir(), 'chimera-npm-cache'), resolve(artifact)];
  console.log('Installing tarball into an isolated prefix…');
  await run(npm ? process.execPath : 'npm', npm ? [npm, ...args] : args, 180_000);
  const installed = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const names = Object.keys(installed.dependencies);
  assert.equal(names.length, 1);
  const base = join(dir, 'node_modules', names[0]);
  const manifest = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(base, 'npm-shrinkwrap.json'), 'utf8'));
  for (const entry of Object.values(lock.packages)) {
    if (entry.resolved) assert.ok(entry.resolved.startsWith('https://registry.npmjs.org/'), `Non-public resolution: ${entry.resolved}`);
  }
  assert.equal(manifest.dependencies.tsx, undefined);
  const cli = join(base, manifest.bin.chimera);
  assert.equal((await run(process.execPath, [cli, '--version'])).trim(), manifest.version);
  assert.match(await run(process.execPath, [cli, '--help']), /Usage: chimera/);
  if (['darwin', 'linux', 'win32'].includes(process.platform)) {
    const plan = JSON.parse(await run(process.execPath, [cli, 'install', '--dry-run']));
    assert.equal(plan.version, manifest.version);
    assert.ok(plan.download.includes(`/v${manifest.version}/`));
  }
  const report = JSON.parse(await run(process.execPath, [cli, 'doctor']));
  assert.equal(report.ok, true);
  await assert.rejects(readFile(join(env.CHIMERA_HOME, 'daemon.pid')), { code: 'ENOENT' });
  console.log('PASS offline CLI, public shrinkwrap, package metadata');

  await mkdir(env.CHIMERA_HOME, { recursive: true, mode: 0o700 });
  await writeFile(join(env.CHIMERA_HOME, 'config.json'), JSON.stringify({
    accounts: [{ name: 'main', provider: 'claude', auth: { type: 'subscription' } }],
    autoOrder: ['main'], wake: { holdAwakeDuringRuns: false, scheduleWake: false },
  }), { mode: 0o600 });
  const { ChimeraClient } = await import(pathToFileURL(join(base, 'packages/client/src/client.js')).href);
  client = await ChimeraClient.connect({ home: env.CHIMERA_HOME, env });
  const status = await client.request('daemon.status', {});
  assert.equal(status.protocolVersion, 1);
  const agent = await client.request('agent.spawn', { spec: { prompt: 'npm smoke', cwd: dir, isolation: 'none' } });
  const result = await client.request('agent.wait', { agentId: agent.agentId, timeoutMs: 10_000 });
  assert.equal(result.state, 'done');
  assert.equal(result.resultText, 'fake:npm smoke');
  assert.equal(JSON.parse(await run(process.execPath, [cli, 'status'])).protocolVersion, 1);
  console.log('PASS daemon autostart, CLI RPC, fake agent spawn/wait');

  const req = createRequire(join(base, 'package.json'));
  const { Client } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
  mcp = new Client({ name: 'npm-smoke', version: '1.0.0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(base, manifest.bin['chimera-mcp'])], env }));
  assert.ok((await mcp.listTools()).tools.length > 0);
  console.log('PASS packaged MCP process initialization and tool discovery');

  for (const provider of ['claude', 'codex', 'kimi']) {
    const providerPath = join(base, 'packages/core/src/backends', `${provider}.js`);
    await import(pathToFileURL(providerPath).href);
    const mcpBin = resolve(dirname(providerPath), '../../../mcp/bin/chimera-mcp.js');
    assert.equal(mcpBin, join(base, manifest.bin['chimera-mcp']));
  }
  console.log('PASS provider imports and provider MCP relative paths');
} catch (error) {
  try { console.error(await readFile(join(env.CHIMERA_HOME, 'daemon.log'), 'utf8')); } catch {}
  throw error;
} finally {
  await mcp?.close();
  if (client) {
    await client.request('daemon.stop', {}).catch(() => {});
    client.close();
  }
  // Wait for the daemon to flush before removing its state. Parent-PID fencing also
  // protects early-startup failures where no RPC client was obtained.
  for (let i = 0; i < 50; i++) {
    let pid;
    try { pid = Number(await readFile(join(env.CHIMERA_HOME, 'daemon.pid'), 'utf8')); } catch { break; }
    try { process.kill(pid, 0); } catch { break; }
    if (i === 49) throw new Error(`Test daemon has not exited; retained ${dir}`);
    await new Promise(r => setTimeout(r, 100));
  }
  await rm(dir, { recursive: true, force: true });
}
