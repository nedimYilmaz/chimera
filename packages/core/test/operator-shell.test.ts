import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OperatorShell } from "../src/operator-shell.js";
import { RPC_CONTRACT } from "@chimera/protocol/contract";
import { Engine } from "../src/engine.js";
import { FakeAgentBackend } from "../src/backends/fake.js";
import { makeEngineHome } from "./helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); });
function setup(timeoutMs = 5000) {
  const home = mkdtempSync(join(tmpdir(), "chimera-shell-test-"));
  const emit = vi.fn(), deliver = vi.fn(async () => {});
  const deps = { home, target: () => ({ cwd: home }), emit, deliver, timeoutMs };
  const shell = new OperatorShell(deps);
  cleanups.push(() => { shell.dispose(); rmSync(home, { recursive: true, force: true }); });
  return { shell, home, emit, deliver, deps };
}
async function finished(shell: OperatorShell, agentId = "a") {
  await vi.waitFor(() => expect(shell.status(agentId)?.state).not.toBe("running"), { timeout: 6000 });
  return shell.status(agentId)!;
}

describe.skipIf(process.platform === "win32")("operator shell", () => {
  it("runs Bash in the exact agent cwd, records stdout/stderr and never reruns a lost acknowledgement", async () => {
    const { shell, home, deliver } = setup();
    const id = randomUUID(), command = 'printf x >> count; printf "%s" "$PWD"; printf "stderr" >&2';
    shell.start("a", id, command);
    expect(shell.start("a", id, command).requestId).toBe(id);
    const result = await finished(shell);
    expect(result).toMatchObject({ cwd: home, state: "done", exitCode: 0 });
    expect(result.output).toContain(home); expect(result.output).toContain("stderr");
    shell.start("a", id, command);
    expect(readFileSync(join(home, "count"), "utf8")).toBe("x");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]).toEqual(["a", expect.stringContaining("already executed"), `operator-shell:${id}`]);
    expect(() => shell.start("b", id, command)).toThrow(/another command/);
  });
  it("decodes UTF-8 across separate output chunks", async () => {
    const { shell } = setup();
    shell.start("a", randomUUID(), "printf '\\303'; sleep 0.05; printf '\\247'");
    expect((await finished(shell)).output).toBe("ç");
  });
  it("exposes failure and bounds output while continuing to drain the process", async () => {
    const { shell } = setup();
    shell.start("a", randomUUID(), "printf '%050000d' 0; exit 7");
    const result = await finished(shell);
    expect(result).toMatchObject({ exitCode: 7, state: "failed", truncated: true });
    expect(result.output.length).toBe(32768);
  });
  it("cancels the process group and refuses concurrent commands or another agent's cancellation", async () => {
    const { shell } = setup();
    const id = randomUUID();
    shell.start("a", id, "sleep 30 & wait");
    expect(() => shell.start("a", randomUUID(), "echo duplicate")).toThrow(/already running/);
    expect(() => shell.cancel("b", id)).toThrow(/Unknown/);
    shell.cancel("a", id);
    expect(await finished(shell)).toMatchObject({ state: "cancelled", error: "Cancelled by operator" });
  });
  it("times out unattended commands and records spawn errors without falling back to another cwd", async () => {
    const { shell } = setup(80);
    shell.start("a", randomUUID(), "sleep 30");
    expect(await finished(shell)).toMatchObject({ state: "failed", error: "Command timed out" });
    const other = setup();
    other.deps.target = () => ({ cwd: join(other.home, "missing") });
    other.shell.start("a", randomUUID(), "pwd");
    expect(await finished(other.shell)).toMatchObject({ state: "failed", exitCode: -2 });
  });
  it("a delivery failure keeps output and retry cannot execute again, including after restart", async () => {
    const { shell, deps, deliver } = setup();
    deliver.mockRejectedValue(new Error("agent held"));
    const id = randomUUID(); shell.start("a", id, "echo retained");
    await finished(shell);
    await vi.waitFor(() => expect(shell.status("a")?.deliveryError).toContain("agent held"));
    const restarted = new OperatorShell(deps);
    expect(restarted.start("a", id, "echo retained")).toMatchObject({ state: "done", output: "retained\n" });
    restarted.dispose();
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it("routes real command output into the same provider session without sending the raw bang prompt", async () => {
    const backend = new FakeAgentBackend([[{ awaitSend: true }, { awaitSend: true }]]);
    const engine = new Engine({ home: makeEngineHome(), backends: new Map([["claude", backend]]) });
    const { home } = setup();
    const agent = await engine.handle("agent.spawn", { spec: { prompt: "test", cwd: home, isolation: "none", persistent: true } }) as { agentId: string };
    try {
      await vi.waitFor(() => expect(engine.supervisor.status(agent.agentId).state).toBe("running"));
      const requestId = randomUUID();
      await engine.handle("agent.shellStart", { agentId: agent.agentId, requestId, command: "printf context-proof" }, { trustedLocalClient: true });
      await finished(engine.operatorShell, agent.agentId);
      await vi.waitFor(() => expect(backend.deliveries).toHaveLength(1));
      expect(backend.deliveries[0]?.text).toContain("already executed");
      expect(backend.deliveries[0]?.text).toContain("context-proof");
      expect(backend.spawns).toHaveLength(1);
    } finally { engine.operatorShell.dispose(); await engine.supervisor.kill(agent.agentId); }
  });
  it("reports unknown restart outcome and never reexecutes the durable command", async () => {
    const { shell, deps, home } = setup();
    const id = randomUUID(), command = "printf x >> count; sleep 30";
    shell.start("a", id, command);
    await vi.waitFor(() => expect(readFileSync(join(home, "count"), "utf8")).toBe("x"));
    const restarted = new OperatorShell(deps);
    expect(restarted.status("a")).toMatchObject({ state: "interrupted", error: expect.stringContaining("unknown") });
    expect(restarted.start("a", id, command).state).toBe("interrupted");
    expect(readFileSync(join(home, "count"), "utf8")).toBe("x");
    restarted.dispose(); shell.cancel("a", id);
    await vi.waitFor(() => expect(shell.status("a")?.state).toBe("cancelled"));
  });
  it("validates explicit command requests and refuses the untrusted/MCP route", async () => {
    const engine = new Engine({ home: makeEngineHome(), backends: new Map([["claude", new FakeAgentBackend([])]]) });
    cleanups.push(() => engine.operatorShell.dispose());
    for (const method of ["agent.shellStart", "agent.shellCancel", "agent.shellStatus"]) {
      await expect(engine.handle(method, { agentId: "a", requestId: randomUUID(), command: "echo forbidden" })).rejects.toThrow(/trusted desktop/);
    }
    expect(RPC_CONTRACT["agent.shellStart"].request.safeParse({ agentId: "a", requestId: "bad", command: "echo x" }).success).toBe(false);
    expect(RPC_CONTRACT["agent.shellStart"].request.safeParse({ agentId: "a", requestId: randomUUID(), command: " " }).success).toBe(false);
    await expect(engine.handle("agent.shellStart", { agentId: "a", requestId: randomUUID(), command: "echo x" }, { trustedLocalClient: true })).rejects.toThrow(/unknown agent/);
  });
});
