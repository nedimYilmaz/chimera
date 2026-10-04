import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { QueueStore } from "@chimera/core/queues";

// BUG (FEATURE-1 WorkflowGraph): prune() evicted a terminal task even while a live
// blocked/pending task still depended on it. An uneven fan-out (one branch done fast,
// the other slow) could see enough OTHER tasks finish in between — pushing the queue
// past the terminal-task cap — that the already-done branch got pruned before the
// join reconciled. When the slow branch finally finished, reconcileDependents looked
// up the pruned branch's state, got `undefined`, and depsSatisfied() treated a MISSING
// dependency as unsatisfied — so the join parent stayed "blocked" forever.
// Cap is injected small (production default is 200) so the eviction-triggering filler
// loop below can stay short — the eviction mechanism is cap-independent, so this proves
// the exact same property as the real cap without the O(n) prune()-per-save cost of
// pushing 210+ tasks (that cost is what made this test flaky under concurrent-agent load).
const TEST_MAX_TERMINAL_PER_QUEUE = 5;

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-qprune-"));
  const events = new EventLog(dir);
  return { dir, events, q: new QueueStore(dir, events, { maxTerminalPerQueue: TEST_MAX_TERMINAL_PER_QUEUE }) };
}

describe("QueueStore — prune() must not evict a dep still referenced by a live task", () => {
  it("an uneven fan-out join still unblocks after the fast branch is pruned-eligible", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 0 });

    const fast = q.push("work", { prompt: "fast branch" });
    const slow = q.push("work", { prompt: "slow branch" });
    const parent = q.push("work", { prompt: "join parent" });

    // Mirrors scheduler.ts's beginFanOut: the join parent blocks on both branch children.
    q.blockOnChildren(parent.taskId, [fast.taskId, slow.taskId], 0);
    expect(q.status("work").tasks.find((t) => t.taskId === parent.taskId)!.state).toBe("blocked");

    q.markInProgress(fast.taskId, "ag-fast");
    q.markDone(fast.taskId, "ok");   // fast branch done; parent still blocked on slow

    // Push and complete enough OTHER terminal tasks to push `fast` past the injected
    // prune cap (TEST_MAX_TERMINAL_PER_QUEUE) while `slow` is still running.
    for (let i = 0; i < TEST_MAX_TERMINAL_PER_QUEUE + 10; i++) {
      const filler = q.push("work", { prompt: `filler-${i}` });
      q.markInProgress(filler.taskId, "ag-filler");
      q.markDone(filler.taskId, "ok");
    }

    // `fast` must still be resolvable — it's referenced by the still-blocked parent.
    expect(q.status("work").tasks.find((t) => t.taskId === fast.taskId)).toBeDefined();

    q.markInProgress(slow.taskId, "ag-slow");
    q.markDone(slow.taskId, "ok");

    // The join must unblock now that BOTH branches are done, not stay blocked forever
    // because `fast` was pruned out from under it.
    expect(q.status("work").tasks.find((t) => t.taskId === parent.taskId)!.state).toBe("pending");
  });
});
