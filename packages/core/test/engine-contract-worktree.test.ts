import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { AgentSummarySchema, WorktreeExplainWriteResultSchema, WorktreeLeaseSchema, WorktreeLeaseViewSchema } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);

const OWNER = "6f1c0d9e-0b2a-4d3f-9a11-8c7b6e5d4c3b";
const OTHER = "2b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b";
const KEY = "task-4c3b2a19-8d7e-4f6a-9b5c-0d1e2f3a4b5c";

function fixtureWorktreeDir(key = KEY): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chimera-lease-engine-")));
  const wt = join(root, ".chimera", "worktrees", key);
  mkdirSync(wt, { recursive: true });
  return wt;
}

// F22.2: worktree.leaseList/leaseHandoff/leaseRelease round-tripped through Engine.handle()'s
// RpcContract dispatch, plus the operator-or-holder-only refusal that lives in engine.ts (the
// lease store itself has no notion of a caller — see worktree-lease.ts).
describe("Engine worktree.lease* RpcContract dispatch (F22.2)", () => {
  it("leaseList reflects an acquired lease, shaped as WorktreeLeaseView", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const wt = fixtureWorktreeDir();
    e.worktreeLeases.acquire(KEY, wt, OWNER);

    const list = await e.handle("worktree.leaseList", {});
    expect(Array.isArray(list)).toBe(true);
    expect((list as unknown[]).map((v) => WorktreeLeaseViewSchema.parse(v))).toEqual([
      expect.objectContaining({ workdirKey: KEY, ownerAgentId: OWNER }),
    ]);
  });

  it("leaseHandoff without callerAgentId (direct/operator RPC) always succeeds, regardless of current holder", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const wt = fixtureWorktreeDir();
    e.worktreeLeases.acquire(KEY, wt, OWNER);

    const handed = await e.handle("worktree.leaseHandoff", { workdirKey: KEY, toAgentId: OTHER });
    expect(WorktreeLeaseSchema.parse(handed)).toMatchObject({ workdirKey: KEY, ownerAgentId: OTHER });
  });

  it("leaseHandoff with a callerAgentId that is NOT the current holder is refused (GuardrailError)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const wt = fixtureWorktreeDir();
    e.worktreeLeases.acquire(KEY, wt, OWNER);

    await expect(e.handle("worktree.leaseHandoff", { workdirKey: KEY, toAgentId: OTHER, callerAgentId: OTHER }))
      .rejects.toMatchObject({ code: "guardrail" });
    // refused -> nothing changed
    const list = await e.handle("worktree.leaseList", {}) as Array<{ ownerAgentId: string }>;
    expect(list[0]?.ownerAgentId).toBe(OWNER);
  });

  it("leaseHandoff with a callerAgentId that IS the current holder succeeds (self-service handoff via MCP)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const wt = fixtureWorktreeDir();
    e.worktreeLeases.acquire(KEY, wt, OWNER);

    const handed = await e.handle("worktree.leaseHandoff", { workdirKey: KEY, toAgentId: OTHER, callerAgentId: OWNER });
    expect(WorktreeLeaseSchema.parse(handed)).toMatchObject({ workdirKey: KEY, ownerAgentId: OTHER });
  });

  it("leaseRelease without force succeeds once the owner is no longer live (unknown agentId reads as not-live)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const wt = fixtureWorktreeDir();
    e.worktreeLeases.acquire(KEY, wt, OWNER);

    expect(await e.handle("worktree.leaseRelease", { workdirKey: KEY })).toEqual({ released: true });
  });

  it("leaseRelease with a foreign callerAgentId is refused even with force:true (operator-or-holder-only, not a liveness bypass)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const wt = fixtureWorktreeDir();
    e.worktreeLeases.acquire(KEY, wt, OWNER);

    await expect(e.handle("worktree.leaseRelease", { workdirKey: KEY, force: true, callerAgentId: OTHER }))
      .rejects.toMatchObject({ code: "guardrail" });
  });

  it("leaseRelease with force:true and no callerAgentId (operator) releases a still-owned key", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const wt = fixtureWorktreeDir();
    e.worktreeLeases.acquire(KEY, wt, OWNER);

    expect(await e.handle("worktree.leaseRelease", { workdirKey: KEY, force: true })).toEqual({ released: true });
    expect(await e.handle("worktree.leaseList", {})).toEqual([]);
  });

  it("leaseRelease by the current holder itself (callerAgentId matches owner) succeeds with force", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const wt = fixtureWorktreeDir();
    e.worktreeLeases.acquire(KEY, wt, OWNER);

    expect(await e.handle("worktree.leaseRelease", { workdirKey: KEY, force: true, callerAgentId: OWNER })).toEqual({ released: true });
  });
});

// F22.2 (QA of 01c9bb58): the OTHER half of the RPC surface — the projection the chips read and
// the honesty of leaseRelease's own return value.
describe("worktree lease projection + release honesty (F22.QA)", () => {
  it("agent.listSummary sends worktreeLeaseHeld even when false, so a handoff clears the chip on the next snapshot", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([[{ end: { resultText: "r" } }]])) });
    const wt = fixtureWorktreeDir();
    // The agent must be worktree-isolated: that is the only row the projection emits the boolean
    // for (a non-worktree agent can never hold a lease, and TOKEN-OPT-P1 keeps its summary tiny).
    const a = await e.supervisor.spawn({ prompt: "a", cwd: join(wt, "..", "..", ".."), isolation: "worktree", workdirKey: KEY });
    await new Promise((r) => setTimeout(r, 30));

    e.worktreeLeases.acquire(KEY, wt, a.agentId);
    const rowOf = async () => ((await e.handle("agent.listSummary", {})) as Array<Record<string, unknown>>)
      .find((r) => r["id"] === a.agentId)!;

    expect((await rowOf())["worktreeLeaseHeld"]).toBe(true);
    await e.handle("worktree.leaseHandoff", { workdirKey: KEY, toAgentId: OTHER });
    // The field must be PRESENT and false: ui-state reads it as authoritative-when-present and an
    // omitted field means "older daemon, keep the previous value" — which froze the chip on.
    const after = await rowOf();
    expect(after).toHaveProperty("worktreeLeaseHeld");
    expect(after["worktreeLeaseHeld"]).toBe(false);
    expect(AgentSummarySchema.safeParse(after).success).toBe(true);
  });

  it("leaseRelease reports the store's real answer: releasing an unknown key is released:false", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    expect(await e.handle("worktree.leaseRelease", { workdirKey: KEY })).toEqual({ released: false });

    const wt = fixtureWorktreeDir();
    e.worktreeLeases.acquire(KEY, wt, OWNER);
    expect(await e.handle("worktree.leaseRelease", { workdirKey: KEY, force: true })).toEqual({ released: true });
    expect(await e.handle("worktree.leaseRelease", { workdirKey: KEY, force: true })).toEqual({ released: false });
  });
});

// QA of F22 (finding 2): worktree_lease_list shipped as an MCP tool with NO caller check, so any
// agent could read every tenant's holder agentId, label and absolute worktree dir. The tool stays
// (it is the only way to confirm you hold a key before a handoff) but the MCP path now forces
// callerAgentId and the engine scopes the answer; the operator's direct RPC omits it and still
// sees the whole fleet, which is what the TUI/app lease views render.
describe("worktree.leaseList caller scoping (F22.QA)", () => {
  const OTHER_KEY = "task-9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

  async function twoLeases() {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    e.worktreeLeases.acquire(KEY, fixtureWorktreeDir(KEY), OWNER);
    e.worktreeLeases.acquire(OTHER_KEY, fixtureWorktreeDir(OTHER_KEY), OTHER);
    return e;
  }

  it("an agent caller sees only its own lease", async () => {
    const e = await twoLeases();
    expect(await e.handle("worktree.leaseList", { callerAgentId: OWNER })).toEqual([
      expect.objectContaining({ workdirKey: KEY, ownerAgentId: OWNER }),
    ]);
  });

  it("a caller holding nothing sees an empty list, not the fleet", async () => {
    const e = await twoLeases();
    expect(await e.handle("worktree.leaseList", { callerAgentId: "0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d" })).toEqual([]);
  });

  it("the operator (no callerAgentId) still sees every lease", async () => {
    const e = await twoLeases();
    const list = await e.handle("worktree.leaseList", {}) as unknown[];
    expect(list.map((v) => WorktreeLeaseViewSchema.parse(v).workdirKey).sort()).toEqual([KEY, OTHER_KEY].sort());
  });
});

// QA of F22 (finding 6): cfg.worktreeLease is read through TWO live closures built in engine.ts —
// one handed to the CapabilityBroker, one to the Supervisor — and dropping either silently disarms
// the gate (the supervisor closure falls back to "off"; a broker without the evaluator returns
// null). Only an ENGINE-level test proves the flag reaches both seams, which IS the rollback story.
describe("F22 rollback: cfg.worktreeLease reaches both engine seams (F22.QA)", () => {
  it("\"off\" permits a foreign-worktree write; config.patch to \"enforce\" refuses the very next one", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chimera-lease-mode-")));
    const wtA = join(root, ".chimera", "worktrees", KEY);
    mkdirSync(wtA, { recursive: true });
    const foreign: FakeStep[] = [
      { askPermission: { toolName: "Bash", input: { command: `git -C ${wtA} commit -am x` } } },
      { end: { resultText: "done" } },
    ];
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([foreign, foreign])) });
    // OWNER is not a running agent, so the lease reads "retained" — it blocks exactly as hard as
    // "active" and never races a fake scenario that terminates the instant it ends.
    e.worktreeLeases.acquire(KEY, wtA, OWNER);

    const tailOf = async (workdirKey: string) => {
      const rec = await e.supervisor.spawn({
        prompt: "x", cwd: root, isolation: "worktree", workdirKey,
        permissionProfile: "full", on: { permissionRequest: "auto" },
      });
      await e.supervisor.waitFor(rec.agentId, 2000);
      return await e.handle("agent.tail", { agentId: rec.agentId, n: 50 }) as { kind: string; data: Record<string, unknown> }[];
    };

    await e.handle("config.patch", { patch: { worktreeLease: "off" } });
    const permitted = await tailOf("task-off");
    expect(permitted.some((ev) => ev.kind === "policy_denied")).toBe(false);
    expect(permitted.filter((ev) => ev.kind === "tool_call")).toHaveLength(1);

    await e.handle("config.patch", { patch: { worktreeLease: "enforce" } });
    const refused = await tailOf("task-enforce");
    expect(refused.find((ev) => ev.kind === "policy_denied")?.data).toMatchObject({
      reason: "worktree_lease_foreign_write", workdirKey: KEY, owner: OWNER, ownerState: "retained",
    });
    expect(refused.filter((ev) => ev.kind === "tool_call")).toHaveLength(0);
  });
});

// QA of F15/F22 (M-1): the dry-run half of the write gate. F22's verdict §18 promised a
// worktree-write denial would be explainable "from day one" — i.e. ASKABLE BEFORE the write, not
// only readable off the refusal afterwards. `explainWrite` existed in the store but had zero
// production callers; these pin the RPC that makes it reachable, and pin that it answers about
// the SAME caller identity and the SAME evaluation the live permission gate uses.
describe("worktree.explainWrite dry-run (F15/F22.QA M-1)", () => {
  function riggedRoot(): { root: string; wtA: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chimera-lease-explain-")));
    const wtA = join(root, ".chimera", "worktrees", KEY);
    mkdirSync(wtA, { recursive: true });
    return { root, wtA };
  }

  it("operator RPC (no callerAgentId) reports a foreign leased worktree as a refusal, shaped as the wire schema", async () => {
    const { wtA } = riggedRoot();
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    e.worktreeLeases.acquire(KEY, wtA, OWNER);

    const res = WorktreeExplainWriteResultSchema.parse(
      await e.handle("worktree.explainWrite", { targets: [join(wtA, "src", "x.ts")] }),
    );
    expect(res).toMatchObject({ mode: "enforce", wouldRefuse: true, targets: [join(wtA, "src", "x.ts")] });
    expect(res.checks).toHaveLength(1);
    expect(res.checks[0]).toMatchObject({ name: "worktreeWriterLease", ok: false, skipped: false });
    // the detail is the operator's answer to "why" — it must name the holder, not just fail
    expect(res.checks[0]!.detail).toContain(OWNER);
  });

  it("an unleased worktree and a path outside every worktree are both allowed, and say which", async () => {
    const { root, wtA } = riggedRoot();
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });

    const unleased = await e.handle("worktree.explainWrite", { targets: [join(wtA, "x.ts")] }) as { wouldRefuse: boolean; checks: { ok: boolean; skipped: boolean; detail: string }[] };
    expect(unleased.wouldRefuse).toBe(false);
    expect(unleased.checks[0]).toMatchObject({ ok: true, skipped: false });

    const outside = await e.handle("worktree.explainWrite", { targets: [join(root, "README.md")] }) as { wouldRefuse: boolean; checks: { ok: boolean; skipped: boolean }[] };
    expect(outside.wouldRefuse).toBe(false);
    // skipped:true — this gate had nothing to say, which is NOT the same as "checked and fine"
    expect(outside.checks[0]).toMatchObject({ ok: true, skipped: true });
  });

  it("\"warn\" mode still fails the check but does NOT claim a refusal", async () => {
    const { wtA } = riggedRoot();
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    e.worktreeLeases.acquire(KEY, wtA, OWNER);
    await e.handle("config.patch", { patch: { worktreeLease: "warn" } });

    const res = await e.handle("worktree.explainWrite", { targets: [join(wtA, "x.ts")] }) as { mode: string; wouldRefuse: boolean; checks: { ok: boolean }[] };
    // the evaluation is mode-independent; only the CONSEQUENCE is not
    expect(res.checks[0]).toMatchObject({ ok: false });
    expect(res).toMatchObject({ mode: "warn", wouldRefuse: false });
  });

  it("asked AS an agent: own worktree allowed, foreign refused, relative target resolved against ITS cwd", async () => {
    const { root, wtA } = riggedRoot();
    const scenario: FakeStep[] = [{ end: { resultText: "done" } }];
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([scenario])) });
    e.worktreeLeases.acquire(KEY, wtA, OWNER);
    // materialize B's worktree: resolveWorkdirPath falls back to `cwd` for a not-yet-created
    // worktree (workdir.ts:100), and a relative target must resolve against the dir the agent
    // ACTUALLY execs in — the fallback included.
    const wtB = join(root, ".chimera", "worktrees", "task-b");
    mkdirSync(wtB, { recursive: true });
    const rec = await e.supervisor.spawn({
      prompt: "x", cwd: root, isolation: "worktree", workdirKey: "task-b",
      permissionProfile: "full", on: { permissionRequest: "auto" },
    });

    const own = await e.handle("worktree.explainWrite", { targets: [join(wtB, "x.ts")], callerAgentId: rec.agentId }) as { wouldRefuse: boolean; checks: { ok: boolean }[] };
    expect(own).toMatchObject({ wouldRefuse: false, checks: [{ ok: true }] });

    const foreign = await e.handle("worktree.explainWrite", { targets: [join(wtA, "x.ts")], callerAgentId: rec.agentId }) as { wouldRefuse: boolean };
    expect(foreign.wouldRefuse).toBe(true);

    // A relative path means nothing without a cwd, and the cwd that matters is the AGENT's (its
    // worktree), never the daemon's — the same resolution bashWriteTargets does on the live path.
    const rel = await e.handle("worktree.explainWrite", { targets: ["notes.md"], callerAgentId: rec.agentId }) as { targets: string[]; wouldRefuse: boolean };
    expect(rel.targets).toEqual([join(wtB, "notes.md")]);
    expect(rel.wouldRefuse).toBe(false);
  });

  it("the dry-run's answer is the live gate's answer: same target, same key, same owner", async () => {
    const { root, wtA } = riggedRoot();
    const scenario: FakeStep[] = [
      { askPermission: { toolName: "Bash", input: { command: `git -C ${wtA} commit -am x` } } },
      { end: { resultText: "done" } },
    ];
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([scenario])) });
    e.worktreeLeases.acquire(KEY, wtA, OWNER);
    const rec = await e.supervisor.spawn({
      prompt: "x", cwd: root, isolation: "worktree", workdirKey: "task-c",
      permissionProfile: "full", on: { permissionRequest: "auto" },
    });

    // asked BEFORE reading the outcome — this is the whole point of the surface
    const dry = await e.handle("worktree.explainWrite", { targets: [wtA], callerAgentId: rec.agentId }) as { wouldRefuse: boolean; targets: string[]; checks: { detail: string }[] };
    expect(dry.wouldRefuse).toBe(true);

    await e.supervisor.waitFor(rec.agentId, 2000);
    const tail = await e.handle("agent.tail", { agentId: rec.agentId, n: 50 }) as { kind: string; data: Record<string, unknown> }[];
    const denied = tail.find((ev) => ev.kind === "policy_denied");
    expect(denied?.data).toMatchObject({ reason: "worktree_lease_foreign_write", workdirKey: KEY, owner: OWNER });
    expect(denied?.data["target"]).toBe(dry.targets[0]);
    expect(dry.checks[0]!.detail).toContain(KEY);
    expect(dry.checks[0]!.detail).toContain(OWNER);
  });
});
