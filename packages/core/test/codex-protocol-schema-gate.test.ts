import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { boundedUnifiedDiff, runCodexProtocolCli, runSubprocess } from "../../../scripts/check-codex-protocol.mjs";
import { generateCodexProtocolSubset } from "../../../scripts/codex-protocol-subset.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const checkedInSubset = join(repositoryRoot, "packages/core/src/backends/codex-wire.generated.ts");
const checkerUrl = pathToFileURL(join(repositoryRoot, "scripts/check-codex-protocol.mjs")).href;

async function sha256(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function waitForFile(file: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

describe("Codex protocol subset freshness gate", () => {
  let testRoot: string;
  let generatedFixture: string;
  let expectedFile: string;
  let fakeCodex: string;
  let tempParent: string;
  let environment: NodeJS.ProcessEnv;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "chimera-codex-gate-test-"));
    generatedFixture = join(testRoot, "schema");
    expectedFile = join(testRoot, "expected.ts");
    fakeCodex = join(testRoot, "codex-fixture.mjs");
    tempParent = join(testRoot, "generated");
    await mkdir(join(generatedFixture, "v2"), { recursive: true });
    await mkdir(tempParent);
    await writeFile(join(generatedFixture, "ClientInfo.ts"), "export type ClientInfo = { name: string };\n");
    await writeFile(
      join(generatedFixture, "InitializeParams.ts"),
      'import type { ClientInfo } from "./ClientInfo";\nexport type InitializeParams = { clientInfo: ClientInfo };\n',
    );
    await writeFile(join(generatedFixture, "v2/UserInput.ts"), 'export type UserInput = { "type": "text", text: string };\n');
    await writeFile(join(generatedFixture, "v2/AskForApproval.ts"), 'export type AskForApproval = "never";\n');
    await writeFile(
      join(generatedFixture, "v2/ToolRequestUserInputResponse.ts"),
      "export type ToolRequestUserInputResponse = { answers: Record<string, string> };\n",
    );
    for (const type of ["ThreadGoalGetResponse", "ThreadGoalSetParams", "ThreadGoalSetResponse"]) {
      await writeFile(join(generatedFixture, `v2/${type}.ts`), `export type ${type} = { threadId: string };\n`);
    }
    await writeFile(expectedFile, generateCodexProtocolSubset(generatedFixture));
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli 9.9.9\\n");
  process.exit(0);
}
if (args[0] !== "app-server" || args[1] !== "generate-ts") process.exit(64);
if (process.env.FAKE_CODEX_MODE === "fail") {
  process.stderr.write("synthetic generation failure\\n");
  process.exit(7);
}
const output = args[args.indexOf("--out") + 1];
mkdirSync(output, { recursive: true });
if (process.env.FAKE_CODEX_MODE === "hang") {
  writeFileSync(process.env.FAKE_CODEX_PID_FILE, String(process.pid));
  process.on("SIGTERM", () => {
    writeFileSync(process.env.FAKE_CODEX_REAPED_FILE, "terminated");
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else {
  cpSync(process.env.FAKE_CODEX_SCHEMA, output, { recursive: true });
}
`);
    await chmod(fakeCodex, 0o755);
    environment = {
      ...process.env,
      FAKE_CODEX_SCHEMA: generatedFixture,
      FAKE_CODEX_MODE: "success",
    };
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  test("passes an exact fixture match and leaves both subsets unchanged", async () => {
    const repositoryHash = await sha256(checkedInSubset);
    const expectedHash = await sha256(expectedFile);
    const output: string[] = [];

    const exitCode = await runCodexProtocolCli({
      codexCommand: fakeCodex,
      env: environment,
      expectedFile,
      tempParent,
      stdout: { write: (value: string) => output.push(value) },
      stderr: { write: (value: string) => output.push(value) },
    });

    expect(exitCode).toBe(0);
    expect(output.join("")).toContain("Installed Codex CLI: codex-cli 9.9.9");
    expect(output.join("")).toContain("exact match");
    expect(await readdir(tempParent)).toEqual([]);
    expect(await sha256(expectedFile)).toBe(expectedHash);
    expect(await sha256(checkedInSubset)).toBe(repositoryHash);
  });

  test("fails a fixture mutation with a bounded diff, version, and manual commands", async () => {
    const repositoryHash = await sha256(checkedInSubset);
    const expectedHash = await sha256(expectedFile);
    await writeFile(
      join(generatedFixture, "v2/UserInput.ts"),
      'export type UserInput = { "type": "text", text: string, mutated: true };\n',
    );
    const output: string[] = [];

    const exitCode = await runCodexProtocolCli({
      codexCommand: fakeCodex,
      env: environment,
      expectedFile,
      tempParent,
      stdout: { write: (value: string) => output.push(value) },
      stderr: { write: (value: string) => output.push(value) },
    });
    const result = output.join("");

    expect(exitCode).toBe(1);
    expect(result).toContain("codex-cli 9.9.9");
    expect(result).toContain("--- packages/core/src/backends/codex-wire.generated.ts");
    expect(result).toContain("+++ generated Codex protocol subset");
    expect(result).toContain("codex app-server generate-ts --out <temporary-dir>");
    expect(result).toContain("node scripts/codex-protocol-subset.mjs <temporary-dir> > <temporary-subset>");
    expect(result.split("\n").length).toBeLessThanOrEqual(90);
    expect(await readdir(tempParent)).toEqual([]);
    expect(await sha256(expectedFile)).toBe(expectedHash);
    expect(await sha256(checkedInSubset)).toBe(repositoryHash);
  });

  test("truncates an oversized unified diff", () => {
    const expected = Array.from({ length: 120 }, (_, index) => `before-${index}`).join("\n");
    const generated = Array.from({ length: 120 }, (_, index) => `after-${index}`).join("\n");
    const diff = boundedUnifiedDiff(expected, generated);

    expect(diff.split("\n")).toHaveLength(80);
    expect(diff).toContain("... diff truncated at 80 lines ...");
  });

  test("fails when the CLI is missing", async () => {
    const output: string[] = [];
    const exitCode = await runCodexProtocolCli({
      codexCommand: join(testRoot, "missing-codex"),
      expectedFile,
      tempParent,
      stderr: { write: (value: string) => output.push(value) },
      stdout: { write: () => {} },
    });

    expect(exitCode).toBe(1);
    expect(output.join("")).toContain("Unable to run");
    expect(await readdir(tempParent)).toEqual([]);
  });

  test("fails a generator error and removes its unique temp directory", async () => {
    const output: string[] = [];
    const exitCode = await runCodexProtocolCli({
      codexCommand: fakeCodex,
      env: { ...environment, FAKE_CODEX_MODE: "fail" },
      expectedFile,
      tempParent,
      stderr: { write: (value: string) => output.push(value) },
      stdout: { write: () => {} },
    });

    expect(exitCode).toBe(1);
    expect(output.join("")).toContain("synthetic generation failure");
    expect(await readdir(tempParent)).toEqual([]);
  });

  test("fails when a required generated type is absent and cleans up", async () => {
    await rm(join(generatedFixture, "v2/AskForApproval.ts"));
    const output: string[] = [];
    const exitCode = await runCodexProtocolCli({
      codexCommand: fakeCodex,
      env: environment,
      expectedFile,
      tempParent,
      stderr: { write: (value: string) => output.push(value) },
      stdout: { write: () => {} },
    });

    expect(exitCode).toBe(1);
    expect(output.join("")).toContain("Missing expected Codex schema type: v2/AskForApproval.ts");
    expect(await readdir(tempParent)).toEqual([]);
  });

  test("times out generation, reaps the owned child, and cleans up", async () => {
    const pidFile = join(testRoot, "timeout.pid");
    const reapedFile = join(testRoot, "timeout.reaped");
    const output: string[] = [];

    const exitCode = await runCodexProtocolCli({
      codexCommand: fakeCodex,
      env: {
        ...environment,
        FAKE_CODEX_MODE: "hang",
        FAKE_CODEX_PID_FILE: pidFile,
        FAKE_CODEX_REAPED_FILE: reapedFile,
      },
      expectedFile,
      tempParent,
      timeoutMs: 1_000,
      stderr: { write: (value: string) => output.push(value) },
      stdout: { write: () => {} },
    });
    const pid = Number(await waitForFile(pidFile));

    expect(exitCode).toBe(1);
    expect(output.join("")).toContain("Timed out after 1000ms");
    expect(await waitForFile(reapedFile)).toBe("terminated");
    expect(await processIsAlive(pid)).toBe(false);
    expect(await readdir(tempParent)).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("timeout kills an inherited-pipe descendant after its group leader exits", async () => {
    const parent = join(testRoot, "exiting-parent.mjs");
    const leaderFile = join(testRoot, "leader.pid");
    await writeFile(parent, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);'], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
child.once("message", () => { writeFileSync(${JSON.stringify(leaderFile)}, String(process.pid)); child.disconnect(); process.exit(0); });
`);
    const running = runSubprocess(process.execPath, [parent], { timeoutMs: 1000 })
      .then(() => "unexpected success", (error: Error) => error.message);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await waitForFile(leaderFile);
      const result = await Promise.race([
        running,
        new Promise<string>((resolvePromise) => { watchdog = setTimeout(() => resolvePromise("hung"), 3000); }),
      ]);
      expect(result).toContain("Timed out after 1000ms");
    } finally {
      clearTimeout(watchdog);
      // Only the fixture's detached process group; also clean up a failing red run.
      const leader = Number(await readFile(leaderFile, "utf8"));
      try { process.kill(-leader, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      await running;
    }
  });

  test("SIGINT interrupts generation, reaps the child, and cleans up", async () => {
    const pidFile = join(testRoot, "interrupt.pid");
    const reapedFile = join(testRoot, "interrupt.reaped");
    const runner = join(testRoot, "runner.mjs");
    await writeFile(runner, `
import { runCodexProtocolCli } from ${JSON.stringify(checkerUrl)};
process.exitCode = await runCodexProtocolCli({
  codexCommand: process.env.FAKE_CODEX_COMMAND,
  expectedFile: process.env.FAKE_CODEX_EXPECTED,
  tempParent: process.env.FAKE_CODEX_TEMP_PARENT,
  timeoutMs: 5000,
});
`);
    const child = spawn(process.execPath, [runner], {
      env: {
        ...environment,
        FAKE_CODEX_MODE: "hang",
        FAKE_CODEX_COMMAND: fakeCodex,
        FAKE_CODEX_EXPECTED: expectedFile,
        FAKE_CODEX_TEMP_PARENT: tempParent,
        FAKE_CODEX_PID_FILE: pidFile,
        FAKE_CODEX_REAPED_FILE: reapedFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const ownedPid = Number(await waitForFile(pidFile));
    child.kill("SIGINT");
    const exitCode = await new Promise<number | null>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", resolvePromise);
    });

    expect(exitCode).toBe(130);
    expect(stderr).toContain("Interrupted while running");
    expect(await waitForFile(reapedFile)).toBe("terminated");
    expect(await processIsAlive(ownedPid)).toBe(false);
    expect(await readdir(tempParent)).toEqual([]);
  });
});
