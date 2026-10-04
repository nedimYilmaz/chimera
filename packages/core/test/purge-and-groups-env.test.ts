import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// PURGE-TERMINAL-SESSIONS: agent.killMany ENDS live sessions; agent.purgeTerminal FORGETS
// finished ones. Without it a long-lived fleet accumulates thousands of terminal records that
// ride state.json on every snapshot, ship in every agent.list, and hold an archived record plus
// a mailbox on disk — on a real home, 185MB of mailboxes against 12MB of archived records — with
// no operator gesture to say "I am done with these".

// One script that ends immediately (the agent that will be purged) and one that parks on
// awaitSend (the live agent that must survive the sweep).
const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend([[{ end: { resultText: "finished" } }], [{ awaitSend: true }], [{ end: { resultText: "finished" } }]])]]);
const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("agent.purgeTerminal", () => {
  it("forgets terminal records and leaves live ones alone", async () => {
    const home = makeEngineHome();
    const e = new Engine({ home, backends: backends() });
    const spawned = await e.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
    await flush();
    // the script ends on its own — "terminal" is what purge keys on, not "killed" specifically
    expect(["done", "failed", "killed"]).toContain(e.supervisor.status(spawned.agentId).state);

    const live = await e.handle("agent.spawn", { spec: { prompt: "still going", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
    await flush();

    const out = await e.handle("agent.purgeTerminal", {}) as { purged: number };
    expect(out.purged).toBeGreaterThanOrEqual(1);
    expect(() => e.supervisor.status(spawned.agentId)).toThrow();   // forgotten
    expect(e.supervisor.status(live.agentId)).toBeTruthy();          // untouched
  });

  it("deletes the purged agent's mailbox — where the disk actually is", async () => {
    const home = makeEngineHome();
    const e = new Engine({ home, backends: backends() });
    const a = await e.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
    await flush();
    e.mailboxes.enqueue(a.agentId, { from: "op", kind: "note", text: "hi" } as never);
    const box = join(home, "mailboxes", `${a.agentId}.jsonl`);
    expect(existsSync(box)).toBe(true);

    await flush();
    await e.handle("agent.purgeTerminal", {});
    expect(existsSync(box)).toBe(false);
  });

  it("is a no-op with nothing terminal to forget", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    expect(await e.handle("agent.purgeTerminal", {})).toEqual({ purged: 0 });
  });
});

// The line that matters, and the one the operator asked to be sure of: a PAUSED agent is not
// finished. Since lazy reattach every prior agent comes back paused, and an idle-reaped one
// parks there too — sweeping those would delete resumable work and its history, which is the
// opposite of housekeeping.
describe("purge never touches live work", () => {
  it("leaves a paused agent, its record and its mailbox completely alone", async () => {
    const home = makeEngineHome();
    const e = new Engine({ home, backends: backends() });
    const a = await e.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
    await flush();
    // park it exactly the way a daemon restart does
    e.supervisor.reattachDormant(e.supervisor.status(a.agentId));
    e.mailboxes.enqueue(a.agentId, { from: "op", kind: "note", text: "waiting for you" } as never);
    expect(e.supervisor.status(a.agentId).state).toBe("paused");

    const out = await e.handle("agent.purgeTerminal", {}) as { purged: number };

    expect(e.supervisor.status(a.agentId).state).toBe("paused");                    // still there
    expect(existsSync(join(home, "mailboxes", `${a.agentId}.jsonl`))).toBe(true);   // mail intact
    expect(e.mailboxes.pending(a.agentId).length).toBeGreaterThan(0);
    expect(out.purged).toBe(0);
  });

  it("sweeps every terminal state — done, failed and killed alike", () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const sup = e.supervisor as unknown as { agents: Map<string, { agentId: string; state: string }> };
    for (const [id, state] of [["d", "done"], ["f", "failed"], ["k", "killed"], ["r", "running"], ["p", "paused"]] as const) {
      sup.agents.set(id, { agentId: id, state } as never);
    }
    const purged = e.supervisor.purgeTerminal().sort();
    expect(purged).toEqual(["d", "f", "k"]);
    expect([...sup.agents.keys()].sort()).toEqual(["p", "r"]);
  });
});
