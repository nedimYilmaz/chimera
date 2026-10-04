import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { SnapshotScheduler } from "@chimera/core/snapshot";
import { realDurableWriteDeps, type DurableWriteDeps } from "@chimera/core/durable-write";
import { reattachFromState } from "@chimera/core/reattach";
import { makeEngineHome } from "../../core/test/helpers.js";

// Mirrors exactly how packages/daemon/src/main.ts wires SnapshotScheduler + reattachFromState —
// this is the daemon-level integration test main.ts itself can't host directly (it's a script
// with top-level side effects, not an importable module; see reattach.ts's own REATTACHTEST
// precedent for extracting daemon boot glue into testable pieces).
describe("daemon snapshot durability + write-amp (FEATURE-4)", () => {
  it("writes state.json far less often than events land, and a restart reconstructs the true final state via replay", async () => {
    const home = makeEngineHome();
    const stateFile = join(home, "state.json");
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: { sessionId: "sess-1" } } },
      { emit: { kind: "message_delta", data: { text: "a" } } },
      { emit: { kind: "message_delta", data: { text: "b" } } },
      { end: { resultText: "final", costUsd: 0.3 } },
    ];
    const fake = new FakeAgentBackend([scenario]);
    const engine1 = new Engine({ home, backends: new Map([["claude", fake]]) });

    let renameCount = 0;
    const countingIo: DurableWriteDeps = {
      ...realDurableWriteDeps,
      renameSync: ((...args: unknown[]) => {
        renameCount++;
        return (realDurableWriteDeps.renameSync as unknown as (...a: unknown[]) => void)(...args);
      }) as unknown as DurableWriteDeps["renameSync"],
    };
    // A cadence high enough that only the mandatory writes happen: start()'s baseline, and the
    // roster-growth-forced flush when the agent is first registered. Every later event
    // (agent_started settling, message_delta x2, turn_complete, result — 5 total) must NOT
    // trip maxEvents/maxIntervalMs, leaving a real gap for replay to reconstruct.
    const scheduler = new SnapshotScheduler(engine1, stateFile, { maxEvents: 1000, maxIntervalMs: 1_000_000, io: countingIo });
    scheduler.start();

    await engine1.supervisor.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { agentId: "a1" });
    await engine1.supervisor.waitFor("a1", 2000);

    // write-amp fix: 5 events landed, but at most 2 durable writes (baseline + roster growth).
    expect(renameCount).toBeLessThan(5);
    expect(renameCount).toBeGreaterThan(0);

    // state.json on disk is STALE — it reflects whatever the roster-growth flush captured
    // (agent just registered, not yet "done").
    const onDisk = JSON.parse(readFileSync(stateFile, "utf8")) as { agents: Array<{ agentId: string; state: string }>; lastSeq: number };
    expect(onDisk.agents.find((a) => a.agentId === "a1")?.state).not.toBe("done");
    expect(onDisk.lastSeq).toBeLessThan(engine1.events.currentSeq());

    // "restart": a FRESH engine reading the SAME home (real EventLog re-parses events.jsonl
    // from disk, exactly like a real daemon boot after a crash).
    const engine2 = new Engine({ home, backends: new Map([["claude", new FakeAgentBackend([])]]) });
    reattachFromState(engine2, stateFile);
    await new Promise((r) => setTimeout(r, 20));

    // The prior agent was NOT a conductor and DID finish (state "done" after replay) — REATTACH-
    // TERMINAL-RECORDS rehydrates it for display, no resume/spawn attempt.
    const rec = engine2.supervisor.status("a1");
    expect(rec.state).toBe("done");
    expect(rec.resultText).toBe("final");
    expect(rec.costUsd).toBe(0.3);
  });
});
