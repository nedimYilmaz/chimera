import { createMessage } from "../src/message-delivery.js";
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalAgentBackend } from "@chimera/core/backends/terminal";
import { TmuxTerminalHost, type Exec, type ExecResult } from "@chimera/core/terminal-runtime";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";

// TERMINAL-RUNTIME — the agent as a real CLI, driven through AgentBackend so the supervisor's
// whole lifecycle (records, mailbox, deliverTo, kill) keeps working untouched. Driven through the
// exec seam: no tmux binary, no session, no CLI.

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "tb-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function rig(opts: { available?: boolean; alive?: boolean } = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args): Promise<ExecResult> => {
    calls.push([file, ...args]);
    if (args[0] === "-V") return { code: opts.available === false ? null : 0, stdout: "tmux 3.6a", stderr: "" };
    if (args[0] === "has-session") return { code: opts.alive ? 0 : 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const home = tmp();
  const events: BackendEvent[] = [];
  const backend = new TerminalAgentBackend({
    host: new TmuxTerminalHost(exec), home, mcpBin: "/opt/chimera/chimera-mcp.js", nodeBin: "/usr/bin/node",
  });
  return { backend, events, calls, home, sink: (e: BackendEvent) => { events.push(e); },
    argsOf: (verb: string) => calls.find((c) => c[1] === verb) };
}

const spec = (over: Partial<ResolvedAgentSpec> = {}): ResolvedAgentSpec => ({
  agentId: "wispy-otter", accountName: "main", resolvedProvider: "claude",
  prompt: "audit the queue", cwd: "/tmp/work", depth: 0,
  env: { CHIMERA_AGENT_ID: "wispy-otter", CHIMERA_TREE_ID: "tree-1", ANTHROPIC_API_KEY: "sk-test" },
  ...over,
} as ResolvedAgentSpec);

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("starting a terminal agent", () => {
  it("runs the provider's CLI in a detached session and reports how to attach", async () => {
    const r = rig();
    r.backend.spawn(spec(), r.sink);
    await settle();
    const args = r.argsOf("new-session")!;
    expect(args.slice(args.indexOf("--"))).toContain("claude");
    const started = r.events.find((e) => e.kind === "agent_started")!;
    expect(started.data).toMatchObject({
      runtime: "terminal", provider: "claude", session: "chimera-wispy-otter",
      // The operator's way in, surfaced rather than left to be reconstructed.
      attach: "tmux attach -t chimera-wispy-otter",
    });
  });

  it("hands the CLI a chimera MCP config, so it is a fleet member and not a nearby process", async () => {
    const r = rig();
    r.backend.spawn(spec(), r.sink);
    await settle();
    const args = r.argsOf("new-session")!;
    const cfgPath = args[args.indexOf("--mcp-config") + 1]!;
    expect(args).toContain("--strict-mcp-config");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { mcpServers: Record<string, { env: Record<string, string>; args: string[] }> };
    // Identity comes from the SAME env the SDK path stamps — that is what makes memory_add,
    // ask_agent and agent_spawn attribute to this agent rather than to nobody.
    expect(cfg.mcpServers["chimera"]!.env["CHIMERA_AGENT_ID"]).toBe("wispy-otter");
    expect(cfg.mcpServers["chimera"]!.env["CHIMERA_TREE_ID"]).toBe("tree-1");
    expect(cfg.mcpServers["chimera"]!.args).toEqual(["/opt/chimera/chimera-mcp.js"]);
  });

  it("passes the model and the opening prompt, so the terminal starts on the work", async () => {
    const r = rig();
    r.backend.spawn(spec({ model: "claude-opus-5" }), r.sink);
    await settle();
    const args = r.argsOf("new-session")!;
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5");
    expect(args.at(-1)).toBe("audit the queue");
  });

  it("ADOPTS an existing session — a daemon restart must not strand a running agent", async () => {
    const r = rig({ alive: true });
    r.backend.spawn(spec(), r.sink);
    await settle();
    expect(r.argsOf("new-session")).toBeUndefined();
    expect(r.events.find((e) => e.kind === "agent_started")!.data["adopted"]).toBe(true);
  });
});

describe("when it cannot start", () => {
  it("reports a missing tmux as an ERROR EVENT, not an unhandled rejection", async () => {
    // The supervisor's crash/failover handling keys off the sink; a rejected promise here would
    // leave the agent hung in "running" with nothing said.
    const r = rig({ available: false });
    r.backend.spawn(spec(), r.sink);
    await settle();
    expect(String(r.events.find((e) => e.kind === "error")?.data["message"])).toMatch(/tmux is not installed/);
    expect(r.events.find((e) => e.kind === "agent_started")).toBeUndefined();
  });

  it("refuses a provider it has no CLI for instead of launching the wrong binary", async () => {
    // Guessing would look like the agent silently failing to start.
    const r = rig();
    r.backend.spawn(spec({ resolvedProvider: "deepseek" }), r.sink);
    await settle();
    expect(String(r.events.find((e) => e.kind === "error")?.data["message"])).toMatch(/no terminal CLI known/);
  });

  it("makes every control a no-op after a failed start, rather than throwing at the supervisor", async () => {
    const r = rig({ available: false });
    const handle = r.backend.spawn(spec(), r.sink);
    await settle();
    await expect(handle.send("hello")).resolves.toBeUndefined();
    await expect(handle.kill()).resolves.toBeUndefined();
  });
});

describe("driving a live terminal agent", () => {
  it.each(["claude", "codex", "kimi"])("preserves sender provenance for %s at startup and follow-up", async (provider) => {
    const r = rig();
    const metadata = { from: "reviewer", source: "agent" as const, kind: "user_message" as const, engineId: "local" };
    const delivery = { messages: [createMessage("audit the queue", metadata)] };
    const handle = r.backend.spawn(spec({ resolvedProvider: provider, initialDelivery: delivery }), r.sink);
    await settle();
    expect(r.argsOf("new-session")!.at(-1)).toBe(JSON.stringify({ message: { from: metadata.from, source: metadata.source } }) + "\n\naudit the queue");
    await handle.send("Follow-up", undefined, undefined, { messages: [createMessage("Follow-up", metadata)] });
    expect(r.argsOf("set-buffer")!.at(-1)).toBe(JSON.stringify({ message: { from: metadata.from, source: metadata.source } }) + "\n\nFollow-up");
    expect(r.argsOf("paste-buffer")).toContain("-p");
    expect(r.argsOf("send-keys")!.at(-1)).toBe("Enter");
  });

  it("DELIVERS a message by typing it and submitting — agent-to-agent mail, for free", async () => {
    // send() is the method the supervisor already calls to hand an agent a mailbox batch. Because
    // this backend implements it, cross-agent messaging works without any special casing.
    const r = rig();
    const handle = r.backend.spawn(spec(), r.sink);
    await settle();
    await handle.send("@wispy-otter please re-run the scan");
    const typed = r.calls.filter((c) => c[1] === "send-keys");
    expect(typed[0]!).toEqual(["tmux", "send-keys", "-t", "=chimera-wispy-otter", "-l", "--", "@wispy-otter please re-run the scan"]);
    expect(typed[1]!.at(-1)).toBe("Enter");
  });

  it("interrupts with Escape — the CLI's own stop, which leaves the session alive", async () => {
    // Ctrl-C can take the process down; that is kill()'s job, and conflating them would turn a
    // pause into a loss.
    const r = rig();
    const handle = r.backend.spawn(spec(), r.sink);
    await settle();
    await handle.interrupt();
    expect(r.argsOf("send-keys")!.at(-1)).toBe("Escape");
    expect(r.argsOf("kill-session")).toBeUndefined();
  });

  it("kills the whole session", async () => {
    const r = rig();
    const handle = r.backend.spawn(spec(), r.sink);
    await settle();
    await handle.kill();
    expect(r.argsOf("kill-session")!).toContain("=chimera-wispy-otter");
  });
});

describe("what a terminal agent refuses, and why", () => {
  it("asks the provider to compact by TYPING its command, which is what compactCommand means", async () => {
    // backend.ts defines compactCommand as "the same way an operator typing /compact into the
    // native CLI does". Here that is not an analogy.
    const r = rig();
    const handle = r.backend.spawn(spec(), r.sink);
    await settle();
    expect(handle.compactCommand).toBe("/compact");
  });

  it("offers no compact command for a provider that has none, rather than inventing one", async () => {
    // An invented command is a silent no-op; AgentSupervisor.compact refuses honestly instead.
    const r = rig();
    const handle = r.backend.spawn(spec({ resolvedProvider: "codex" }), r.sink);
    await settle();
    expect(handle.compactCommand).toBeUndefined();
  });
});
