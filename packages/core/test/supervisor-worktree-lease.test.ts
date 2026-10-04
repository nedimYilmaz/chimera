import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraConfigSchema, type CapabilityDecisionEvent } from "@chimera/protocol";
import { CapabilityBroker } from "@chimera/core/broker";
import { WorktreeLeaseStore } from "@chimera/core/worktree-lease";
import { realishPath } from "@chimera/core/hosttools";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor } from "./helpers.js";

// F22 (single-writer worktree lease), task 2: the GATE, exercised through the REAL
// decidePermission seam (FakeAgentBackend's askPermission) and the REAL launch() acquire.
// worktree-lease-store.test.ts and broker-worktree-write.test.ts already prove the two halves in
// isolation; what is only provable HERE is the wiring — that a spawn actually claims the lease,
// that a foreign write is actually refused, and that the mode flag actually reaches both.
//
// Liveness is injected as a Set rather than read off real agent state because it IS an injected
// seam (WorktreeLeaseDeps.isLive, which engine.ts closes over supervisor.isLive): a fake scenario
// reaches a terminal state the instant it ends, so keeping a "live" writer running would mean
// racing permissionTimeoutMs for no added coverage.

const WIDE_CFG = ChimeraConfigSchema.parse({
  accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
  autoOrder: ["main"],
  // the shared CFG caps at 2 total / 1 per account; these scenarios need three agents.
  caps: { maxAgentsTotal: 8, perAccount: { main: 8 } },
});

const bash = (command: string): FakeStep => ({ askPermission: { toolName: "Bash", input: { command } } });
const edit = (file_path: string): FakeStep => ({ askPermission: { toolName: "Edit", input: { file_path } } });
const END: FakeStep = { end: { resultText: "done" } };

function harness(
  mode: "enforce" | "warn" | "off",
  build: (wt: (key: string) => string, repo: string) => FakeStep[][],
) {
  // A REAL directory, not the "/repo" the sibling guard tests use: ownerOf self-prunes a lease
  // whose worktree dir is gone (A10), so a fictional cwd would silently allow every foreign write
  // and make every assertion in this file vacuous.
  const repo = mkdtempSync(join(tmpdir(), "chimera-leaserepo-"));
  const home = mkdtempSync(join(tmpdir(), "chimera-leasehome-"));
  const wt = (key: string) => {
    const dir = join(repo, ".chimera", "worktrees", key);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const live = new Set<string>();
  const store = new WorktreeLeaseStore(home, { isLive: (id) => live.has(id) });
  const decisions: CapabilityDecisionEvent[] = [];
  const leaseMode = () => mode;
  const capabilityBroker = new CapabilityBroker(
    () => "allow", (event) => decisions.push(event), undefined, undefined, store, leaseMode,
  );
  const { sup, events } = makeSupervisor(build(wt, repo), WIDE_CFG, {
    capabilityBroker, worktreeLeases: store, worktreeLeaseMode: leaseMode,
  });
  const spec = (workdirKey?: string, isolation: "worktree" | "none" = "worktree") => ({
    prompt: "x", cwd: repo, account: "main", isolation,
    permissionProfile: "full" as const, on: { permissionRequest: "auto" as const },
    ...(workdirKey !== undefined ? { workdirKey } : {}),
  });
  const run = async (workdirKey?: string, isolation: "worktree" | "none" = "worktree") => {
    const rec = await sup.spawn(spec(workdirKey, isolation));
    await sup.waitFor(rec.agentId, 1000);
    return rec;
  };
  return { sup, events, store, live, decisions, repo, wt, run };
}

const denialOf = (tail: { kind: string; data: Record<string, unknown> }[]) =>
  tail.find((e) => e.kind === "policy_denied")?.data;

describe("F22 gate: launch() acquires, decidePermission refuses a foreign writer", () => {
  it("refuses B's git write into live A's worktree, naming A, the key and the handoff path", async () => {
    // the RAW temp path is what B types: on macOS /var is a symlink to /private/var, so this also
    // proves launch() stored the lease dir in the SAME spelling the write-target detectors emit.
    let wtA = "";
    const h = harness("enforce", (wt) => {
      wtA = wt("task-a"); wt("task-b");
      return [[END], [bash(`git -C ${wtA} commit -am x`), END]];
    });
    const a = await h.run("task-a");
    // nothing but launch() could have written this record
    expect(h.store.heldBy(a.agentId)).toBe(true);
    h.live.add(a.agentId);

    const b = await h.run("task-b");
    const tail = h.events.tail(b.agentId, 50);
    expect(denialOf(tail)).toMatchObject({
      tool: "Bash", reason: "worktree_lease_foreign_write",
      workdirKey: "task-a", owner: a.agentId, ownerState: "active", target: realishPath(wtA),
    });
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(0);
    expect(h.sup.status(b.agentId).worktreeLeaseDenied).toBe(true);
    expect(h.sup.status(b.agentId).lastWorktreeLeaseDenial).toMatchObject({ workdirKey: "task-a", owner: a.agentId });
    const decision = h.decisions.find((d) => d.action === "worktree_write");
    expect(decision?.decision).toBe("deny");
    expect(decision?.reason).toContain(a.agentId);
    expect(decision?.reason).toContain("worktree_lease_handoff");
  });

  it("leaves each agent's writes INTO ITS OWN worktree untouched", async () => {
    let wtA = "", wtB = "";
    const h = harness("enforce", (wt) => {
      wtA = wt("task-a"); wtB = wt("task-b");
      return [[bash(`git -C ${wtA} commit -am x`), END], [bash(`git -C ${wtB} commit -am x`), END]];
    });
    const a = await h.run("task-a");
    h.live.add(a.agentId);
    const b = await h.run("task-b");
    for (const id of [a.agentId, b.agentId]) {
      const tail = h.events.tail(id, 50);
      expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
      expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
    }
    expect(h.decisions.filter((d) => d.action === "worktree_write")).toHaveLength(0);
  });

  it("refuses an isolation:\"none\" agent's Edit into a leased worktree with the no-worktree-of-your-own wording", async () => {
    let wtA = "";
    const h = harness("enforce", (wt) => {
      wtA = wt("task-a");
      return [[END], [edit(`${wtA}/packages/core/src/x.ts`), END]];
    });
    const a = await h.run("task-a");
    h.live.add(a.agentId);
    const c = await h.run(undefined, "none");
    expect(denialOf(h.events.tail(c.agentId, 50))).toMatchObject({
      tool: "Edit", reason: "worktree_lease_foreign_write", owner: a.agentId,
    });
    expect(h.decisions.find((d) => d.action === "worktree_write")?.reason)
      .toContain("you have no worktree of your own");
  });

  it("A13: a WORKTREE agent's Edit into a foreign worktree still trips the older main-source guard first", async () => {
    // Not a gap: a worktree lives at <cwd>/.chimera/worktrees/<key>, i.e. under main and outside
    // the caller's own worktree, so findMainSourceWrite matches it. That guard's payload must stay
    // byte-identical with the lease gate armed — which is exactly why the case above uses an
    // isolation:"none" caller to reach the lease gate through an Edit at all.
    let wtA = "";
    const h = harness("enforce", (wt) => {
      wtA = wt("task-a"); wt("task-b");
      return [[END], [edit(`${wtA}/packages/core/src/x.ts`), END]];
    });
    const a = await h.run("task-a");
    h.live.add(a.agentId);
    const b = await h.run("task-b");
    expect(denialOf(h.events.tail(b.agentId, 50))).toMatchObject({
      tool: "Edit", reason: "worktree_main_source_write", target: realishPath(`${wtA}/packages/core/src/x.ts`),
    });
  });

  it("A11: two agents sharing a workdirKey never block each other, and the second spawn does not fail", async () => {
    // scheduler.ts's runCritic spawns the critic with the still-live WORKER's workdirKey, so a
    // propagating acquire would fail every critic-gate spawn in the fleet.
    let wtA = "";
    const h = harness("enforce", (wt) => {
      wtA = wt("task-a");
      return [[END], [bash(`git -C ${wtA} commit -am x`), END]];
    });
    const a = await h.run("task-a");
    h.live.add(a.agentId);
    const critic = await h.run("task-a");
    const tail = h.events.tail(critic.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
    // the contention is recorded rather than silent, and A keeps the record
    expect(tail.some((e) => e.kind === "status" && typeof e.data["worktreeLeaseContended"] === "string")).toBe(true);
    expect(h.store.ownerOf("task-a")?.lease.ownerAgentId).toBe(a.agentId);
  });

  it("a SETTLED owner still refuses a foreign writer (retained), but a same-key relaunch takes over", async () => {
    let wtA = "";
    const h = harness("enforce", (wt) => {
      wtA = wt("task-a"); wt("task-b");
      return [[END], [bash(`git -C ${wtA} commit -am x`), END], [END]];
    });
    const a = await h.run("task-a");          // never added to `live` — settled from the store's view
    const b = await h.run("task-b");
    expect(denialOf(h.events.tail(b.agentId, 50))).toMatchObject({
      reason: "worktree_lease_foreign_write", owner: a.agentId, ownerState: "retained",
    });
    const relaunched = await h.run("task-a");
    expect(h.store.ownerOf("task-a")?.lease.ownerAgentId).toBe(relaunched.agentId);
  });

  it("A10: removing the worktree directory drops the lease, so the write is allowed again", async () => {
    let wtA = "";
    const h = harness("enforce", (wt) => {
      wtA = wt("task-a"); wt("task-b");
      return [[END], [bash(`git -C ${wtA} commit -am x`), END]];
    });
    const a = await h.run("task-a");
    h.live.add(a.agentId);
    rmSync(wtA, { recursive: true, force: true });   // what `git worktree remove` does at land time
    const b = await h.run("task-b");
    const tail = h.events.tail(b.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
    expect(h.store.heldBy(a.agentId)).toBe(false);
  });

  it("never touches the sanctioned land-on-main git flow while another agent's lease is live", async () => {
    // The one false deny that would halt the fleet: `merge --no-ff` targets the MAIN checkout, which
    // has no .chimera/worktrees/<key> segment, so no layout resolves and the guard must fall through.
    let repoDir = "";
    const h = harness("enforce", (wt, repo) => {
      repoDir = repo; wt("task-a"); wt("task-b");
      return [[END], [bash(`git -C ${repo} merge --no-ff chimera/task-a`), END]];
    });
    const a = await h.run("task-a");
    h.live.add(a.agentId);
    const b = await h.run("task-b");
    const tail = h.events.tail(b.agentId, 50);
    expect(repoDir).not.toBe("");
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
    expect(h.decisions.filter((d) => d.action === "worktree_write")).toHaveLength(0);
  });
});

describe("F22 rollback: the worktreeLease mode flag", () => {
  it("\"warn\" records what it WOULD have refused and refuses nothing", async () => {
    let wtA = "";
    const h = harness("warn", (wt) => {
      wtA = wt("task-a"); wt("task-b");
      return [[END], [bash(`git -C ${wtA} commit -am x`), END]];
    });
    const a = await h.run("task-a");
    h.live.add(a.agentId);
    const b = await h.run("task-b");
    const tail = h.events.tail(b.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
    expect(h.sup.status(b.agentId).worktreeLeaseDenied).toBeUndefined();
    // the audit trail is the whole point of warn mode: same event, same reason, decision flipped
    const decision = h.decisions.find((d) => d.action === "worktree_write");
    expect(decision).toMatchObject({ decision: "allow", workdirKey: "task-a", owner: a.agentId });
    expect(decision?.reason).toContain("worktree_lease_handoff");
  });

  it("\"off\" is inert — no lease acquired at launch, no decision emitted, nothing refused", async () => {
    let wtA = "";
    const h = harness("off", (wt) => {
      wtA = wt("task-a"); wt("task-b");
      return [[END], [bash(`git -C ${wtA} commit -am x`), END]];
    });
    const a = await h.run("task-a");
    expect(h.store.heldBy(a.agentId)).toBe(false);
    h.live.add(a.agentId);
    const b = await h.run("task-b");
    const tail = h.events.tail(b.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
    // host-tool allow decisions still flow; what "off" must produce is not one worktree_write event
    expect(h.decisions.filter((d) => d.action === "worktree_write")).toHaveLength(0);
  });
});
