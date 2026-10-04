import { describe, it, expect } from "vitest";
import type { CapabilityDecisionEvent, ExplainCheck } from "@chimera/protocol";
import { CapabilityBroker, type WorktreeLeaseEvaluator } from "@chimera/core/broker";
import { WORKTREE_LEASE_CHECK, type WorktreeWriteBlock } from "@chimera/core/worktree-lease";

// F22 task 1: the broker seam only. The gate is INERT until task 2 wires call sites — so the
// "no seams" case below is the one that guarantees every existing broker construction is
// byte-identical to before this feature.

const CHECK: ExplainCheck = {
  name: WORKTREE_LEASE_CHECK, ok: false, skipped: false,
  detail: `worktree "task-7" is leased to agent owner-1 (live); you are task-9 — write in your own worktree or use worktree_lease_handoff`,
};
const BLOCK: WorktreeWriteBlock = {
  workdirKey: "task-7", owner: "owner-1", ownerState: "active", target: "/repo/.chimera/worktrees/task-7/f.ts", check: CHECK,
};

function makeBroker(mode: "enforce" | "warn" | "off", blocked: WorktreeWriteBlock | null = BLOCK) {
  const events: CapabilityDecisionEvent[] = [];
  const leases: WorktreeLeaseEvaluator = { evaluateWrite: () => ({ blocked }) };
  const broker = new CapabilityBroker(() => "allow", (e) => events.push(e), undefined, undefined, leases, () => mode);
  return { broker, events };
}

// The caller is a key + the dir that key names in THIS checkout (QA of F22); the stub evaluator
// ignores it, so the constant only has to type-check.
const CALLER = { key: "task-9", dir: "/repo/.chimera/worktrees/task-9" };

describe("CapabilityBroker.decideWorktreeWrite", () => {
  it("enforce: denies and emits exactly one worktree_write decision carrying owner + state", () => {
    const { broker, events } = makeBroker("enforce");
    const out = broker.decideWorktreeWrite("task-9", CALLER, [BLOCK.target]);
    expect(out?.decision).toBe("deny");
    expect(events).toEqual([{
      principal: "task-9", action: "worktree_write", resource: "task-7:owner-1",
      decision: "deny", reason: CHECK.detail,
      workdirKey: "task-7", owner: "owner-1", ownerState: "active",
    }]);
  });

  it("the emitted reason is the ExplainCheck detail verbatim — the ledger and the agent see one string", () => {
    const { broker, events } = makeBroker("enforce");
    const out = broker.decideWorktreeWrite("task-9", CALLER, [BLOCK.target]);
    expect(out?.reason).toBe(CHECK.detail);
    expect(out?.check).toEqual(CHECK);
    expect(events[0]!.reason).toBe(CHECK.detail);
  });

  it("warn: same event, same reason, but decision allow — the write goes through", () => {
    const { broker, events } = makeBroker("warn");
    expect(broker.decideWorktreeWrite("task-9", CALLER, [BLOCK.target])?.decision).toBe("allow");
    expect(events).toHaveLength(1);
    expect(events[0]!.decision).toBe("allow");
    expect(events[0]!.action).toBe("worktree_write");
  });

  it("off: returns null and emits nothing at all", () => {
    const { broker, events } = makeBroker("off");
    expect(broker.decideWorktreeWrite("task-9", CALLER, [BLOCK.target])).toBeNull();
    expect(events).toEqual([]);
  });

  it("an ALLOWED write returns null and emits nothing (no ledger amplification per tool call)", () => {
    const { broker, events } = makeBroker("enforce", null);
    expect(broker.decideWorktreeWrite("task-9", CALLER, [BLOCK.target])).toBeNull();
    expect(broker.decideWorktreeWrite("task-9", CALLER, [])).toBeNull();
    expect(events).toEqual([]);
  });

  it("a broker constructed WITHOUT the lease seams is unchanged by this feature", () => {
    const events: CapabilityDecisionEvent[] = [];
    const broker = new CapabilityBroker(() => "allow", (e) => events.push(e));
    expect(broker.decideWorktreeWrite("task-9", CALLER, [BLOCK.target])).toBeNull();
    expect(events).toEqual([]);
  });
});
