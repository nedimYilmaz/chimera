// W7 (coverage B1 row 3): the events-tab unseen badge — permission_request /
// agent_question / error counters folded while activeTab !== "events", reset by
// any tab switch that lands on "events". Plus the TabId "projects" extension
// (the union grows; the TUI's TAB_ORDER stays a locked five-tab surface).
import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { TAB_ORDER, initialState, reduce, type UiState } from "@chimera/ui-state";

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}, s?: number): NormalizedEvent =>
  ({ ts: 1000 + (s ?? ++seq), seq: s ?? seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);

describe("W7 unseen badge counters", () => {
  it("folds permission_request + agent_question + error while NOT on the events tab", () => {
    const st = feed(initialState, [
      ev("a1", "permission_request", { requestId: "r1", toolName: "Bash", input: {} }),
      ev("a1", "agent_question", { questionId: "q1", prompt: "pick one" }),
      ev("a2", "error", { message: "boom" }),
      ev("a1", "message_delta", { text: "noise" }),        // uncounted kind
    ]);
    expect(st.unseen).toEqual({ permissions: 1, questions: 1, errors: 1 });
  });

  it("does NOT count events that arrive while the events tab is active", () => {
    const onEvents = reduce(initialState, { type: "selectTab", tab: "events" });
    const st = feed(onEvents, [
      ev("a1", "permission_request", { requestId: "r2", toolName: "Bash", input: {} }),
      ev("a1", "agent_question", { questionId: "q2", prompt: "?" }),
      ev("a1", "error", { message: "x" }),
    ]);
    expect(st.unseen).toEqual({ permissions: 0, questions: 0, errors: 0 });
  });

  it("selectTab('events') resets all counters; other tabs keep them", () => {
    const st = feed(initialState, [
      ev("a1", "error", { message: "one" }),
      ev("a1", "error", { message: "two" }),
    ]);
    expect(st.unseen.errors).toBe(2);
    const onTeams = reduce(st, { type: "selectTab", tab: "teams" });
    expect(onTeams.unseen.errors).toBe(2);                  // non-events switch keeps the badge
    const onEvents = reduce(onTeams, { type: "selectTab", tab: "events" });
    expect(onEvents.unseen).toEqual({ permissions: 0, questions: 0, errors: 0 });
  });

  it("tabNext/tabPrev landing on events resets too (any path onto the tab counts)", () => {
    const st = feed(initialState, [ev("a1", "agent_question", { questionId: "q", prompt: "p" })]);
    expect(st.unseen.questions).toBe(1);
    // queues --tabNext--> events (TAB_ORDER: agents, teams, queues, events, memory)
    const onQueues = reduce(st, { type: "selectTab", tab: "queues" });
    const next = reduce(onQueues, { type: "tabNext" });
    expect(next.activeTab).toBe("events");
    expect(next.unseen).toEqual({ permissions: 0, questions: 0, errors: 0 });
  });

  it("a duplicate permission_request (same requestId, new seq) does not double-count", () => {
    const st = feed(initialState, [
      ev("a1", "permission_request", { requestId: "dup", toolName: "Bash", input: {} }),
      ev("a1", "permission_request", { requestId: "dup", toolName: "Bash", input: {} }),
    ]);
    expect(st.pendingPermissions).toHaveLength(1);
    expect(st.unseen.permissions).toBe(1);
  });

  it("counts ':'-namespaced coordination errors (a queue task's failure is unseen too)", () => {
    const st = feed(initialState, [ev("task:t-1", "error", { message: "task failed" })]);
    expect(st.unseen.errors).toBe(1);
    expect(st.agentOrder).toEqual([]);                       // still never an agent row
  });

  it("a replayed (seq <= lastSeq) event bumps nothing", () => {
    const st = feed(initialState, [ev("a1", "error", { message: "e" }, 50)]);
    const replay = reduce(st, { type: "event", event: ev("a1", "error", { message: "e" }, 50) });
    expect(replay.unseen.errors).toBe(1);
  });
});

describe("W7 TabId 'projects'", () => {
  it("selectTab accepts 'projects'; TAB_ORDER (the TUI surface) stays five tabs without it", () => {
    const st = reduce(initialState, { type: "selectTab", tab: "projects" });
    expect(st.activeTab).toBe("projects");
    expect(TAB_ORDER).toEqual(["agents", "teams", "queues", "events", "memory"]);
  });

  it("tabNext from 'projects' falls back into TAB_ORDER (documented: the app owns the six-slot cycle)", () => {
    const onProjects = reduce(initialState, { type: "selectTab", tab: "projects" });
    const next = reduce(onProjects, { type: "tabNext" });
    expect(next.activeTab).toBe("agents");                   // indexOf -1 + 1 → slot 0
  });
});
