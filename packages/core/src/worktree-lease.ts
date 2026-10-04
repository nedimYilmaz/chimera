import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { WorktreeLeaseSchema, type ExplainCheck, type WorktreeLease, type WorktreeLeaseView } from "@chimera/protocol";
import { writeFileDurable } from "./durable-write.js";
import { GuardrailError } from "./errors.js";
import { z } from "zod";

// F22. The ownership half of the single-writer invariant. Enforcement lives in broker.ts
// (decideWorktreeWrite); this file only answers "who owns the worktree this path is in, and are
// they still alive".
//
// PERSISTED, because AgentRecords are (replay.ts) and a lease that vanished on daemon restart
// would reopen the exact incident this card closes: a terminal owner's unlanded worktree, no
// longer protected. One JSON file, writeFileDurable (durable-write.ts) — the same crash-safe
// replace every other small store here uses.
//
// NO ttl, NO heartbeat, NO lock file in the worktree: liveness is DERIVED at decision time
// through the injected `isLive` seam, so there is no release hook on any of the five terminal
// paths and adding a sixth cannot break this feature.

export const WORKTREE_LEASE_CHECK = "worktreeWriterLease";   // F15 ExplainCheck.name, stable machine id

const LEASE_FILE = "worktree-leases.json";
const MAX_HANDOFFS = 8;                                      // mirrors WorktreeLeaseSchema's own bound

// Pure and LEXICAL. The lease key for a path, or null when the path is not inside ANY worktree —
// which includes every path in the main checkout itself. This is why "the main checkout is never
// leased" needs no special case: the layout `<cwd>/.chimera/worktrees/<key>` (workdir.ts's
// worktreePath) is the ONLY thing that matches, and main is by construction its parent, not its
// child. `..` spellings are handled by resolve(); SYMLINK normalization is deliberately the
// CALLER's job (hosttools' realishPath already does it for both write-target detectors) so this
// stays pure and cannot touch the filesystem.
export function leaseKeyForPath(absPath: string): { key: string; worktreeDir: string } | null {
  const parts = resolve(absPath).split(sep);
  // LAST match wins: a worktree nested inside another worktree is owned by the inner one.
  for (let i = parts.length - 3; i >= 0; i--) {
    if (parts[i] === ".chimera" && parts[i + 1] === "worktrees" && (parts[i + 2] ?? "") !== "") {
      return { key: parts[i + 2]!, worktreeDir: parts.slice(0, i + 3).join(sep) };
    }
  }
  return null;
}

export type WorktreeLeaseDeps = {
  // The ONE liveness question this file asks. Injected (supervisor.status(id).state is not
  // terminal) rather than imported, same DI convention as every other supervisor seam. A
  // missing/unknown agent is NOT live — a pruned owner leaves a retained lease, never an
  // active one.
  isLive: (agentId: string) => boolean;
  displayLabelFor?: (agentId: string) => string | null;
  now?: () => number;
};

// What the gate needs but an ExplainCheck cannot carry: the check array is F15-shaped
// ({name, ok, skipped, detail}) and the broker's event/return shape needs the structured facts
// too. Rather than have the broker parse `detail` back apart, evaluateWrite returns BOTH — and
// explainWrite is literally `evaluateWrite(...).checks`, so the worktree.explainWrite RPC (the
// dry-run) and the refusal are guaranteed to be the same evaluation, not two that agree by
// convention.
export type WorktreeWriteBlock = {
  workdirKey: string;
  owner: string;
  ownerState: "active" | "retained";
  target: string;
  check: ExplainCheck;
};

// QA of F22: a write decision's caller is a KEY *plus* the resolved directory that key names in
// the caller's own checkout. `.chimera/worktrees/<key>` exists once per main checkout, so the key
// alone cannot answer "is this my worktree?" — only the pair can. null = the caller has no
// worktree at all (isolation:"none"), for which every worktree on disk is someone else's.
export type WorktreeWriteCaller = { key: string; dir: string } | null;

export class WorktreeLeaseStore {
  private file: string;
  private deps: WorktreeLeaseDeps;
  private leases = new Map<string, WorktreeLease>();

  constructor(home: string, deps: WorktreeLeaseDeps) {
    mkdirSync(home, { recursive: true });
    this.file = join(home, LEASE_FILE);
    this.deps = deps;
    this.load();
  }

  // Tolerant read: a missing, torn or schema-drifted file degrades to "no leases" rather than
  // throwing — same convention as queues.json/agent-archive.ts. Failing closed here would mean a
  // corrupt file bricks every spawn, which is strictly worse than briefly losing the guard.
  private load(): void {
    if (!existsSync(this.file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    const parsed = z.array(WorktreeLeaseSchema).safeParse(raw);
    if (!parsed.success) return;
    for (const lease of parsed.data) this.leases.set(lease.workdirKey, lease);
  }

  private save(): void {
    writeFileDurable(this.file, JSON.stringify([...this.leases.values()]));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private stateOf(lease: WorktreeLease): "active" | "retained" {
    return this.deps.isLive(lease.ownerAgentId) ? "active" : "retained";
  }

  // Idempotent. Called from supervisor.launch() (task 2). Rules, in order:
  //   - throws GuardrailError if worktreeDir is not itself a `.chimera/worktrees/<key>` dir for
  //     this key — which is exactly how the main checkout is refused (A9), with no mainRepo
  //     parameter and no special case
  //   - same key + same owner             -> no-op
  //   - same key, owner terminal          -> take over, append a {by:"relaunch"} handoff entry
  //   - same key, owner LIVE and different-> throw GuardrailError naming both agentIds (A1)
  //   - no record                         -> create
  acquire(workdirKey: string, worktreeDir: string, agentId: string): WorktreeLease {
    const dir = resolve(worktreeDir);
    const layout = leaseKeyForPath(dir);
    if (!layout || layout.key !== workdirKey || layout.worktreeDir !== dir) {
      throw new GuardrailError(
        `refusing to lease "${dir}" as worktree "${workdirKey}": only a <cwd>/.chimera/worktrees/<key> directory can be leased`,
      );
    }
    const existing = this.leases.get(workdirKey);
    if (existing) {
      if (existing.ownerAgentId === agentId) return existing;
      if (this.deps.isLive(existing.ownerAgentId)) {
        throw new GuardrailError(
          `worktree "${workdirKey}" is already leased to live agent ${existing.ownerAgentId}; ${agentId} cannot take it over (use worktree_lease_handoff)`,
        );
      }
      const taken: WorktreeLease = {
        ...existing,
        worktreeDir: dir,
        ownerAgentId: agentId,
        acquiredAt: this.now(),
        handoffs: [...existing.handoffs, { from: existing.ownerAgentId, to: agentId, at: this.now(), by: "relaunch" as const }].slice(-MAX_HANDOFFS),
      };
      this.leases.set(workdirKey, taken);
      this.save();
      return taken;
    }
    const created: WorktreeLease = {
      workdirKey, worktreeDir: dir, ownerAgentId: agentId, acquiredAt: this.now(), handoffs: [],
    };
    this.leases.set(workdirKey, created);
    this.save();
    return created;
  }

  // The gate's read. Self-prunes: a record whose worktree directory no longer exists is deleted
  // and null is returned (A10) — `git worktree remove`, the land-on-main step, therefore drops
  // the lease with no hook of its own. null also means "no lease", which the caller MUST read as
  // ALLOW: ownership is never inferred from the directory layout alone.
  ownerOf(workdirKey: string): { lease: WorktreeLease; ownerState: "active" | "retained" } | null {
    const lease = this.leases.get(workdirKey);
    if (!lease) return null;
    if (!existsSync(lease.worktreeDir)) {
      this.leases.delete(workdirKey);
      this.save();
      return null;
    }
    return { lease, ownerState: this.stateOf(lease) };
  }

  // Operator/RPC handoff (task 2's worktree.leaseHandoff). Unlike acquire's relaunch takeover
  // this is allowed while the owner is LIVE — handing a live agent's worktree over is the
  // sanctioned collaboration path, and the operator asking for it IS the approval.
  handoff(workdirKey: string, toAgentId: string): WorktreeLease {
    const lease = this.leases.get(workdirKey);
    if (!lease) throw new GuardrailError(`no worktree lease for "${workdirKey}"`);
    const next: WorktreeLease = {
      ...lease,
      ownerAgentId: toAgentId,
      acquiredAt: this.now(),
      handoffs: [...lease.handoffs, { from: lease.ownerAgentId, to: toAgentId, at: this.now(), by: "rpc" as const }].slice(-MAX_HANDOFFS),
    };
    this.leases.set(workdirKey, next);
    this.save();
    return next;
  }

  // force:true deletes unconditionally. Without it, releasing a LIVE owner's lease THROWS rather
  // than returning false: "there was no lease" and "I refuse to yank a running agent's worktree"
  // are different facts and an operator must not have to guess which one a bare `false` meant.
  release(workdirKey: string, opts: { force?: boolean } = {}): boolean {
    const lease = this.leases.get(workdirKey);
    if (!lease) return false;
    if (!opts.force && this.deps.isLive(lease.ownerAgentId)) {
      throw new GuardrailError(
        `worktree "${workdirKey}" is leased to LIVE agent ${lease.ownerAgentId}; pass force:true to release it anyway`,
      );
    }
    this.leases.delete(workdirKey);
    this.save();
    return true;
  }

  list(): WorktreeLeaseView[] {
    const views: WorktreeLeaseView[] = [];
    for (const key of [...this.leases.keys()]) {
      const owner = this.ownerOf(key);          // prunes as it walks
      if (!owner) continue;
      views.push({
        ...owner.lease,
        ownerState: owner.ownerState,
        ownerDisplayLabel: this.deps.displayLabelFor?.(owner.lease.ownerAgentId) ?? null,
      });
    }
    return views;
  }

  // Reverse lookup for the agent projection (task 2's worktreeLeaseHeld chip). Walks the map
  // rather than keeping a second index: the map holds one entry per LIVE-ish worktree, and a
  // second index would be one more thing to keep in sync with the self-prune.
  heldBy(agentId: string): boolean {
    for (const key of [...this.leases.keys()]) {
      const owner = this.ownerOf(key);
      if (owner?.lease.ownerAgentId === agentId) return true;
    }
    return false;
  }

  // F15-SHAPED. The whole decision as an ExplainCheck array, evaluated WITHOUT acting — the same
  // "one array, two callers" discipline F15 mandates for explainAdmission. The broker consumes
  // evaluateWrite (it needs the structured block for its event); the worktree.explainWrite RPC
  // (engine.ts, exposed as the worktree_explain_write MCP tool) and the denial payload carry
  // these checks verbatim, so one renderer explains a refusal and a dry-run identically.
  explainWrite(caller: WorktreeWriteCaller, targets: string[]): ExplainCheck[] {
    return this.evaluateWrite(caller, targets).checks;
  }

  evaluateWrite(caller: WorktreeWriteCaller, targets: string[]): { checks: ExplainCheck[]; blocked: WorktreeWriteBlock | null } {
    let sawWorktreeTarget = false;
    for (const target of targets) {
      const layout = leaseKeyForPath(target);
      if (!layout) continue;                                  // outside every worktree — not this gate's business
      sawWorktreeTarget = true;
      // The caller's OWN worktree — key AND directory, never the key alone: the dir-proof three
      // lines below already documents that a key collides across two main checkouts, and a
      // key-only shortcut here let a caller in checkout B write straight into checkout A's leased
      // worktree. A11 (two agents sharing a workdirKey INSIDE one checkout) is unaffected: their
      // directories are literally the same path.
      const ownWorktree = caller !== null && layout.key === caller.key
        && resolve(layout.worktreeDir) === resolve(caller.dir);
      if (ownWorktree) continue;
      const owner = this.ownerOf(layout.key);
      if (!owner) continue;                                   // unleased ⇒ allow, never inferred
      // A key alone could collide across two main checkouts; the stored directory is the proof
      // that this path really is THIS lease's. Both sides are resolve()d, never compared raw.
      if (resolve(owner.lease.worktreeDir) !== resolve(layout.worktreeDir)) continue;
      const check: ExplainCheck = {
        name: WORKTREE_LEASE_CHECK, ok: false, skipped: false,
        detail: refusalDetail(layout.key, owner.lease.ownerAgentId, owner.ownerState, caller, layout.key === caller?.key),
      };
      return {
        checks: [check],
        blocked: { workdirKey: layout.key, owner: owner.lease.ownerAgentId, ownerState: owner.ownerState, target, check },
      };
    }
    return {
      checks: [{
        name: WORKTREE_LEASE_CHECK, ok: true, skipped: !sawWorktreeTarget,
        detail: sawWorktreeTarget
          ? "every write target is in your own worktree or an unleased one"
          : "no write target is inside a worktree",
      }],
      blocked: null,
    };
  }
}

// ExplainCheck.detail is capped at 240 chars (F15) and real ids are 36-char uuids with
// `task-<uuid>` keys on top, so the sentence a human WANTS does not always fit. Degrade to a
// compact spelling that still names all four facts rather than slicing the actionable tail off
// the long one; the final slice is a hard guarantee against a future reword, never the normal path.
function refusalDetail(
  key: string, owner: string, ownerState: "active" | "retained",
  caller: WorktreeWriteCaller, sameKeyOtherCheckout: boolean,
): string {
  const state = ownerState === "active" ? "live" : "terminal, worktree still on disk";
  // Same key, different checkout is the confusing case ("you are task-x" reads like a bug when
  // task-x is exactly what got refused) — name the checkout so the reader knows which path lost.
  const you = caller === null
    ? "you have no worktree of your own"
    : sameKeyOtherCheckout ? `you are ${caller.key} in another checkout (${caller.dir})` : `you are ${caller.key}`;
  const long = `worktree "${key}" is leased to agent ${owner} (${state}); ${you} — write in your own worktree or use worktree_lease_handoff`;
  if (long.length <= 240) return long;
  const compact = `worktree "${key}" leased to ${owner} (${ownerState}); ${you} — use worktree_lease_handoff`;
  return compact.slice(0, 240);
}
