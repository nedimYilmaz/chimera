import { describe, it, expect } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "@chimera/core/backends/fake";
import { UnknownAgentError, GuardrailError } from "@chimera/core/supervisor";
import { ConfigError } from "@chimera/core/accounts";
import { makeMultiProviderSupervisor } from "./helpers.js";

// CROSS-PROVIDER-HANDOFF: agent.handoff — setAccount's explicit gap, filled. Unlike
// setModel/setEffort/setAccount (kill+respawn-with-resume under the SAME agentId), this
// spawns a FRESH agentId on a different provider/account with a built context package as its
// opening prompt, since a session id from one provider is meaningless to another.

const RUNNING_WITH_SESSION: FakeStep[] = [
  { emit: { kind: "agent_started", data: { sessionId: "sess-1" } } },
  { emit: { kind: "message_complete", data: { text: "found the bug in file src/foo.ts on branch feature/ABC-1" } } },
  { awaitSend: true },
];

function materializeWorktree(dir: string, agentId: string): string {
  const wt = join(dir, ".chimera", "worktrees", agentId);
  mkdirSync(wt, { recursive: true });
  return wt;
}

describe("AgentSupervisor.handoff", () => {
  it("throws UnknownAgentError for a ghost/unknown agentId", async () => {
    const { sup } = makeMultiProviderSupervisor([], []);
    await expect(sup.handoff("ghost", { toAccount: "cx-main", model: "gpt-5-codex" })).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it("refuses isolation:\"none\" agents (GuardrailError) — chimera can't vouch for state outside a worktree", async () => {
    const { sup } = makeMultiProviderSupervisor([RUNNING_WITH_SESSION], []);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "cl-main" });
    await new Promise((r) => setTimeout(r, 20));

    await expect(sup.handoff(rec.agentId, { toAccount: "cx-main", model: "gpt-5-codex" })).rejects.toBeInstanceOf(GuardrailError);
    expect(sup.status(rec.agentId).state).toBe("running");   // refused before touching the live process
  });

  it("refuses a worktree agent whose worktree dir is gone", async () => {
    const { sup, dir } = makeMultiProviderSupervisor([RUNNING_WITH_SESSION], []);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree", account: "cl-main" }, { agentId: "dead-1" });
    // never materialize dir/.chimera/worktrees/dead-1
    await expect(sup.handoff("dead-1", { toAccount: "cx-main", model: "gpt-5-codex" })).rejects.toBeInstanceOf(GuardrailError);
  });

  it("throws ConfigError for an unknown target account", async () => {
    const { sup, dir } = makeMultiProviderSupervisor([RUNNING_WITH_SESSION], []);
    const rec = await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree", account: "cl-main" }, { agentId: "src-1" });
    await new Promise((r) => setTimeout(r, 20));
    materializeWorktree(dir, "src-1");
    await expect(sup.handoff(rec.agentId, { toAccount: "ghost-account", model: "gpt-5-codex" })).rejects.toBeInstanceOf(ConfigError);
  });

  it("spawns a FRESH agentId on the target provider/account/model, re-entering the same worktree with isolation:\"none\" and no session resume", async () => {
    const { sup, codex, dir } = makeMultiProviderSupervisor([RUNNING_WITH_SESSION], [[{ awaitSend: true }]]);
    const rec = await sup.spawn(
      { prompt: "original brief: migrate the widget", cwd: dir, isolation: "worktree", account: "cl-main", permissionProfile: "acceptEdits" },
      { agentId: "src-2", treeId: "tree-x", depth: 1 },
    );
    await new Promise((r) => setTimeout(r, 20));
    const worktree = materializeWorktree(dir, "src-2");

    const next = await sup.handoff("src-2", { toAccount: "cx-main", model: "gpt-5-codex", note: "prioritize finishing the migration" });

    expect(next.agentId).not.toBe("src-2");                  // fresh agentId, not a resume-under-same-id
    expect(next.provider).toBe("codex");
    expect(next.accountName).toBe("cx-main");
    expect(next.treeId).toBe("tree-x");                      // lineage preserved
    expect(next.depth).toBe(1);
    expect(next.handoffFrom).toBe("src-2");
    expect(next.spec.permissionProfile).toBe("acceptEdits"); // inherited

    const spawned = codex.spawns[0]!;
    expect(spawned.cwd).toBe(worktree);                      // re-enters the SAME worktree
    expect(spawned.isolation).toBe("none");                  // worktree already exists
    expect(spawned.resume).toBe(null);                       // no cross-provider session resume
    expect(spawned.model).toBe("gpt-5-codex");
    expect(spawned.prompt).not.toBe("original brief: migrate the widget");   // a built package, not the raw prompt
    expect(spawned.prompt).toContain("original brief: migrate the widget");  // but carries it verbatim inside
    expect(spawned.prompt).toContain("prioritize finishing the migration");  // the operator note
    expect(spawned.prompt).toContain("feature/ABC-1");                      // mechanical anchor extraction picked up the branch mention
  });

  it("settles the source agent \"done\" (not \"killed\") with handoffTo stamped, priorState recorded", async () => {
    const { sup, dir, events } = makeMultiProviderSupervisor([RUNNING_WITH_SESSION], [[{ awaitSend: true }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree", account: "cl-main" }, { agentId: "src-3" });
    await new Promise((r) => setTimeout(r, 20));
    materializeWorktree(dir, "src-3");

    const next = await sup.handoff("src-3", { toAccount: "cx-main", model: "gpt-5-codex" });

    const source = sup.status("src-3");
    expect(source.state).toBe("done");                       // NOT "killed" — a deliberate handoff, not an error
    expect(source.handoffTo).toBe(next.agentId);

    const tail = events.tail("src-3", 50);
    const settle = tail.find((e) => e.kind === "status" && e.data["state"] === "done" && e.data["handoffTo"]);
    expect(settle?.data["priorState"]).toBe("running");
    expect(settle?.data["toAccount"]).toBe("cx-main");
    expect(settle?.data["toProvider"]).toBe("codex");
  });

  it("allows handoff from an already-terminal (failed) source and records that priorState — never silently relabels a real failure as a clean done", async () => {
    const { sup, dir, events } = makeMultiProviderSupervisor([RUNNING_WITH_SESSION], [[{ awaitSend: true }]]);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree", account: "cl-main" }, { agentId: "src-4" });
    await new Promise((r) => setTimeout(r, 20));
    materializeWorktree(dir, "src-4");
    await sup.kill("src-4");
    // simulate a quota-exhaustion-class failure rather than a plain kill, for realism
    const failed = { ...sup.status("src-4"), state: "failed" as const };
    (sup as unknown as { agents: Map<string, unknown> })["agents"].set("src-4", failed);

    const next = await sup.handoff("src-4", { toAccount: "cx-main", model: "gpt-5-codex" });

    expect(sup.status("src-4").state).toBe("done");
    const tail = events.tail("src-4", 50);
    const settle = tail.find((e) => e.kind === "status" && e.data["state"] === "done" && e.data["handoffTo"]);
    expect(settle?.data["priorState"]).toBe("failed");        // legible: this was a failure before it was handed off
    expect(next.handoffFrom).toBe("src-4");
  });

  it("forwards pending mailbox messages to the target instead of dropping them", async () => {
    const { sup, dir } = makeMultiProviderSupervisor([RUNNING_WITH_SESSION], [[{ awaitSend: true }]]);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree", account: "cl-main" }, { agentId: "src-5" });
    await new Promise((r) => setTimeout(r, 20));
    materializeWorktree(dir, "src-5");

    // reach the mailbox store the same way the supervisor does — via its own deps, exposed
    // through a cast since makeMultiProviderSupervisor doesn't return it directly.
    const deps = (sup as unknown as { deps: { mailboxes: { enqueue: (id: string, m: unknown) => void; pending: (id: string) => unknown[] } } }).deps;
    deps.mailboxes.enqueue("src-5", { from: "conductor-1", kind: "user_message", text: "also check the retry path" });

    const next = await sup.handoff("src-5", { toAccount: "cx-main", model: "gpt-5-codex" });

    expect(deps.mailboxes.pending("src-5")).toHaveLength(0);          // drained/acked on the source
    const forwarded = deps.mailboxes.pending(next.agentId);
    expect(forwarded).toHaveLength(1);
    expect((forwarded[0] as { from: string; text: string }).from).toBe("conductor-1");
    expect((forwarded[0] as { from: string; text: string }).text).toBe("also check the retry path");
  });

  it("carries deliverTo/maxBudgetUsd/membership through the spread — a waiting conductor is not stranded", async () => {
    const { sup, dir } = makeMultiProviderSupervisor([RUNNING_WITH_SESSION], [[{ awaitSend: true }]]);
    await sup.spawn(
      { prompt: "x", cwd: dir, isolation: "worktree", account: "cl-main", deliverTo: "conductor-9", maxBudgetUsd: 5 },
      { agentId: "src-6", membership: { team: "chimera-dev", role: "worker" } },
    );
    await new Promise((r) => setTimeout(r, 20));
    materializeWorktree(dir, "src-6");

    const next = await sup.handoff("src-6", { toAccount: "cx-main", model: "gpt-5-codex" });

    expect(next.spec.deliverTo).toBe("conductor-9");
    expect(next.spec.maxBudgetUsd).toBe(5);
    expect(next.membership).toEqual({ team: "chimera-dev", role: "worker" });
    expect(next.provider).toBe("codex");   // resolved from the target account, not carried from the source spec
  });

  // DISCOVERED WHILE WRITING THIS SUITE: a claude source spec with permissionProfile:"full"
  // handed off to a codex target hits codex's OWN pre-existing spawn guard (launch(), "codex
  // spawn refused: permissionProfile full maps to sandboxMode danger-full-access..." —
  // supervisor.ts's CODEX-GATE-EXPOSURE check) — codex has no decidePermission hook to enforce
  // what "full" means on claude, so it refuses unsandboxed access unless the caller explicitly
  // acknowledges the risk. handoff() does NOT special-case this: it reuses the real spawn()
  // path end to end, so this existing safety guard applies to a handoff exactly like any other
  // spawn — correct behavior, not a bug, and left un-bypassed deliberately (see the design
  // doctrine: a guardrail must refuse loudly and actionably, never be silently widened).
  it("surfaces codex's existing full-access guard on a handoff, exactly like any other spawn — never silently bypassed", async () => {
    const { sup, dir } = makeMultiProviderSupervisor([RUNNING_WITH_SESSION], []);
    await sup.spawn(
      { prompt: "x", cwd: dir, isolation: "worktree", account: "cl-main", permissionProfile: "full" },
      { agentId: "src-7" },
    );
    await new Promise((r) => setTimeout(r, 20));
    materializeWorktree(dir, "src-7");

    await expect(sup.handoff("src-7", { toAccount: "cx-main", model: "gpt-5-codex" })).rejects.toThrow(/danger-full-access/);
    // the source is marked "failed" (visible, actionable) rather than silently vanishing —
    // mirrors setModel/setAccount's own atomic-failure recovery.
    expect(sup.status("src-7").state).toBe("failed");
  });
});
