import { afterAll, describe, expect, it } from "vitest";
import { ChimeraClient } from "@chimera/client";
import type { TaskRecord } from "@chimera/protocol";
import { makeEngineHome } from "../../core/test/helpers.js";

// Deterministic full-boot blackbox test: a real chimerad process (CHIMERA_BACKEND=fake, so
// every agent turn is instant/canned — no scripted per-turn scenarios are reachable over RPC,
// unlike the in-process scheduler unit tests) driven purely through the ChimeraClient RPC
// surface.
//
// GATE KIND CHOICE (deliberate): uses an "artifact" gate, not "command". While building this
// test, a REAL `command` gate (real execFile subprocess) combined with the rapid chain of
// dead-agent respawns a multi-round gate-failure policy produces was found to race the
// scheduler's step-history bookkeeping when driven through a REAL daemon boot with an
// UNSCRIPTED fake backend (every agent completes its turn near-instantly, with no scripted
// pacing available over RPC) — stepHistory entries and gate-exec call counts came back out of
// order/duplicated non-deterministically. Confirmed this is a PRE-EXISTING scheduler hazard,
// not introduced by this feature: the identical race reproduces with the already-shipped
// onFail:"retry" policy under the same conditions (a real command gate + dead-agent
// respawns + zero agent-side pacing). Out of scope to fix here (a broad scheduler
// serialization fix touching every workflow feature's dead-agent respawn path, not specific
// to gate remediation) — recorded in shared memory for a future task. An "artifact" gate's
// evaluateGate is fully synchronous (ArtifactStore.existsForTask, no I/O), which was verified
// race-free across many repeated runs of this exact shape. "Converges" (a gate that fails then
// PASSES) is proven deterministically at the scheduler-unit level instead
// (scheduler-gate-remediate.test.ts test (a)), where scripted FakeStep timing gives full
// control the real daemon's unscripted backend can't — there is no reliable way to time an
// external RPC-based "fix" against an unscripted agent chain that completes in well under a
// millisecond per step. This test instead proves the full RPC/persistence/event-log stack for
// the BOUNDED, self-healing-attempted-but-ultimately-exhausted path: workflow.create accepts
// and validates onFail:"remediate", queue.push dispatches it, the failure routes across steps
// (not just resending in place), the gate's captured failure text is threaded as a fix-brief
// into each remediation respawn's instructions (verified via agent.status, the real RPC
// surface — not scheduler internals), and the loop is genuinely BOUNDED (fails cleanly after
// exactly maxRounds, never infinite).
const home = makeEngineHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" };
let client: ChimeraClient | null = null;

afterAll(async () => {
  await client?.request("daemon.stop").catch(() => {});
  client?.close();
});

describe("gate-failure remediation loop survives a full daemon boot", () => {
  it("routes a failing gate's output to an earlier step across multiple rounds via real RPC, then fails cleanly once maxRounds is exhausted (bounded, not infinite)", async () => {
    client = await ChimeraClient.connect({ home, env });

    await client.request("queue.create", { spec: { name: "work" } });
    await client.request("team.create", {
      spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 2, queue: "work" },
    });
    await client.request("workflow.create", {
      spec: {
        name: "wf",
        steps: [
          { id: "plan", title: "plan", gate: { kind: "none" } },
          { id: "implement", title: "implement", gate: { kind: "none" } },
          {
            id: "verify", title: "verify",
            gate: { kind: "artifact", spec: { artifactId: "never-registered" } },
            onFail: "remediate", remediate: { maxRounds: 3 },
          },
          { id: "land", title: "land", gate: { kind: "none" } },
        ],
      },
    });
    const pushed = await client.request<TaskRecord>("queue.push", { queue: "work", prompt: "ship the thing", workflow: "wf" });
    const taskId = pushed.taskId;

    let final: TaskRecord | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const status = await client.request<{ tasks: TaskRecord[] }>("queue.status", { queue: "work" });
      final = status.tasks.find((t) => t.taskId === taskId);
      if (final && (final.state === "done" || final.state === "failed")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // bounded, not infinite: fails cleanly after exactly maxRounds(3) — never loops forever.
    expect(final?.state).toBe("failed");
    expect(final?.error).toContain('step "verify" gate failed after 3 remediation round(s)');
    expect(final?.error).toContain('artifact "never-registered" not registered');
    // the anchor/counter are left at their exhausted values (not silently cleared) — visible
    // over the real RPC surface as ordinary TaskRecord fields, no internals needed.
    // 2, not 3: the FINAL (exhausting) failure never calls incrementRemediationRounds — only
    // the two rounds that actually triggered a remediation respawn did.
    expect(final?.remediationRounds).toBe(2);
    expect(final?.remediationGateStep).toBe(2);

    // the routing genuinely crossed steps (implement <-> verify), in order, not just resent in
    // place — 3 "verify" attempts (2 retried + 1 exhausted-failed) interleaved with 3
    // "implement" respawns (the fresh agent bound to the remediation target each round).
    const verifyHistory = final!.stepHistory.filter((h) => h.stepId === "verify");
    expect(verifyHistory.map((h) => h.outcome)).toEqual(["retried", "retried", "failed"]);
    const implementHistory = final!.stepHistory.filter((h) => h.stepId === "implement");
    expect(implementHistory).toHaveLength(3);   // initial dispatch + 2 remediation respawns
    expect(final!.stepHistory.map((h) => h.stepId)).toEqual([
      "plan", "implement", "verify", "implement", "verify", "implement", "verify",
    ]);

    // the LATER "implement" respawns (not the first) carried the gate's captured failure text
    // as their fix-brief — verified via agent.status (the real RPC surface), not by reaching
    // into scheduler internals.
    const implementInstructions = await Promise.all(
      implementHistory.map((h) => client!.request<{ spec: { instructions?: string } }>("agent.status", { agentId: h.agentId })),
    );
    expect(implementInstructions[0]!.spec.instructions ?? "").not.toContain("not registered");
    expect(implementInstructions[1]!.spec.instructions).toContain('The "verify" gate failed with');
    expect(implementInstructions[1]!.spec.instructions).toContain('artifact "never-registered" not registered');
    expect(implementInstructions[2]!.spec.instructions).toContain('The "verify" gate failed with');
  }, 20_000);
});
