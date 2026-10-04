// Exercise the shipped runtime outside the checkout, with no user credentials or developer PATH.
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const source = resolve(process.argv[2] ?? 'packages/app/src-tauri/standalone/runtime');
const temp = await realpath(await mkdtemp(join(tmpdir(), 'cs ')));
const runtime = join(temp, 'runtime with spaces');
const home = join(temp, 'user home');
const state = join(home, '.chimera');
const windows = process.platform === 'win32';
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^CHIMERA_|^NODE_|^ANTHROPIC_|^OPENAI_|^CODEX_|^CLAUDE_|^GIT_|^NPM_/i.test(key) || key.toLowerCase() === 'path') delete env[key];
Object.assign(env, { HOME: home, USERPROFILE: home, PATH: windows ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin', CHIMERA_HOME: state, CHIMERA_BACKEND: 'fake', CHIMERA_PARENT_PID: String(process.pid) });
let client, mcp;
try {
  await cp(source, runtime, { recursive: true, verbatimSymlinks: true });
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'config.json'), JSON.stringify({ accounts: [{ name: 'main', provider: 'claude', auth: { type: 'subscription' } }], autoOrder: ['main'], wake: { holdAwakeDuringRuns: false, scheduleWake: false } }));
  const node = join(runtime, windows ? 'node/node.exe' : 'node/bin/node');
  const run = args => execFileSync(node, args, { cwd: home, env, encoding: 'utf8', timeout: 40_000 });
  const check = JSON.parse(run([join(runtime, 'bootstrap.mjs'), '--check']));
  assert.match(check.node, /^v24\./);
  assert.match(check.git, /^git version /);
  assert.equal(check.root, await (await import('node:fs/promises')).realpath(runtime));
  const npm = join(runtime, windows ? 'node/node_modules/npm/bin/npm-cli.js' : 'node/lib/node_modules/npm/bin/npm-cli.js');
  assert.match(run([npm, '--version']), /^\d+\./);
  console.log('PASS embedded Node, npm and Git without developer PATH');
  assert.match(run([join(runtime, 'bootstrap.mjs')]), /background service ready/);
  const pid = await readFile(join(state, 'daemon.pid'), 'utf8');
  run([join(runtime, 'bootstrap.mjs')]);
  assert.equal(await readFile(join(state, 'daemon.pid'), 'utf8'), pid, 'Second open must reuse the daemon');
  const { ChimeraClient } = await import(pathToFileURL(join(runtime, 'packages/client/src/client.js')));
  client = await ChimeraClient.connect({ home: state, env, autostart: false });
  const agent = await client.request('agent.spawn', { spec: { prompt: 'standalone desktop smoke', cwd: home, isolation: 'none' } });
  const result = await client.request('agent.wait', { agentId: agent.agentId, timeoutMs: 10_000 });
  assert.equal(result.state, 'done');
  assert.equal(result.resultText, 'fake:standalone desktop smoke');
  console.log('PASS first launch, repeated launch and daemon agent lifecycle');
  const req = createRequire(join(runtime, 'package.json'));
  const { setupEnvironment } = req('./node_modules/dugite/build/lib/git-environment.js');
  const git = setupEnvironment({}, env);
  const repo = join(home, 'project with spaces');
  const gitRun = args => execFileSync(git.gitLocation, args, { env: git.env, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  gitRun(['init', repo]);
  gitRun(['-C', repo, '-c', 'user.name=Runtime Test', '-c', 'user.email=runtime@example.invalid', 'commit', '--allow-empty', '-m', 'initial']);
  const isolated = await client.request('agent.spawn', { spec: { prompt: 'bundled git worktree', cwd: repo, isolation: 'worktree' } });
  assert.equal((await client.request('agent.wait', { agentId: isolated.agentId, timeoutMs: 10_000 })).state, 'done');
  console.log('PASS bundled Git repository and isolated agent worktree');
  const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = req('@modelcontextprotocol/sdk/client/stdio.js');
  mcp = new Client({ name: 'standalone-smoke', version: '1.0.0' });
  await mcp.connect(new StdioClientTransport({ command: node, args: [join(runtime, 'packages/mcp/bin/chimera-mcp.js')], env }));
  assert.ok((await mcp.listTools()).tools.length > 0);
  const { resolveCodexSdkCliPath } = await import(pathToFileURL(join(runtime, 'packages/core/src/providers/codex-cli-path.js')));
  const codexPath = resolveCodexSdkCliPath();
  assert.ok(codexPath, 'Bundled Codex CLI missing');
  assert.ok(codexPath.startsWith(runtime));
  assert.match(execFileSync(codexPath, ['--version'], { env, encoding: 'utf8', timeout: 20_000 }), /codex/i);
  const claudeDir = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const claude = join(runtime, 'node_modules', claudeDir, windows ? 'claude.exe' : 'claude');
  assert.match(execFileSync(claude, ['--version'], { env, encoding: 'utf8', timeout: 20_000 }), /claude/i);
  console.log('PASS packaged MCP tools and native Claude/Codex executable resolution');
} catch (error) {
  try { console.error(await readFile(join(state, 'daemon.log'), 'utf8')); } catch {}
  throw error;
} finally {
  await mcp?.close();
  if (client) { await client.request('daemon.stop', {}).catch(() => {}); client.close(); }
  // Parent-PID fencing covers early failures before the RPC handle is available.
  for (let i = 0; i < 100; i++) {
    let pid;
    try { pid = Number(await readFile(join(state, 'daemon.pid'), 'utf8')); } catch { break; }
    try { process.kill(pid, 0); } catch { break; }
    if (i === 0 && !client) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    if (i === 99) throw new Error(`Test service did not exit; retained ${temp}`);
    await new Promise(r => setTimeout(r, 100));
  }
  await rm(temp, { recursive: true, force: true });
}
