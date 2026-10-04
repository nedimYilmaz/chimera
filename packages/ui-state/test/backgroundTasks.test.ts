import { describe, it, expect } from "vitest";
import { reduce, emptyAgent } from "../src/reducer.js";
import { initialState } from "../src/types.js";
import type { NormalizedEvent } from "@chimera/protocol";

// BACKGROUND-TASK-VISIBILITY — a script an agent kicks off and walks away from. core's upsertShadow
// deliberately refuses to turn `taskType: "local_bash"` into a fake sub-agent row (it is not an
// agent), which was right and also left it invisible EVERYWHERE: reported as "the agent says it
// started a background script and nothing on screen shows it".

const AID = "wispy-otter";
let seq = 0;
const ev = (kind: string, data: Record<string, unknown>, ts = 1_000): NormalizedEvent =>
  ({ ts, seq: ++seq, engineId: "local", agentId: AID, kind: kind as NormalizedEvent["kind"], data });

function withAgent() {
  const s = { ...initialState, agents: { ...initialState.agents, [AID]: emptyAgent(AID) } };
  return s;
}
const apply = (state: ReturnType<typeof withAgent>, ...events: NormalizedEvent[]) =>
  events.reduce((acc, e) => reduce(acc, { type: "event", event: e }), state);

const started = (over: Record<string, unknown> = {}) =>
  ev("agent_task", { taskId: "bi1ogjh7o", taskType: "local_bash", isBackgrounded: true,
    description: "mfe-scan.py", status: "running", ...over });

describe("a backgrounded script gets its own live row", () => {
  it("appears as running the moment it starts", () => {
    const s = apply(withAgent(), started());
    expect(s.agents[AID]!.backgroundTasks).toEqual([
      { taskId: "bi1ogjh7o", ts: 1_000, description: "mfe-scan.py", taskType: "local_bash", status: "running" },
    ]);
  });

  it("resolves to done, carrying when it ended", () => {
    const s = apply(withAgent(), started(), ev("agent_task", {
      taskId: "bi1ogjh7o", isBackgrounded: true, status: "completed" }, 5_000));
    expect(s.agents[AID]!.backgroundTasks[0]).toMatchObject({ status: "done", endedAt: 5_000 });
  });

  it("carries a failure and its reason rather than just disappearing", () => {
    const s = apply(withAgent(), started(), ev("agent_task", {
      taskId: "bi1ogjh7o", isBackgrounded: true, status: "failed", error: "exit 2" }, 5_000));
    expect(s.agents[AID]!.backgroundTasks[0]).toMatchObject({ status: "failed", error: "exit 2" });
  });

  it("never blanks the description on a later update that omits it", () => {
    // progress updates carry a patch, not the original description — clobbering it would leave a
    // row labelled with a raw task id.
    const s = apply(withAgent(), started(), ev("agent_task", { taskId: "bi1ogjh7o", isBackgrounded: true, status: "running" }));
    expect(s.agents[AID]!.backgroundTasks[0]!.description).toBe("mfe-scan.py");
  });

  it("IGNORES a foreground local_bash — it is already on screen as the tool call blocking on it", () => {
    const s = apply(withAgent(), started({ isBackgrounded: false }));
    expect(s.agents[AID]!.backgroundTasks).toEqual([]);
  });

  it("ignores a sub-agent task, which core turns into a real shadow row instead", () => {
    const s = apply(withAgent(), ev("agent_task", {
      taskId: "t1", subagentType: "Explore", description: "search", status: "running" }));
    expect(s.agents[AID]!.backgroundTasks).toEqual([]);
  });
});

describe("the live set reconciles what the per-task events miss", () => {
  it("ends a row without inventing success when it drops out of the live set", () => {
    // A backgrounded script is not guaranteed to emit a terminal task_updated. Its disappearance
    // from background_tasks_changed is the completion signal that always arrives.
    const s = apply(withAgent(), started(), ev("background_tasks", { tasks: [] }, 9_000));
    expect(s.agents[AID]!.backgroundTasks[0]).toMatchObject({ status: "ended", endedAt: 9_000 });
  });

  it("keeps a row that is still listed", () => {
    const s = apply(withAgent(), started(), ev("background_tasks", {
      tasks: [{ taskId: "bi1ogjh7o", taskType: "local_bash", description: "mfe-scan.py" }] }, 9_000));
    expect(s.agents[AID]!.backgroundTasks[0]!.status).toBe("running");
  });

  it("adopts a task it never saw START — an invisible running script is the whole bug", () => {
    const s = apply(withAgent(), ev("background_tasks", {
      tasks: [{ taskId: "later", description: "watch.sh" }] }, 3_000));
    expect(s.agents[AID]!.backgroundTasks).toEqual([
      { taskId: "later", ts: 3_000, description: "watch.sh", status: "running" },
    ]);
  });

  it("does not resurrect an already-finished row", () => {
    const s = apply(withAgent(), started(),
      ev("agent_task", { taskId: "bi1ogjh7o", isBackgrounded: true, status: "failed" }, 4_000),
      ev("background_tasks", { tasks: [] }, 9_000));
    expect(s.agents[AID]!.backgroundTasks[0]).toMatchObject({ status: "failed", endedAt: 4_000 });
  });

  it("survives a malformed payload instead of throwing into the reducer", () => {
    const s = apply(withAgent(), ev("background_tasks", { tasks: "nonsense" }));
    expect(s.agents[AID]!.backgroundTasks).toEqual([]);
  });
});


describe("partial and unordered lifecycle updates", () => {
  it.each(["completed", "failed", "stopped"])("accepts %s without a repeated isBackgrounded flag", status => {
    const s = apply(withAgent(), started(), ev("agent_task", { taskId: "bi1ogjh7o", status }));
    expect(s.agents[AID]!.backgroundTasks[0]!.status).toBe(status === "completed" ? "done" : status === "stopped" ? "killed" : "failed");
    expect(s.agents[AID]!.transcript.filter(t => t.role === "task")).toHaveLength(1);
  });
  it("keeps a terminal state when a late progress patch arrives", () => {
    const s = apply(withAgent(), started(), ev("agent_task", { taskId: "bi1ogjh7o", status: "failed" }, 2000), ev("agent_task", { taskId: "bi1ogjh7o", status: "running" }, 3000));
    expect(s.agents[AID]!.backgroundTasks[0]).toMatchObject({ status: "failed", endedAt: 2000 });
  });
  it("lets the exact terminal notification refine an earlier empty snapshot", () => {
    const s = apply(withAgent(), started(), ev("background_tasks", { tasks: [] }, 2000), ev("agent_task", { taskId: "bi1ogjh7o", status: "failed", error: "exit 2" }, 3000));
    expect(s.agents[AID]!.backgroundTasks[0]).toMatchObject({ status: "failed", error: "exit 2" });
  });
  it("ignores malformed snapshots without finishing live work", () => {
    const s = apply(withAgent(), started(), ev("background_tasks", { tasks: null }));
    expect(s.agents[AID]!.backgroundTasks[0]!.status).toBe("running");
  });
  it("does not create inline rows for ambient tasks or background subagents", () => {
    for (const extra of [{ ambient: true }, { skipTranscript: true }, { taskType: "local_agent" }, { subagentType: "Explore" }]) {
      expect(apply(withAgent(), started(extra)).agents[AID]!.backgroundTasks).toEqual([]);
    }
  });
});


it("repairs a historical row from an older daemon's raw completion event", () => {
  const initial = apply(withAgent(), started());
  const event = ev("status", { sdkEvent: "task_notification" });
  event.raw = { type: "system", subtype: "task_notification", task_id: "bi1ogjh7o", status: "completed" };
  const state = apply(initial, event);
  expect(state.agents[AID]!.backgroundTasks[0]!.status).toBe("done");
});
it("does not infer background completion when the parent turn finishes", () => {
  const state = apply(withAgent(), started(), ev("turn_complete", {}, 8000));
  expect(state.agents[AID]!.backgroundTasks[0]!.status).toBe("running");
});

it("does not mutate the previous projection while finishing a task", () => {
  const before = apply(withAgent(), started());
  const after = apply(before, ev("agent_task", { taskId: "bi1ogjh7o", status: "completed" }));
  expect(before.agents[AID]!.backgroundTasks[0]!.status).toBe("running");
  expect(after.agents[AID]!.backgroundTasks[0]!.status).toBe("done");
});
