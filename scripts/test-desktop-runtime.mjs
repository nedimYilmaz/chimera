// Exercise the shipped runtime outside the checkout, with no user credentials or developer PATH.
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, writeFile, readFile, rm, realpath, rename, readdir, lstat, copyFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
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
const developerHome = process.env.HOME ?? homedir();
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
  assert.match(run([join(runtime, 'bootstrap.mjs'), '--service-only']), /background service ready/);
  const pid = await readFile(join(state, 'daemon.pid'), 'utf8');
  run([join(runtime, 'bootstrap.mjs'), '--service-only']);
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

  // ---- built-in computer-use integrations: a relocated runtime + a fresh HOME must come up with them ----
  await mcp.close(); mcp = undefined;
  const realRoot = await realpath(runtime);
  const storeFile = join(state, 'mcpstore.json');
  const readStoreText = () => readFile(storeFile, 'utf8');
  const servers = text => { const raw = JSON.parse(text); return raw.servers ?? raw; };
  const manifestOf = async root => JSON.parse(await readFile(join(root, 'integrations/manifest.json'), 'utf8'));
  const m = await manifestOf(runtime);
  const abs = (root, rel) => join(root, ...rel.split('/'));

  let reg = servers(await readStoreText());
  const desktop = reg['chimera-desktop'], browser = reg['chimera-browser'];
  if (m.integrations['chimera-desktop'].state === 'bundled') {
    assert.deepEqual(desktop.builtIn, { id: 'chimera-desktop', version: m.integrations['chimera-desktop'].version });
    assert.equal(desktop.command, abs(realRoot, m.integrations['chimera-desktop'].driver));
    assert.equal(desktop.sessionMode, 'exclusive');
    assert.equal(desktop.env.CUA_DRIVER_RS_TELEMETRY_ENABLED, '0');
  } else assert.equal(desktop, undefined);
  if (m.integrations['chimera-browser'].state === 'bundled') {
  assert.deepEqual(browser.builtIn, { id: 'chimera-browser', version: m.integrations['chimera-browser'].version });
  assert.equal(browser.command, abs(realRoot, m.integrations['chimera-browser'].node));
  assert.equal(browser.sessionMode, 'agent', 'each agent must get its own browser');
  assert.ok(browser.args.includes(abs(realRoot, m.integrations['chimera-browser'].executable)));
  } else assert.equal(browser, undefined);
  assert.equal(reg.laya, undefined, 'Laya registers only after its first-use download');
  for (const file of [join(state, 'mcpstore.json'), join(runtime, 'integrations/manifest.json'), join(runtime, 'runtime.json'), join(runtime, 'integrations/NOTICE.md'), join(runtime, 'integrations/laya/requirements.lock')]) {
    assert.ok(!(await readFile(file, 'utf8').catch(() => '')).includes(developerHome), `${file} leaks the developer home`);
  }
  const status = await client.request('computerUse.builtins.status', {});
  assert.equal(status.managed, true);
  const by = Object.fromEntries(status.integrations.map(i => [i.id, i]));
  assert.equal(by['chimera-browser'].state, m.integrations['chimera-browser'].state === 'bundled' ? 'ready' : 'unsupported-platform');
  assert.equal(by.laya.state, m.integrations.laya.state === 'managed-download' ? 'not-installed' : 'unsupported-platform');
  console.log('PASS built-in integrations registered from the relocated runtime, no developer path, Laya honestly not-installed');

  // Real tool discovery + a real call through the daemon's mcp_store, from the relocated runtime with a fresh HOME.
  if (m.integrations['chimera-browser'].state === 'bundled') {
  const found = (await client.request('mcpstore.tools', { servers: ['chimera-browser'] })).servers.find(x => x.server === 'chimera-browser' || x.name === 'chimera-browser');
  const names = (found?.tools ?? []).map(t => t.name);
  assert.ok(names.includes('browser_navigate'), `chimera-browser tools not discovered: ${JSON.stringify(found).slice(0, 300)}`);
  const nav = await client.request('mcpstore.call', { server: 'chimera-browser', tool: 'browser_navigate', args: { url: 'data:text/html,<title>relocated</title><h1>hello chimera</h1>' }, agentId: isolated.agentId });
  assert.match(JSON.stringify(nav), /relocated|hello chimera/);
  console.log(`PASS chimera-browser: ${names.length} tools discovered and browser_navigate ran in the bundled Chrome`);
  }
  if (m.integrations['chimera-desktop'].state === 'bundled') {
    const d = (await client.request('mcpstore.tools', { servers: ['chimera-desktop'] })).servers.find(x => x.server === 'chimera-desktop' || x.name === 'chimera-desktop');
    assert.match(JSON.stringify(d), /not running right now|desktop service/i, 'desktop must explain that the Chimera app hosts it');
    console.log('PASS chimera-desktop: bundled driver registered; without the app host it reports the app-owned service is not running');
  }

  // Custom/user configs must survive every restart and relocation untouched.
  await client.request('mcpstore.add', { name: 'laya', type: 'stdio', command: '/opt/my-own-laya/bin/python', args: ['-m', 'my_laya'] });
  await client.request('mcpstore.add', { name: 'my-tool', type: 'stdio', command: '/usr/bin/true', args: [] });
  const custom = { laya: servers(await readStoreText()).laya, 'my-tool': servers(await readStoreText())['my-tool'] };
  assert.equal(custom.laya.builtIn, undefined);

  const restart = async (root, bin) => {
    await client.request('daemon.stop', {}).catch(() => {});
    client.close();
    for (let i = 0; i < 100; i++) { try { process.kill(Number(await readFile(join(state, 'daemon.pid'), 'utf8')), 0); } catch { break; } await new Promise(r => setTimeout(r, 100)); }
    assert.match(execFileSync(bin, [join(root, 'bootstrap.mjs'), '--service-only'], { cwd: home, env, encoding: 'utf8', timeout: 40_000 }), /background service ready/);
    client = await ChimeraClient.connect({ home: state, env, autostart: false });
  };
  const before = await readStoreText();
  await restart(runtime, node);
  assert.equal(await readStoreText(), before, 'a second reconcile must change nothing');
  console.log('PASS restart is idempotent (mcpstore.json byte-identical)');

  const moved = join(temp, 'moved runtime');
  await client.request('daemon.stop', {}).catch(() => {});
  client.close();
  for (let i = 0; i < 100; i++) { try { process.kill(Number(await readFile(join(state, 'daemon.pid'), 'utf8')), 0); } catch { break; } await new Promise(r => setTimeout(r, 100)); }
  await rename(runtime, moved);
  const movedNode = join(moved, windows ? 'node/node.exe' : 'node/bin/node');
  assert.match(execFileSync(movedNode, [join(moved, 'bootstrap.mjs'), '--service-only'], { cwd: home, env, encoding: 'utf8', timeout: 40_000 }), /background service ready/);
  client = await ChimeraClient.connect({ home: state, env, autostart: false });
  const movedRoot = await realpath(moved);
  reg = servers(await readStoreText());
  if (m.integrations['chimera-browser'].state === 'bundled') {
  assert.equal(reg['chimera-browser'].command, abs(movedRoot, m.integrations['chimera-browser'].node), 'relocation must re-point the built-in');
  assert.ok(!(await readStoreText()).includes(realRoot), 'no stale install path may remain after the app moved');
  assert.deepEqual(reg['chimera-browser'].builtIn, { id: 'chimera-browser', version: m.integrations['chimera-browser'].version });
  }
  assert.deepEqual(reg.laya, custom.laya, 'a custom server that merely shares a built-in name must stay untouched');
  assert.deepEqual(reg['my-tool'], custom['my-tool']);
  const afterMove = await client.request('computerUse.builtins.status', {});
  assert.equal(afterMove.integrations.find(i => i.id === 'chimera-browser').state, m.integrations['chimera-browser'].state === 'bundled' ? 'ready' : 'unsupported-platform');
  console.log('PASS relocating the app re-points built-ins; custom MCP entries (incl. a custom "laya") are untouched');

  // Opt-in (downloads PyTorch, several hundred MB): the REAL first-use Laya install from the bundled python,
  // hash lock and wheel, then the MCP server answering from the relocated runtime. A custom `laya` from the
  // check above would (correctly) block registration, so remove it first.
  if (process.env.CHIMERA_SMOKE_LAYA === '1' && m.integrations.laya.state === 'managed-download') {
    // A bootstrap-started daemon is reparented to init, which any OTHER Chimera on this machine treats as an
    // orphan and reaps (HealthMonitor.sweepOrphanChimerads) -- fatal to a minutes-long install. Host the daemon
    // as our own child (ppid = this process) for this phase instead.
    await client.request('daemon.stop', {}).catch(() => {}); client.close();
    for (let i = 0; i < 100; i++) { try { process.kill(Number(await readFile(join(state, 'daemon.pid'), 'utf8')), 0); } catch { break; } await new Promise(r => setTimeout(r, 100)); }
    const hosted = spawn(movedNode, [join(moved, 'packages/daemon/bin/chimerad.js')], { cwd: home, env, stdio: 'ignore' });
    for (let i = 0; ; i++) {
      try { client = await ChimeraClient.connect({ home: state, env, autostart: false }); break; }
      catch (error) { if (i > 100) throw error; await new Promise(r => setTimeout(r, 100)); }
    }
    process.once('exit', () => { try { hosted.kill('SIGTERM'); } catch {} });
    await client.request('mcpstore.remove', { name: 'laya' });

    // The shipped manifest pins the reviewed checkpoint; every assertion below is against THAT, never a literal.
    const pin = m.integrations.laya.checkpoint;
    assert.match(pin.revision, /^[a-f0-9]{40}$/, 'the shipped manifest must pin a full commit SHA, not a branch or "reviewed"');
    const layaDir = join(state, 'integrations', `laya-${m.integrations.laya.version}`);
    const modelDir = join(layaDir, 'hf', 'hub', `models--${pin.repo.replace('/', '--')}`);
    // The install step downloads ~842 MB of weights. Reuse a developer's verified cache when there is one so the
    // smoke stays cheap; the install still hashes every pinned file itself, so a seeded copy proves nothing it
    // would not prove after a real download. CHIMERA_SMOKE_LAYA_MODEL_CACHE overrides the source `models--*` dir.
    const modelSource = process.env.CHIMERA_SMOKE_LAYA_MODEL_CACHE
      ?? join(process.env.HF_HOME ?? join(developerHome, '.cache', 'huggingface'), 'hub', `models--${pin.repo.replace('/', '--')}`);
    // Files and symlinks only: huggingface_hub creates an EMPTY directory for a checkpoint it then fails to find
    // offline, which is a refusal, not a download.
    const modelTree = async () => (await readdir(modelDir, { recursive: true, withFileTypes: true }).catch(() => []))
      .filter(entry => !entry.isDirectory()).map(entry => join(entry.parentPath ?? entry.path, entry.name).slice(modelDir.length)).sort();
    const seeded = await lstat(join(modelSource, 'snapshots', pin.revision)).then(() => true, () => false);
    if (seeded) {
      await mkdir(dirname(modelDir), { recursive: true });
      await cp(modelSource, modelDir, { recursive: true, verbatimSymlinks: true, mode: fsConstants.COPYFILE_FICLONE });
      // huggingface_hub's xet cache leaves blobs as symlinks into a SHARED blob store outside the model dir;
      // those would dangle here, so each is replaced by a real (APFS-cloned where possible) copy.
      for (const name of await readdir(join(modelDir, 'blobs'))) {
        const dest = join(modelDir, 'blobs', name);
        if (!(await lstat(dest)).isSymbolicLink()) continue;
        await rm(dest);
        await copyFile(await realpath(join(modelSource, 'blobs', name)), dest, fsConstants.COPYFILE_FICLONE);
      }
      console.log(`INFO laya: seeded the pinned model from ${modelSource}; the install should download no weights`);
    } else console.log(`INFO laya: no cached model at ${modelSource}; the install will download the pinned checkpoint (~842 MB)`);
    const treeBeforeInstall = await modelTree();

    assert.deepEqual(await client.request('computerUse.builtins.install', { id: 'laya' }), { started: true });
    const layaRow = async () => (await client.request('computerUse.builtins.status', {})).integrations.find(i => i.id === 'laya');
    const deadline = Date.now() + 9 * 60_000;
    let row = await layaRow();
    while (row.state === 'installing' && Date.now() < deadline) { await new Promise(r => setTimeout(r, 2000)); row = await layaRow(); }
    assert.equal(row.state, 'ready', `Laya first-use install did not finish: ${JSON.stringify(row)}`);
    reg = servers(await readStoreText());
    assert.deepEqual(reg.laya.builtIn, { id: 'laya', version: m.integrations.laya.version });
    assert.ok(reg.laya.env.PYTHONPATH.startsWith(state), 'Laya packages live in the user state dir, never inside the app');
    assert.ok(!(await readStoreText()).includes(developerHome));
    const laya = (await client.request('mcpstore.tools', { servers: ['laya'] })).servers.find(x => x.server === 'laya' || x.name === 'laya');
    const layaTools = (laya?.tools ?? []).map(t => t.name);
    assert.ok(layaTools.some(n => n.startsWith('laya_')), `laya tools not discovered: ${JSON.stringify(laya).slice(0, 300)}`);
    console.log(`PASS laya: real first-use install from the bundled python and hash lock; ${layaTools.length} tools discovered (${layaTools.join(', ')})`);

    // The registered entry must carry the reviewed checkpoint: this is what stops first use from tracking the
    // Hub's mutable `main`. Compared with the shipped manifest, not restated here.
    assert.equal(reg.laya.env.LAYA_REVISION, pin.revision, 'registered entry must pin the reviewed commit SHA');
    assert.deepEqual(JSON.parse(reg.laya.env.LAYA_SHA256_DIGESTS), pin.files, 'registered entry must pin the reviewed digests (flat shape)');
    assert.equal(reg.laya.env.HF_HUB_OFFLINE, '1', 'first use must never reach the Hub');
    const readyFile = JSON.parse(await readFile(join(layaDir, 'ready.json'), 'utf8'));
    assert.deepEqual(readyFile.checkpoint, pin, 'ready.json must record the checkpoint the install verified');
    if (seeded) assert.deepEqual(await modelTree(), treeBeforeInstall, 'a seeded install must not download or replace anything');
    console.log('PASS laya: registered entry pins the reviewed revision + digest, offline; install verified the weights');

    // Real first use: the English checkpoint loads from the verified cache and answers a typed choice.
    const callLaya = (tool, args) => client.request('mcpstore.call', { server: 'laya', tool, args, agentId: isolated.agentId });
    const choice = (model) => ({
      state: { text: 'Task: submit the signup form\nObservation: every field is filled in and the Submit button is visible.' },
      questions: { action: { type: 'choice', instructions: 'Choose the next action for the observed task.', criteria: { click_submit: 'Click the Submit button.', scroll_up: 'Scroll back to the top of the page.' } } },
      model, min_confidence: 0,
    });
    const answered = JSON.stringify(await callLaya('laya_predict', choice('english')));
    assert.match(answered, /click_submit|scroll_up/, `laya_predict did not answer: ${answered.slice(0, 400)}`);
    assert.ok(!/"isError":\s*true|SHA-256 mismatch/.test(answered), `laya_predict reported an error: ${answered.slice(0, 400)}`);
    console.log('PASS laya: first-use laya_predict answered from the pinned English checkpoint');

    // Anything the pin does not cover must refuse WITHOUT downloading: multilingual and typed-decisions were never
    // evaluated and have no reviewed digest, and offline mode means "not cached" rather than "fetch from main".
    const treeAfterEnglish = await modelTree();
    const refused = JSON.stringify(await callLaya('laya_predict', choice('multilingual')).catch(error => ({ rejected: String(error?.message ?? error) })));
    assert.match(refused, /"isError":\s*true|rejected/, `multilingual must be refused, not answered: ${refused.slice(0, 400)}`);
    assert.ok(!/click_submit|scroll_up/.test(refused), `multilingual must not answer: ${refused.slice(0, 400)}`);
    assert.deepEqual(await modelTree(), treeAfterEnglish, 'a refused checkpoint must not be downloaded into the model cache');
    console.log(`PASS laya: model="multilingual" is refused offline and downloads nothing (${refused.replace(/\\n|\s+/g, ' ').slice(0, 260)})`);

    // Negative control through the REAL shipped entry: the same command, args and env, with one wrong digest.
    // Laya must refuse to load the weights instead of silently using an unreviewed artifact.
    const tampered = { ...reg.laya.env, LAYA_SHA256_DIGESTS: JSON.stringify(Object.fromEntries(Object.keys(pin.files).map(file => [file, '0'.repeat(64)]))) };
    const control = new Client({ name: 'laya-wrong-digest', version: '1.0.0' });
    try {
      await control.connect(new StdioClientTransport({ command: reg.laya.command, args: reg.laya.args, env: { ...env, ...tampered } }));
      const wrong = JSON.stringify(await control.callTool({ name: 'laya_predict', arguments: choice('english') }).catch(error => ({ rejected: String(error?.message ?? error) })));
      assert.match(wrong, /SHA-256 mismatch|refusing to load/i, `a wrong digest must be refused: ${wrong.slice(0, 400)}`);
      assert.ok(!/click_submit|scroll_up/.test(wrong), 'a wrong digest must not produce an answer');
    } finally { await control.close().catch(() => {}); }
    console.log('PASS laya: a wrong digest is refused by the shipped entry (negative control)');
  }
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
