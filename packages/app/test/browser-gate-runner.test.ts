import { runInNewContext } from "node:vm";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  RESULT_PREFIX,
  REQUIRED_CHECK_IDS,
  LOOPBACK_GUARD_SOURCE,
  installLoopbackGuard,
  runBrowserSuiteCli,
  validateSuiteResult,
  connectCdp,
  createSuiteReporter,
  discoverChromium,
  launchChromium,
  runUnifiedBrowserGate,
  terminateOwnedProcess,
} from "../../../scripts/browser-gate.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

// These drive the gate's process supervision: shebang executables, SIGINT/SIGTERM handlers, 130/143
// exit codes and process-group reaping. None of that exists on Windows, where the gate does not
// create process groups, so they run on POSIX hosts only.
const posixTest = process.platform === "win32" ? test.skip : test;

async function waitForFile(path: string, timeoutMs = 10_000) {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  throw new Error(`Timed out after ${Date.now() - startedAt}ms waiting for fixture handshake ${path}`);
}

function suiteResult(id: string, status: "passed" | "failed" | "skipped") {
  return {
    id,
    status,
    durationMs: 1,
    checks: [{
      id: `${id}.probe`,
      status,
      durationMs: 0,
      ...(status === "passed" ? {} : { error: `synthetic ${id} probe ${status}` }),
    }],
  };
}

describe("unified browser gate runner", () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "chimera-browser-gate-test-"));
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  test("honors an explicit browser and fails a missing explicit path without fallback", () => {
    expect(discoverChromium({
      explicitPath: "/fixture/chrome",
      fileExists: (path: string) => path === "/fixture/chrome",
      pathValue: "/fallback",
    })).toBe("/fixture/chrome");

    expect(() => discoverChromium({
      explicitPath: "/fixture/missing",
      fileExists: (path: string) => path === "/fallback/chromium",
      pathValue: "/fallback",
      platform: "linux",
    })).toThrow("CHIMERA_TEST_CHROME does not exist: /fixture/missing");
  });

  test("discovers supported Chromium candidates with injected platform and filesystem fixtures", () => {
    expect(discoverChromium({
      environment: {},
      fileExists: (path: string) => path === "/Applications/Chromium.app/Contents/MacOS/Chromium",
      platform: "darwin",
      pathValue: "",
    })).toBe("/Applications/Chromium.app/Contents/MacOS/Chromium");

    expect(discoverChromium({
      environment: {},
      fileExists: (path: string) => path === "/usr/local/bin/chromium",
      platform: "linux",
      pathValue: "/bin:/usr/local/bin",
    })).toBe("/usr/local/bin/chromium");

    expect(() => discoverChromium({ environment: {}, fileExists: () => false, platform: "linux", pathValue: "" }))
      .toThrow("never downloads a browser");
  });

  test.each(["ui", "meeting"])("forces a named %s probe failure with a bounded stable record", (suiteId) => {
    const reporter = createSuiteReporter(suiteId, { forceCheckId: `${suiteId}.probe` });
    reporter.check("probe", true, "should be forced");
    const report = reporter.finish();

    expect(report.status).toBe("failed");
    expect(report.checks).toEqual([{ id: `${suiteId}.probe`, status: "failed", durationMs: 0, error: "forced probe failure" }]);
    expect(Number.isFinite(report.durationMs)).toBe(true);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("reports a Chromium spawn failure", async () => {
    await expect(launchChromium({
      accessExecutable: async () => {},
      args: [],
      explicitPath: join(testRoot, "synthetic-spawn-failure"),
      fileExists: () => true,
    })).rejects.toThrow("Unable to start Chromium");
  });

  test("bounds a CDP request timeout and closes the synthetic socket", async () => {
    class SilentWebSocket {
      onopen?: () => void;
      onerror?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      closed = false;
      constructor(_endpoint: string) { queueMicrotask(() => this.onopen?.()); }
      send(_message: string) {}
      close() { this.closed = true; this.onclose?.(); }
    }

    const client = await connectCdp("ws://127.0.0.1/fixture", { timeoutMs: 20, WebSocketImpl: SilentWebSocket });
    await expect(client.call("Runtime.evaluate")).rejects.toThrow("CDP timed out after 20ms: Runtime.evaluate");
    client.close();
    expect((client.socket as SilentWebSocket).closed).toBe(true);
  });

  test("runs both suites and emits one schemaVersion 1 final JSON object", async () => {
    const scripts = [];
    for (const id of ["ui", "meeting"]) {
      const script = join(testRoot, `${id}.mjs`);
      await writeFile(script, `console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify(${JSON.stringify(suiteResult(id, "passed"))}));\n`);
      scripts.push({ id, script });
    }
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runUnifiedBrowserGate({
      suites: scripts,
      stdout: { write: (value: string) => stdout.push(value) },
      stderr: { write: (value: string) => stderr.push(value) },
    });

    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({ schemaVersion: 1, status: "passed" });
    expect(result.report.suites.map((suite: { id: string }) => suite.id)).toEqual(["ui", "meeting"]);
    expect(result.report.suites.every((suite: { durationMs: number }) => Number.isFinite(suite.durationMs) && suite.durationMs >= 0)).toBe(true);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!.trim())).toEqual(result.report);
    expect(stderr.join("")).toContain("PASS ui browser suite");
    expect(stderr.join("")).toContain("PASS meeting browser suite");
  });

  test.each(["ui", "meeting"])("fails the final gate for a required %s probe failure", async (failedSuite) => {
    const scripts = [];
    for (const id of ["ui", "meeting"]) {
      const script = join(testRoot, `${id}.mjs`);
      await writeFile(script, `
import { runBrowserSuiteCli } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "scripts/browser-gate.mjs")).href)};
process.exitCode = await runBrowserSuiteCli(${JSON.stringify(id)}, async ({ reporter }) => {
  reporter.check("probe", true);
});
`);
      scripts.push({ id, script });
    }
    const result = await runUnifiedBrowserGate({
      environment: { ...process.env, CHIMERA_BROWSER_GATE_FORCE_CHECK: `${failedSuite}.probe` },
      suites: scripts,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.status).toBe("failed");
    expect(result.report.suites.find((suite: { id: string }) => suite.id === failedSuite)!.checks[0]!.status).toBe("failed");
  });

  test("treats a skipped required check as a failed final gate", async () => {
    const script = join(testRoot, "skipped.mjs");
    await writeFile(script, `console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify(${JSON.stringify(suiteResult("ui", "skipped"))}));\n`);
    const result = await runUnifiedBrowserGate({
      suites: [{ id: "ui", script }],
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.status).toBe("failed");
  });

  test("a missing explicit browser fails both real suite boundaries and removes their scratch directories", async () => {
    const scratchParent = join(testRoot, "scratch");
    await mkdir(scratchParent);
    const result = await runUnifiedBrowserGate({
      environment: {
        ...process.env,
        CHIMERA_TEST_CHROME: join(testRoot, "missing-browser"),
        CHIMERA_BROWSER_GATE_TEST_NO_OPTIMIZE: "1",
        CHIMERA_BROWSER_GATE_TEST_SCRATCH_PARENT: scratchParent,
      },
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.suites).toHaveLength(2);
    expect(result.report.suites.every((suite: { checks: Array<{ error?: string }> }) => suite.checks.some((check) => check.error?.includes("CHIMERA_TEST_CHROME does not exist")))).toBe(true);
    expect(await readdir(scratchParent, { recursive: true }), JSON.stringify(result.report)).toEqual([]);
  });

  posixTest("a Chromium endpoint timeout reaps only the owned browser", async () => {
    const fakeBrowser = join(testRoot, "fake-chromium.mjs");
    const reapedFile = join(testRoot, "browser-reaped");
    const readyFile = join(testRoot, "browser-ready");
    const foreignFile = join(testRoot, "foreign-resource");
    const scratchParent = join(testRoot, "scratch");
    await mkdir(scratchParent);
    await writeFile(foreignFile, "preserve");
    await writeFile(fakeBrowser, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
const profile = process.argv.find(value => value.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
if (profile) { mkdirSync(profile, { recursive: true }); writeFileSync(profile + "/owned-profile", "owned"); }
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(reapedFile)}, "terminated"); process.exit(0); });
writeFileSync(${JSON.stringify(readyFile)}, "ready");
setInterval(() => {}, 1000);
`);
    await chmod(fakeBrowser, 0o755);

    const result = await runUnifiedBrowserGate({
      environment: {
        ...process.env,
        CHIMERA_TEST_CHROME: fakeBrowser,
        CHIMERA_BROWSER_GATE_ENDPOINT_TIMEOUT_MS: "1500",
        CHIMERA_BROWSER_GATE_TEST_NO_OPTIMIZE: "1",
        CHIMERA_BROWSER_GATE_TEST_SCRATCH_PARENT: scratchParent,
      },
      suites: [{ id: "ui", script: join(repositoryRoot, "scripts/test-ui-browser.mjs") }],
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });

    expect(result.exitCode).toBe(1);
    expect(await waitForFile(readyFile)).toBe("ready");
    expect(result.report.suites[0].checks.some((check: { error?: string }) => check.error?.includes("Chromium debugging endpoint timed out after 1500ms"))).toBe(true);
    expect(await waitForFile(reapedFile)).toBe("terminated");
    expect(await readFile(foreignFile, "utf8")).toBe("preserve");
    expect(await readdir(scratchParent, { recursive: true }), JSON.stringify(result.report)).toEqual([]);
  });

  posixTest.each(["SIGINT", "SIGTERM"] as const)("%s interrupts the active suite and preserves non-owned resources", async (signal) => {
    const suiteId = signal === "SIGINT" ? "ui" : "meeting";
    const browser = join(testRoot, `signal-browser-${signal}.mjs`);
    const readyFile = join(testRoot, `ready-${signal}`);
    const reapedFile = join(testRoot, `reaped-${signal}`);
    const foreignFile = join(testRoot, `foreign-${signal}`);
    const scratchParent = join(testRoot, `scratch-${signal}`);
    await mkdir(scratchParent);
    await writeFile(foreignFile, "preserve");
    await writeFile(browser, `#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
const profile = process.argv.find(value => value.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
if (profile) { mkdirSync(profile, { recursive: true }); writeFileSync(profile + "/owned-profile", "owned"); }
process.once("SIGTERM", () => { writeFileSync(${JSON.stringify(reapedFile)}, "terminated"); process.exit(0); });
writeFileSync(${JSON.stringify(readyFile)}, "ready");
setInterval(() => {}, 1000);
`);
    await chmod(browser, 0o755);
    const signalSource = new EventEmitter();
    const running = runUnifiedBrowserGate({
      environment: {
        ...process.env,
        CHIMERA_TEST_CHROME: browser,
        CHIMERA_BROWSER_GATE_ENDPOINT_TIMEOUT_MS: "5000",
        CHIMERA_BROWSER_GATE_TEST_NO_OPTIMIZE: "1",
        CHIMERA_BROWSER_GATE_TEST_SCRATCH_PARENT: scratchParent,
      },
      signalSource,
      suites: [{ id: suiteId, script: join(repositoryRoot, `scripts/test-${suiteId === "ui" ? "ui" : "meeting"}-browser.mjs`) }],
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    await waitForFile(readyFile);
    signalSource.emit(signal);
    const result = await running;

    expect(result.exitCode).toBe(signal === "SIGINT" ? 130 : 143);
    expect(result.report.status).toBe("interrupted");
    expect(await waitForFile(reapedFile)).toBe("terminated");
    expect(await readdir(scratchParent), JSON.stringify(result.report)).toEqual([]);
    expect(await readFile(foreignFile, "utf8")).toBe("preserve");
  });
  test.each(["timeout", "error", "close", "abort", "pre-aborted"])("cleans CDP opening %s", async (mode) => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let socket: any;
    class OpeningSocket {
      onopen: any; onerror: any; onclose: any; onmessage: any;
      close = vi.fn();
      constructor() {
        socket = this;
        queueMicrotask(() => {
          if (mode === "error") this.onerror?.();
          if (mode === "close") this.onclose?.();
          if (mode === "abort") controller.abort();
        });
      }
    }
    if (mode === "pre-aborted") controller.abort();
    await expect(connectCdp("ws://127.0.0.1/fixture", { timeoutMs: 15, signal: controller.signal, WebSocketImpl: OpeningSocket })).rejects.toThrow();
    if (socket) {
      expect(socket.close).toHaveBeenCalledOnce();
      expect(socket.onopen).toBeNull();
      expect(socket.onerror).toBeNull();
      expect(socket.onclose).toBeNull();
      expect(remove).toHaveBeenCalled();
    }
  });

  test.each([
    ["empty", { checks: [] }],
    ["invalid duration", { durationMs: "invalid" }],
    ["negative duration", { durationMs: -1 }],
    ["invalid status", { status: "green" }],
    ["missing required", { checks: [{ id: "ui.other", status: "passed", durationMs: 0 }] }],
    ["duplicate", { checks: [suiteResult("ui", "passed").checks[0], suiteResult("ui", "passed").checks[0]] }],
    ["blank id", { checks: [{ id: " ", status: "passed", durationMs: 0 }] }],
    ["invalid check duration", { checks: [{ id: "ui.probe", status: "passed", durationMs: null }] }],
    ["invalid check status", { checks: [{ id: "ui.probe", status: "green", durationMs: 0 }] }],
    ["failed check", { checks: suiteResult("ui", "failed").checks }],
    ["skipped check", { checks: suiteResult("ui", "skipped").checks }],
    ["oversized detail", { checks: [{ ...suiteResult("ui", "passed").checks[0], error: "x".repeat(300_000) }] }],
    ["too many checks", { checks: [suiteResult("ui", "passed").checks[0], ...Array.from({ length: 1024 }, (_, i) => ({ id: `ui.p${i}`, status: "passed", durationMs: 0 }))] }],
  ])("rejects suite report: %s", async (_name, patch) => {
    const script = join(testRoot, "invalid.mjs");
    await writeFile(script, `console.log(${JSON.stringify(RESULT_PREFIX + JSON.stringify({ ...suiteResult("ui", "passed"), ...patch }))});`);
    const result = await runUnifiedBrowserGate({ suites: [{ id: "ui", script, requiredCheckIds: ["ui.probe"] }], stdout: { write() {} }, stderr: { write() {} } });
    expect(result.exitCode).toBe(1);
    expect(result.report.status).toBe("failed");
    expect(JSON.stringify(result.report).length).toBeLessThan(10_000);
  });

  posixTest("reaps stubborn inherited-pipe descendants after their group leader exits", async () => {
    const ready = join(testRoot, "descendant");
    const child = spawn(process.execPath, ["-e", `
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { stdio: ['ignore', 'inherit', 'inherit'] });
      descendant.unref();
    `], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let closed = false;
    child.once("close", () => { closed = true; });
    try {
      await waitForFile(ready);
      if (child.exitCode === null) await new Promise(resolveExit => child.once("exit", resolveExit));
      await terminateOwnedProcess(child, 60);
      expect(closed).toBe(true);
    } finally {
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
    }
  });

  test.each(["abort", "close", "error", "malformed", "send throws"])("settles pending CDP calls and listeners on %s", async (mode) => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    class Socket {
      onopen: any; onmessage: any; onclose: any; onerror: any;
      close = vi.fn();
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send() { if (mode === "send throws") throw new Error("send failed"); }
    }
    const client = await connectCdp("ws://127.0.0.1/fixture", { WebSocketImpl: Socket, timeoutMs: 100, signal: controller.signal });
    const calls = [client.call("one"), client.call("two")];
    const settled = Promise.allSettled(calls);
    if (mode === "abort") controller.abort();
    if (mode === "close") client.socket.onclose();
    if (mode === "error") client.socket.onerror();
    if (mode === "malformed") client.socket.onmessage({ data: "{" });
    expect((await settled).every(value => value.status === "rejected")).toBe(true);
    client.close();
    expect(client.socket.close).toHaveBeenCalledOnce();
    expect(client.socket.onmessage).toBeNull();
    expect(remove.mock.calls.length).toBe(add.mock.calls.length);
    await expect(client.call("late")).rejects.toThrow("closed");
  });

  test("pre-aborted browser launch creates no child", async () => {
    const controller = new AbortController(); controller.abort();
    const spawnImpl = vi.fn();
    await expect(launchChromium({ signal: controller.signal, spawnImpl })).rejects.toThrow("Interrupted");
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test.each(["{", "null", "[]", "double", "exit", "overflow", "detail"])("rejects malformed or failing child boundary: %s", async (mode) => {
    const script = join(testRoot, "boundary.mjs");
    const valid = RESULT_PREFIX + JSON.stringify(suiteResult("ui", "passed"));
    const payload = mode === "detail" ? RESULT_PREFIX + JSON.stringify({ ...suiteResult("ui", "passed"), checks: [{ ...suiteResult("ui", "passed").checks[0], error: "x".repeat(1001) }] })
      : ["double", "exit", "overflow"].includes(mode) ? valid : RESULT_PREFIX + mode;
    await writeFile(script, `console.log(${JSON.stringify(payload)}); ${mode === "double" ? `console.log(${JSON.stringify(valid)});` : ""} ${mode === "exit" ? "process.exitCode = 7;" : ""} ${mode === "overflow" ? "console.log('x'.repeat(300000));" : ""}`);
    const result = await runUnifiedBrowserGate({ suites: [{ id: "ui", script }], stdout: { write() {} }, stderr: { write() {} } });
    expect(result.exitCode).toBe(1);
    expect(JSON.stringify(result.report).length).toBeLessThan(5000);
  });

  test("both empty passed suites with invalid durations cannot pass", async () => {
    const suites = [];
    for (const id of ["ui", "meeting"]) {
      const script = join(testRoot, `${id}.mjs`);
      await writeFile(script, `console.log(${JSON.stringify(RESULT_PREFIX + JSON.stringify({ id, status: "passed", durationMs: "invalid", checks: [] }))});`);
      suites.push({ id, script });
    }
    const result = await runUnifiedBrowserGate({ suites, stdout: { write() {} }, stderr: { write() {} } });
    expect(result.exitCode).toBe(1);
    expect(result.report.suites.every((suite: any) => suite.status === "failed")).toBe(true);
  });

  test("suite boundary enforces required inventory and rejects invalid duration", async () => {
    for (const [suite, ids] of Object.entries(REQUIRED_CHECK_IDS)) {
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every(id => id.startsWith(`${suite}.`))).toBe(true);
    }
    const stdout: string[] = [];
    const code = await runBrowserSuiteCli("ui", async ({ reporter }: any) => { reporter.check("probe", true); }, {
      requiredCheckIds: REQUIRED_CHECK_IDS.ui, stdout: { write(value: string) { stdout.push(value); } }, signalSource: new EventEmitter(),
    });
    expect(code).toBe(1);
    expect(stdout[0]).toContain("Suite omitted required checks");
    expect(() => createSuiteReporter("ui").check("probe", true, undefined, -1)).toThrow("Invalid check duration");
  });

  posixTest.each(["deadline", "SIGINT", "SIGTERM"])("bounds stuck suite %s and preserves an unrelated owned fixture", async (mode) => {
    const ready = join(testRoot, "stuck-ready");
    const script = join(testRoot, "stuck.mjs");
    await writeFile(script, `import { spawn } from 'node:child_process';
      const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { stdio: ['ignore', 'inherit', 'inherit'] });
      descendant.unref();
      require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(descendant.pid));
      console.log(${JSON.stringify(RESULT_PREFIX + JSON.stringify(suiteResult("ui", "passed")))});
      if (process.connected) process.disconnect();
    `);
    const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const signalSource = new EventEmitter();
    const started = performance.now();
    try {
      // Full-suite workers can take seconds to schedule a fresh Node process. The
      // fixture writes its descendant PID synchronously after spawn, then the
      // bounded suite deadline measures the deliberately stuck phase.
      const running = runUnifiedBrowserGate({ suites: [{ id: "ui", script }], signalSource, suiteTimeoutMs: 5_000, cleanupTimeoutMs: 60,
        stdout: { write() {} }, stderr: { write() {} } });
      const descendantPid = Number(await waitForFile(ready));
      if (mode !== "deadline") signalSource.emit(mode);
      const result = await running;
      expect(result.exitCode).toBe(mode === "deadline" ? 1 : mode === "SIGINT" ? 130 : 143);
      expect(JSON.stringify(result.report)).toContain(mode === "deadline" ? "deadline exceeded" : "interrupted");
      expect(performance.now() - started).toBeLessThan(7_500);
      expect(() => process.kill(descendantPid, 0)).toThrow();
      expect(() => process.kill(foreign.pid!, 0)).not.toThrow();
      expect(signalSource.listenerCount("SIGINT") + signalSource.listenerCount("SIGTERM")).toBe(0);
    } finally { await terminateOwnedProcess(foreign, 60); }
  }, 10_000);

  test("page network wrappers allow only the fixture port", async () => {
    const fetch = vi.fn(async () => ({}));
    const context: any = { URL, Request, DOMException, location: new URL("http://127.0.0.1:43123/fixture"), fetch, WebSocket: class {} };
    runInNewContext(LOOPBACK_GUARD_SOURCE, context);
    await context.fetch("/local");
    for (const url of ["http://127.0.0.1:43124/private", "https://example.invalid/test"]) await expect(context.fetch(url)).rejects.toThrow("blocked");
    expect(() => new context.WebSocket("ws://127.0.0.1:43124/private")).toThrow("blocked");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("CDP intercepts off-fixture navigation and subresources before network", async () => {
    let listener: any;
    const cdp = { call: vi.fn(async () => ({})), close: vi.fn(), onEvent(callback: any) { listener = callback; } };
    await installLoopbackGuard(cdp, "session", "http://127.0.0.1:43123");
    for (const url of ["http://127.0.0.1:43123/module.js", "http://127.0.0.1:43124/private", "https://example.invalid/test"]) {
      listener({ method: "Fetch.requestPaused", sessionId: "session", params: { requestId: url, request: { url } } });
    }
    expect(cdp.call.mock.calls.map((args: any) => args[0])).toEqual(["Fetch.enable", "Page.addScriptToEvaluateOnNewDocument", "Fetch.continueRequest", "Fetch.failRequest", "Fetch.failRequest"]);
  });

  test("missing inventory cannot duplicate a child-provided runner diagnostic ID", () => {
    const result = validateSuiteResult({ ...suiteResult("ui", "passed"), checks: [{ id: "runner.required", status: "passed", durationMs: 0 }] }, "ui", ["ui.probe"]);
    expect(result.status).toBe("failed");
    expect(new Set(result.checks.map((check: any) => check.id)).size).toBe(result.checks.length);
  });

  test("reporter accepts the real inventory above 512 while retaining a finite accumulation limit", () => {
    expect(REQUIRED_CHECK_IDS.ui.length).toBeGreaterThan(512);
    const reporter = createSuiteReporter("ui");
    for (const id of REQUIRED_CHECK_IDS.ui) reporter.check(id, true, undefined, 0, id);
    expect(validateSuiteResult(reporter.finish(), "ui", REQUIRED_CHECK_IDS.ui).status).toBe("passed");
    for (let i = REQUIRED_CHECK_IDS.ui.length; i < 1024; i++) reporter.check(`budget-${i}`, true);
    expect(() => reporter.check("over-budget", true)).toThrow("excessive");
    expect(reporter.finish().checks).toHaveLength(1024);
  });

  test.each(["ui", "meeting"] as const)("%s inventory supports additions and requires every declared check", (suite) => {
    const addedId = `${suite}.new-required-probe`;
    const required = [...REQUIRED_CHECK_IDS[suite], addedId];
    const checks = required.map(id => ({ id, status: "passed", durationMs: 0 }));
    const report = { id: suite, status: "passed", durationMs: 1, checks };
    expect(validateSuiteResult(report, suite, required).status).toBe("passed");
    for (const id of required) {
      expect(validateSuiteResult({ ...report, checks: checks.filter(check => check.id !== id) }, suite, required).status).toBe("failed");
    }
    for (const status of ["failed", "skipped"]) {
      expect(validateSuiteResult({ ...report, checks: checks.map(check => check.id === addedId ? { ...check, status } : check) }, suite, required).status).toBe("failed");
    }
    expect(() => validateSuiteResult({ ...report, checks: [...checks, checks[0]] }, suite, required)).toThrow("duplicate");
    expect(() => validateSuiteResult({ ...report, checks: [...checks, { id: " ", status: "passed", durationMs: 0 }] }, suite, required)).toThrow("Invalid");
  });

  test.each([["ui.probe", "ui.probe"], [" "], [""]])("rejects invalid required declaration %j", (...required) => {
    expect(() => validateSuiteResult(suiteResult("ui", "passed"), "ui", required)).toThrow("required check declaration");
  });

});

test("refuses fake microphone opt-in unless Chromium reports the owned fake-device launch", async () => {
  const cdp = { call: async () => ({ arguments: ["--headless=new"] }), onEvent: () => {} };
  await expect(installLoopbackGuard(cdp, "session", "http://127.0.0.1:43123", { fakeMicrophone: true })).rejects.toThrow("fake-device launch");
});
