import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// DISMISS-A-FINISHED-AGENT: the sessions bucket keeps a finished chat visible on purpose — the
// operator dismisses it, not the clock. But `agent.kill` on a terminal record is an honest
// no-op, so the ONLY state that would hide such a row (`killed`) was one a session that ended on
// its own could never reach: undismissable by construction. agent.forget is that dismissal.
// What must hold: it forgets exactly what was named, and never live work.

const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend([
  [{ end: { resultText: "finished" } }],
  [{ end: { resultText: "finished" } }],
  [{ awaitSend: true }],
])]]);
const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("agent.forget", () => {
  it("forgets the named finished agent and leaves other terminal records alone", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await e.handle("agent.spawn", { spec: { prompt: "a", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
    const b = await e.handle("agent.spawn", { spec: { prompt: "b", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
    await flush();

    const out = await e.handle("agent.forget", { agentIds: [a.agentId] }, { trustedLocalClient: true }) as
      { purged: number; agentIds: string[]; eventsRemoved: number; chronicleDocsRemoved: number };
    expect(out).toMatchObject({ purged: 1, agentIds: [a.agentId] });
    expect(() => e.supervisor.status(a.agentId)).toThrow();     // dismissed
    expect(e.supervisor.status(b.agentId)).toBeTruthy();        // the sweep did NOT widen

    // AGENT-FORGET: the run's EVENT HISTORY goes with the record. Before this it stayed in the
    // Events list (and in chronicle_search) forever — "forget" forgot only the row.
    expect(out.eventsRemoved).toBeGreaterThan(0);
    expect(e.events.replay({ fromSeq: 1, limit: 10_000 }).some((ev) => ev.agentId === a.agentId)).toBe(false);
    // ...and only that agent's. The other terminal record keeps its whole trail.
    expect(e.events.replay({ fromSeq: 1, limit: 10_000 }).some((ev) => ev.agentId === b.agentId)).toBe(true);
  });

  it("refuses a LIVE agent even when it is named explicitly — the guarantee is state, not the caller", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("agent.spawn", { spec: { prompt: "a", cwd: "/tmp", isolation: "none" } });
    await e.handle("agent.spawn", { spec: { prompt: "b", cwd: "/tmp", isolation: "none" } });
    const live = await e.handle("agent.spawn", { spec: { prompt: "live", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
    await flush();

    const out = await e.handle("agent.forget", { agentIds: [live.agentId] }, { trustedLocalClient: true }) as { purged: number };
    expect(out.purged).toBe(0);
    expect(e.supervisor.status(live.agentId)).toBeTruthy();
  });

  it("is a no-op for an id it has never heard of", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    // Nothing purged, and so nothing rewritten: a forget that touched the log for an id it never
    // heard of would rewrite segments for no reason.
    expect(await e.handle("agent.forget", { agentIds: ["nope"] }, { trustedLocalClient: true }))
      .toEqual({ requested: 1, skipped: [{ agentId: "nope", reason: "unknown" }], purged: 0, agentIds: [], eventsRemoved: 0, chronicleDocsRemoved: 0 });
  });
});
