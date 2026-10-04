import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { ExplainCheckSchema } from "@chimera/protocol";
import { GuardrailError } from "@chimera/core/errors";
import { WorktreeLeaseStore, leaseKeyForPath, WORKTREE_LEASE_CHECK } from "@chimera/core/worktree-lease";

// F22 task 1: the lease store in isolation. Nothing here is wired into supervisor/broker call
// sites yet (that is task 2) — these tests pin the ownership semantics the gate will rely on.

// Real 36-char uuids, NOT short fixtures: ExplainCheck.detail is capped at 240 chars and the
// natural sentence overflows with real ids — a test with "a1"/"a2" would never notice.
const OWNER = "6f1c0d9e-0b2a-4d3f-9a11-8c7b6e5d4c3b";
const CALLER = "2b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b";
const KEY = "task-4c3b2a19-8d7e-4f6a-9b5c-0d1e2f3a4b5c";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chimera-lease-")));
  const home = join(root, "home");
  const wt = join(root, "main", ".chimera", "worktrees", KEY);
  mkdirSync(wt, { recursive: true });
  return { root, home, wt, main: join(root, "main") };
}

function store(home: string, live: string[] = [], label?: (id: string) => string | null) {
  return new WorktreeLeaseStore(home, { isLive: (id) => live.includes(id), displayLabelFor: label });
}

describe("leaseKeyForPath", () => {
  it("returns the key + worktree dir for a path inside a worktree, null for one outside", () => {
    expect(leaseKeyForPath("/x/.chimera/worktrees/K/packages/core/src/f.ts"))
      .toEqual({ key: "K", worktreeDir: "/x/.chimera/worktrees/K" });
    expect(leaseKeyForPath("/x/.chimera/worktrees/K")).toEqual({ key: "K", worktreeDir: "/x/.chimera/worktrees/K" });
    expect(leaseKeyForPath("/x/packages/core/src/f.ts")).toBeNull();
  });

  it("A9: the main checkout itself is never inside a worktree, so it can never be leased", () => {
    expect(leaseKeyForPath("/x/main")).toBeNull();
    expect(leaseKeyForPath("/x/main/.chimera/worktrees")).toBeNull();
    // A9 (QA): a LOOKALIKE prefix is not a worktree — the match is per path SEGMENT, so no
    // sibling directory whose name merely starts with "worktrees" can ever be leased.
    expect(leaseKeyForPath("/x/.chimera/worktrees-old/K/f.ts")).toBeNull();
    expect(leaseKeyForPath("/x/.chimera/worktreesX/K/f.ts")).toBeNull();
    expect(leaseKeyForPath("/x/.chimera-old/worktrees/K/f.ts")).toBeNull();
  });

  it("normalizes `..` spellings, and a nested worktree resolves to the INNER owner", () => {
    expect(leaseKeyForPath("/x/.chimera/worktrees/K/sub/../f.ts")?.key).toBe("K");
    expect(leaseKeyForPath("/x/.chimera/worktrees/A/.chimera/worktrees/B/f.ts")?.key).toBe("B");
  });

  it("is LEXICAL: a symlinked spelling only resolves once the CALLER realpaths it", () => {
    const { root, wt } = fixture();
    const link = join(root, "shortcut");
    symlinkSync(wt, link);
    expect(leaseKeyForPath(join(link, "f.ts"))).toBeNull();
    expect(leaseKeyForPath(join(realpathSync(link), "f.ts"))?.key).toBe(KEY);
  });
});

describe("WorktreeLeaseStore.acquire", () => {
  it("creates a lease, and re-acquiring for the SAME owner is a no-op", () => {
    const { home, wt } = fixture();
    const s = store(home, [OWNER]);
    const first = s.acquire(KEY, wt, OWNER);
    expect(first.ownerAgentId).toBe(OWNER);
    expect(first.handoffs).toEqual([]);
    expect(s.acquire(KEY, wt, OWNER)).toEqual(first);
  });

  it("refuses to lease a directory that is not a .chimera/worktrees/<key> dir (A9)", () => {
    const { home, main } = fixture();
    const s = store(home);
    expect(() => s.acquire(KEY, main, OWNER)).toThrow(GuardrailError);
  });

  it("a TERMINAL owner is taken over, recording a {by:'relaunch'} handoff", () => {
    const { home, wt } = fixture();
    const s = store(home, []);   // nobody live
    s.acquire(KEY, wt, OWNER);
    const taken = s.acquire(KEY, wt, CALLER);
    expect(taken.ownerAgentId).toBe(CALLER);
    expect(taken.handoffs).toEqual([{ from: OWNER, to: CALLER, at: expect.any(Number), by: "relaunch" }]);
  });

  it("a LIVE owner blocks takeover with a GuardrailError naming BOTH agents (A1)", () => {
    const { home, wt } = fixture();
    const s = store(home, [OWNER]);
    s.acquire(KEY, wt, OWNER);
    expect(() => s.acquire(KEY, wt, CALLER)).toThrow(new RegExp(`${OWNER}[\\s\\S]*${CALLER}`));
  });
});

describe("WorktreeLeaseStore.ownerOf / list / heldBy", () => {
  it("reports ownerState active while the owner is live, retained once it is terminal", () => {
    const { home, wt } = fixture();
    const live = store(home, [OWNER]);
    live.acquire(KEY, wt, OWNER);
    expect(live.ownerOf(KEY)?.ownerState).toBe("active");
    expect(store(home, []).ownerOf(KEY)?.ownerState).toBe("retained");
  });

  it("A10: a lease whose worktree directory is gone self-prunes on lookup", () => {
    const { home, wt } = fixture();
    const s = store(home, [OWNER]);
    s.acquire(KEY, wt, OWNER);
    rmSync(wt, { recursive: true });
    expect(s.ownerOf(KEY)).toBeNull();
    expect(s.list()).toEqual([]);
    expect(readFileSync(join(home, "worktree-leases.json"), "utf8")).toBe("[]");
  });

  it("list() projects ownerState + display label; heldBy answers the reverse question", () => {
    const { home, wt } = fixture();
    const s = store(home, [OWNER], () => "planner");
    s.acquire(KEY, wt, OWNER);
    expect(s.list()).toEqual([{
      workdirKey: KEY, worktreeDir: wt, ownerAgentId: OWNER, acquiredAt: expect.any(Number),
      handoffs: [], ownerState: "active", ownerDisplayLabel: "planner",
    }]);
    expect(s.heldBy(OWNER)).toBe(true);
    expect(s.heldBy(CALLER)).toBe(false);
  });

  it("leases survive a restart (a new store over the same home)", () => {
    const { home, wt } = fixture();
    store(home, [OWNER]).acquire(KEY, wt, OWNER);
    expect(store(home, [OWNER]).ownerOf(KEY)?.lease.ownerAgentId).toBe(OWNER);
  });

  it("a corrupt lease file degrades to 'no leases' rather than throwing", () => {
    const { home, wt } = fixture();
    store(home, []).acquire(KEY, wt, OWNER);
    writeFileSync(join(home, "worktree-leases.json"), "{not json");
    expect(store(home, []).list()).toEqual([]);
  });
});

describe("WorktreeLeaseStore.handoff / release", () => {
  it("handoff records a {by:'rpc'} entry even while the owner is LIVE", () => {
    const { home, wt } = fixture();
    const s = store(home, [OWNER]);
    s.acquire(KEY, wt, OWNER);
    expect(s.handoff(KEY, CALLER).handoffs.at(-1)).toEqual({ from: OWNER, to: CALLER, at: expect.any(Number), by: "rpc" });
    expect(() => s.handoff("nope", CALLER)).toThrow(GuardrailError);
  });

  it("release refuses a LIVE owner without force, returns false for an unknown key", () => {
    const { home, wt } = fixture();
    const s = store(home, [OWNER]);
    s.acquire(KEY, wt, OWNER);
    expect(s.release("nope")).toBe(false);
    expect(() => s.release(KEY)).toThrow(GuardrailError);
    expect(s.release(KEY, { force: true })).toBe(true);
    expect(existsSync(wt)).toBe(true);   // releasing a lease never touches the worktree itself
  });
});

// A caller that owns nothing relevant: some other key, in its own directory under another main.
const OTHER_CALLER = { key: "other", dir: "/x/.chimera/worktrees/other" };

describe("WorktreeLeaseStore.explainWrite", () => {
  it("blocks a write into another agent's leased worktree with a valid, <=240-char ExplainCheck", () => {
    const { home, wt } = fixture();
    const s = store(home, []);
    s.acquire(KEY, wt, OWNER);
    const checks = s.explainWrite({ key: "other-key", dir: join(wt, "..", "other-key") }, [join(wt, "packages/core/src/f.ts")]);
    expect(checks).toHaveLength(1);
    expect(ExplainCheckSchema.parse(checks[0])).toEqual(checks[0]);
    expect(checks[0]!.name).toBe(WORKTREE_LEASE_CHECK);
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail.length).toBeLessThanOrEqual(240);
    expect(checks[0]!.detail).toContain(OWNER);
    expect(checks[0]!.detail).toContain(KEY);
  });

  it("allows the caller's OWN worktree, an unleased worktree, and paths outside every worktree", () => {
    const { home, wt } = fixture();
    const s = store(home, [OWNER]);
    s.acquire(KEY, wt, OWNER);
    expect(s.explainWrite({ key: KEY, dir: wt }, [join(wt, "f.ts")])[0]!.ok).toBe(true);
    expect(s.explainWrite(OTHER_CALLER, ["/x/.chimera/worktrees/unleased/f.ts"])[0]!.ok).toBe(true);
    const outside = s.explainWrite(OTHER_CALLER, ["/tmp/scratch.txt"])[0]!;
    expect(outside.ok).toBe(true);
    expect(outside.skipped).toBe(true);   // nothing to say: no target was inside a worktree at all
  });

  it("evaluateWrite carries the structured block the broker's event needs, and matches explainWrite", () => {
    const { home, wt } = fixture();
    const s = store(home, []);
    s.acquire(KEY, wt, OWNER);
    const target = join(wt, "f.ts");
    const { checks, blocked } = s.evaluateWrite({ key: CALLER, dir: join(wt, "..", CALLER) }, [target]);
    expect(blocked).toEqual({ workdirKey: KEY, owner: OWNER, ownerState: "retained", target, check: checks[0] });
    expect(s.explainWrite({ key: CALLER, dir: join(wt, "..", CALLER) }, [target])).toEqual(checks);
  });

  it("a key match with a DIFFERENT worktree dir is not this lease — allowed, never a false denial", () => {
    const { home, wt } = fixture();
    const s = store(home, []);
    s.acquire(KEY, wt, OWNER);
    expect(s.explainWrite(OTHER_CALLER, [`/some/other/main/.chimera/worktrees/${KEY}/f.ts`])[0]!.ok).toBe(true);
  });
});

// QA of F22 (finding 5): the own-worktree shortcut compared the KEY ONLY, three lines above the
// dir-proof check whose own comment already warns that a key can collide across two checkouts. A
// caller in checkout B could therefore write into checkout A's leased worktree while the
// ExplainCheck still said "every write target is in your own worktree or an unleased one".
describe("WorktreeLeaseStore.evaluateWrite — cross-checkout key collision (F22.QA)", () => {
  function twoCheckouts() {
    const f = fixture();
    const s = store(f.home, [OWNER]);
    s.acquire(KEY, f.wt, OWNER);                        // checkout A holds the lease
    const bWt = join(f.root, "other-main", ".chimera", "worktrees", KEY);
    mkdirSync(bWt, { recursive: true });                // checkout B: same key, different directory
    return { ...f, s, bWt };
  }

  it("a same-key caller in ANOTHER checkout is refused — key equality alone is not ownership", () => {
    const { s, wt, bWt } = twoCheckouts();
    const { checks, blocked } = s.evaluateWrite({ key: KEY, dir: bWt }, [join(wt, "f.ts")]);
    expect(blocked).toMatchObject({ workdirKey: KEY, owner: OWNER });
    expect(checks[0]!.ok).toBe(false);
  });

  it("that caller's OWN worktree stays writable — the dir proof must never invent a denial", () => {
    const { s, bWt } = twoCheckouts();
    expect(s.explainWrite({ key: KEY, dir: bWt }, [join(bWt, "f.ts")])[0]!.ok).toBe(true);
  });

  it("A11 still holds: two agents sharing a workdirKey INSIDE one checkout share the worktree", () => {
    const { s, wt } = twoCheckouts();
    expect(s.explainWrite({ key: KEY, dir: wt }, [join(wt, "f.ts")])[0]!.ok).toBe(true);
  });
});
