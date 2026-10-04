import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// TERMINAL-RETENTION: OPT-IN (config.terminalRetention.enabled, default false) — it exists, but
// nothing deletes anything unless an operator turns it on. These tests drive the sweep directly,
// which is what the health tick does once enabled.
//
// Nothing aged finished agents out before it. MAX_TERMINAL_AGENTS_PERSISTED lightened
// them past 200 (heavy fields to the archive), but the ROW stayed forever — so a long-lived
// daemon accumulated a fleet list nobody could read, and "clean up N finished" was the only way
// out. Often confused with idleReap, which does the opposite: it releases a RUNNING agent's
// process and KEEPS its record.

const finished = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend(
  Array.from({ length: 8 }, () => [{ end: { resultText: "done" } }]),
)]]);
const held = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend(
  Array.from({ length: 8 }, () => [{ awaitSend: true }]),
)]]);
const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const spawn = async (e: Engine) =>
  (await e.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none" } })) as { agentId: string };

/** The sweep, reached the way the health tick reaches it. */
const sweep = (e: Engine, olderThanMs: number): void =>
  (e as unknown as { purgeExpiredTerminal(ms: number): void }).purgeExpiredTerminal(olderThanMs);

/** Backdate a terminal record so it reads as older than the window without waiting. */
const backdate = (e: Engine, agentId: string, ms: number): void => {
  const rec = e.supervisor.status(agentId) as unknown as { attempts: Array<{ endedAt?: number }>; createdAt: number };
  const then = Date.now() - ms;
  rec.createdAt = then;
  for (const a of rec.attempts) a.endedAt = then;
};

describe("finished agents age out", () => {
  it("forgets one whose end is older than the window", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: finished() });
    const a = await spawn(e);
    await flush();
    expect(["done", "failed", "killed"]).toContain(e.supervisor.status(a.agentId).state);

    backdate(e, a.agentId, 48 * 3_600_000);
    sweep(e, 24 * 3_600_000);
    expect(() => e.supervisor.status(a.agentId)).toThrow();
  });

  it("keeps a recently finished one — the window is the whole point", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: finished() });
    const a = await spawn(e);
    await flush();
    sweep(e, 24 * 3_600_000);
    expect(e.supervisor.status(a.agentId)).toBeTruthy();
  });

  it("NEVER touches a running or paused agent, however old — the guarantee the manual sweep makes", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: held() });
    const live = await spawn(e);
    await flush();
    const parked = await spawn(e);
    await flush();
    e.supervisor.reattachDormant(e.supervisor.status(parked.agentId));

    backdate(e, live.agentId, 999 * 3_600_000);
    backdate(e, parked.agentId, 999 * 3_600_000);
    sweep(e, 1);

    expect(e.supervisor.status(live.agentId).state).toBe("running");
    expect(e.supervisor.status(parked.agentId).state).toBe("paused");
  });

  it("drops the archived record and mailbox with it — the row is not the only thing it cost", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: finished() });
    const a = await spawn(e);
    await flush();
    e.mailboxes.enqueue(a.agentId, { from: "op", kind: "note", text: "hi" } as never);
    expect(e.mailboxes.pending(a.agentId).length).toBeGreaterThan(0);

    backdate(e, a.agentId, 48 * 3_600_000);
    sweep(e, 24 * 3_600_000);
    expect(e.mailboxes.pending(a.agentId)).toHaveLength(0);
  });

  it("announces what it forgot rather than shrinking the list silently", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: finished() });
    const a = await spawn(e);
    await flush();
    backdate(e, a.agentId, 48 * 3_600_000);
    sweep(e, 24 * 3_600_000);

    const said = e.events.tail(null, 50).some((ev) => ev.data["state"] === "purged_expired_terminal");
    expect(said).toBe(true);
  });

  it("is a no-op when nothing has expired — no event, no churn", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: finished() });
    await spawn(e);
    await flush();
    const before = e.events.tail(null, 100).length;
    sweep(e, 24 * 3_600_000);
    expect(e.events.tail(null, 100).length).toBe(before);
  });
});

describe("it is opt-in", () => {
  it("is OFF by default — a question about a list filter must never default to deleting history", async () => {
    const { ChimeraConfigSchema } = await import("@chimera/protocol");
    const cfg = ChimeraConfigSchema.parse({});
    expect(cfg.terminalRetention.enabled).toBe(false);
  });
});
