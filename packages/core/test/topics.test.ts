import { describe, it, expect } from "vitest";
import { TopicFilterSchema, UNSATISFIABLE_FILTER_KEYS, type EventKind, type NormalizedEvent, type Topic, type TopicFilter } from "@chimera/protocol";
import { KIND_TO_TOPICS, TOPIC_TABLE, matchesTopicFilter, narrowContentPayload, scanWindow, type TopicAgentLookup } from "@chimera/core/topics";

// topics.ts is a pure module (§2.2 table + projectors + filter predicate). Projectors only read
// e.kind/e.agentId/e.data, so a minimal cast NormalizedEvent is faithful for the fields under test.
function ev(kind: EventKind, data: Record<string, unknown>, agentId = "a1"): NormalizedEvent {
  return { seq: 1, ts: 0, agentId, kind, data } as unknown as NormalizedEvent;
}

const noAgent: TopicAgentLookup = () => undefined;
const ctx = (getAgent: TopicAgentLookup = noAgent) => ({ getAgent });

describe("TOPIC_TABLE projectors (HOOK-2, PLAN-HOOKS.md §2.2)", () => {
  describe("agent.settled", () => {
    const p = TOPIC_TABLE["agent.settled"].toPayload;
    it("projects a 'result' event into a done payload with a truncated preview and costUsd", () => {
      expect(p(ev("result", { text: "all finished", costUsd: 0.42 }, "child-1"), ctx())).toEqual({
        agentId: "child-1", state: "done", resultPreview: "all finished", costUsd: 0.42,
      });
    });
    it("defaults costUsd to 0 and preview to '' when the result carries neither", () => {
      expect(p(ev("result", {}, "child-1"), ctx())).toEqual({
        agentId: "child-1", state: "done", resultPreview: "", costUsd: 0,
      });
    });
    it("truncates an oversized result preview to 2000 chars with an ellipsis", () => {
      const out = p(ev("result", { text: "x".repeat(5000) }, "child-1"), ctx()) as { resultPreview: string };
      expect(out.resultPreview).toHaveLength(2000);
      expect(out.resultPreview.endsWith("…")).toBe(true);
    });
    it("projects a 'status' failed/killed transition into a terminal-state payload", () => {
      expect(p(ev("status", { state: "failed" }, "child-1"), ctx())).toEqual({ agentId: "child-1", state: "failed" });
      expect(p(ev("status", { state: "killed" }, "child-1"), ctx())).toEqual({ agentId: "child-1", state: "killed" });
    });
    it("returns null for a non-terminal 'status' (a settle-shaped kind that isn't a settle)", () => {
      expect(p(ev("status", { state: "running" }), ctx())).toBeNull();
    });
  });

  describe("agent.spawned", () => {
    const p = TOPIC_TABLE["agent.spawned"].toPayload;
    it("fires for a fresh spawn (no resume) when the agent record is present", () => {
      const getAgent: TopicAgentLookup = () => ({ state: "running", spec: {} });
      expect(p(ev("agent_started", {}, "fresh-1"), ctx(getAgent))).toEqual({ agentId: "fresh-1" });
    });
    it("returns null for a resume (never re-fires spawned on a resumed agent)", () => {
      const getAgent: TopicAgentLookup = () => ({ state: "running", spec: { resume: "sess-x" } });
      expect(p(ev("agent_started", {}, "resumed-1"), ctx(getAgent))).toBeNull();
    });
    it("returns null when the agent record is unknown (nothing to attribute the spawn to)", () => {
      expect(p(ev("agent_started", {}, "ghost"), ctx())).toBeNull();
    });
  });

  it("task.state projects queue/taskId/state/tags and nulls a missing resultPreview", () => {
    const p = TOPIC_TABLE["task.state"].toPayload;
    // TASK-TAGS: an event with no `tags` (every one persisted before the field existed) projects
    // as [] — never undefined, so a tag filter over replayed history behaves exactly as it did.
    expect(p(ev("task_state_changed", { queue: "q1", taskId: "t9", state: "in_progress" }), ctx())).toEqual({
      queue: "q1", taskId: "t9", state: "in_progress", tags: [], resultPreview: null,
    });
    expect(p(ev("task_state_changed", { queue: "q1", taskId: "t9", state: "done", resultPreview: "ok", tags: ["gate:coverage"] }), ctx())).toMatchObject({
      resultPreview: "ok", tags: ["gate:coverage"],
    });
  });

  describe("gate.verdict", () => {
    const p = TOPIC_TABLE["gate.verdict"].toPayload;
    it("maps task_step_advanced to outcome 'passed'", () => {
      expect(p(ev("task_step_advanced", { taskId: "t1", stepId: "s1" }), ctx())).toEqual({
        taskId: "t1", stepId: "s1", tags: [], outcome: "passed", reason: null,
      });
    });
    it("maps task_step_failed to outcome 'failed' and carries the reason", () => {
      expect(p(ev("task_step_failed", { taskId: "t1", stepId: "s2", reason: "critic rejected" }), ctx())).toEqual({
        taskId: "t1", stepId: "s2", tags: [], outcome: "failed", reason: "critic rejected",
      });
    });
    // TASK-TAGS: the `gate:*` routing case — a verdict carries the OWNING TASK's tags, so
    // "when the coverage-gated work passes, do X" is expressible as a filter.
    it("carries the owning task's tags so a gate verdict can be filtered by them", () => {
      expect(p(ev("task_step_advanced", { taskId: "t1", stepId: "s1", tags: ["gate:coverage"] }), ctx()))
        .toMatchObject({ tags: ["gate:coverage"], outcome: "passed" });
    });
  });

  it("queue.drained projects just the queue name", () => {
    expect(TOPIC_TABLE["queue.drained"].toPayload(ev("queue_drained", { queue: "backlog" }), ctx())).toEqual({ queue: "backlog" });
  });

  it("repo.landed projects repo/branch/from/to", () => {
    expect(TOPIC_TABLE["repo.landed"].toPayload(
      ev("repo_head_moved", { repo: "chimera", branch: "main", from: "aaa", to: "bbb" }), ctx(),
    )).toEqual({ repo: "chimera", branch: "main", from: "aaa", to: "bbb" });
  });

  it("memory.added projects id/kind/tags/author", () => {
    expect(TOPIC_TABLE["memory.added"].toPayload(
      ev("memory_added", { id: "m1", kind: "note", tags: ["x", "y"], author: "a1" }), ctx(),
    )).toEqual({ id: "m1", kind: "note", tags: ["x", "y"], author: "a1" });
  });

  it("permission.pending projects agentId/toolName", () => {
    expect(TOPIC_TABLE["permission.pending"].toPayload(ev("permission_request", { toolName: "Bash" }, "a7"), ctx())).toEqual({
      agentId: "a7", toolName: "Bash",
    });
  });

  describe("question.pending", () => {
    const p = TOPIC_TABLE["question.pending"].toPayload;
    it("truncates a string prompt preview to 200 chars", () => {
      const out = p(ev("agent_question", { prompt: "q".repeat(500) }, "a3"), ctx()) as { preview: string };
      expect(out.preview).toHaveLength(200);
      expect(out.preview.endsWith("…")).toBe(true);
    });
    it("nulls the preview when the prompt is not a string", () => {
      expect(p(ev("agent_question", { prompt: 42 }, "a3"), ctx())).toEqual({ agentId: "a3", preview: null });
    });
  });

  it("budget.warning projects agentId/pct", () => {
    expect(TOPIC_TABLE["budget.warning"].toPayload(ev("budget_warning", { pct: 80 }, "a9"), ctx())).toEqual({
      agentId: "a9", pct: 80,
    });
  });

  describe("system.woke", () => {
    const p = TOPIC_TABLE["system.woke"].toPayload;
    it("projects a forward clock_jump into sleptMs/observedGapMs", () => {
      expect(p(ev("clock_jump", {
        driftMs: 33_180_000, observedGapMs: 33_240_000, expectedGapMs: 60_000,
        thresholdMs: 120_000, direction: "forward", source: "jobs",
      }, "clock"), ctx())).toEqual({ sleptMs: 33_180_000, observedGapMs: 33_240_000 });
    });
    it("returns null for a backward jump", () => {
      expect(p(ev("clock_jump", {
        driftMs: -300_000, observedGapMs: -180_000, expectedGapMs: 120_000,
        thresholdMs: 120_000, direction: "backward", source: "jobs",
      }, "clock"), ctx())).toBeNull();
    });
  });
});

describe("agent.promptStalled (F09/J3)", () => {
  const p = TOPIC_TABLE["agent.promptStalled"].toPayload;
  it("projects the four fields a subscriber can act on, and nothing else", () => {
    const payload = p(ev("agent_prompt_stalled", {
      deliveryId: "msg-1", from: "conductor", sinceTs: 1_000, sinceMs: 45_000,
      lastSeq: 42, messageCount: 2, thresholdMs: 45_000,
    }, "worker-3"), ctx());
    expect(payload).toEqual({ agentId: "worker-3", deliveryId: "msg-1", from: "conductor", sinceMs: 45_000 });
  });
});

describe("KIND_TO_TOPICS reverse index", () => {
  it("maps each shared kind back to exactly the topics it can feed", () => {
    expect(KIND_TO_TOPICS.get("queue_drained")).toEqual(["queue.drained"]);
    expect(KIND_TO_TOPICS.get("memory_added")).toEqual(["memory.added"]);
    // agent.settled listens on BOTH result and status
    expect(KIND_TO_TOPICS.get("result")).toContain("agent.settled");
    expect(KIND_TO_TOPICS.get("status")).toContain("agent.settled");
  });
  it("returns undefined for a kind no topic subscribes to", () => {
    expect(KIND_TO_TOPICS.get("message_delta")).toBeUndefined();
  });
  it("maps clock_jump to system.woke", () => {
    expect(KIND_TO_TOPICS.get("clock_jump")).toEqual(["system.woke"]);
    expect(KIND_TO_TOPICS.get("agent_prompt_stalled")).toEqual(["agent.promptStalled"]);
  });
  it("covers every kind declared across the table (no orphan mapping)", () => {
    for (const mapping of Object.values(TOPIC_TABLE)) {
      for (const kind of mapping.kinds) expect(KIND_TO_TOPICS.has(kind)).toBe(true);
    }
  });
});

describe("matchesTopicFilter (§2.1 shallow-match semantics)", () => {
  it("returns true when no filter is supplied", () => {
    expect(matchesTopicFilter({ agentId: "a1" }, undefined)).toBe(true);
  });
  it("returns true for an empty filter object", () => {
    expect(matchesTopicFilter({ agentId: "a1" }, {})).toBe(true);
  });
  it("scalar filter value must equal the payload field exactly", () => {
    expect(matchesTopicFilter({ agentId: "a1" }, { agentId: "a1" })).toBe(true);
    expect(matchesTopicFilter({ agentId: "a2" }, { agentId: "a1" })).toBe(false);
  });
  it("array filter value matches includes-any", () => {
    expect(matchesTopicFilter({ queue: "q2" }, { queue: ["q1", "q2"] })).toBe(true);
    expect(matchesTopicFilter({ queue: "q9" }, { queue: ["q1", "q2"] })).toBe(false);
  });
  it("skips filter keys whose value is undefined", () => {
    expect(matchesTopicFilter({ agentId: "a1" }, { agentId: "a1", queue: undefined })).toBe(true);
  });
  it("all present filter keys must match (AND across keys)", () => {
    expect(matchesTopicFilter({ agentId: "a1", state: "done" }, { agentId: "a1", state: "done" })).toBe(true);
    expect(matchesTopicFilter({ agentId: "a1", state: "failed" }, { agentId: "a1", state: "done" })).toBe(false);
  });

  describe("tags (doubly-array includes-any)", () => {
    it("matches when ANY filter tag is present in the payload's tags", () => {
      expect(matchesTopicFilter({ tags: ["urgent", "backend"] }, { tags: ["backend"] })).toBe(true);
    });
    it("does not match when NO filter tag is present in the payload's tags", () => {
      expect(matchesTopicFilter({ tags: ["urgent"] }, { tags: ["backend", "frontend"] })).toBe(false);
    });
    it("does not match when the payload has no tags array at all", () => {
      expect(matchesTopicFilter({ agentId: "a1" }, { tags: ["backend"] })).toBe(false);
    });
    it("treats a non-array payload tags field as empty (no match)", () => {
      expect(matchesTopicFilter({ tags: "backend" }, { tags: ["backend"] })).toBe(false);
    });
  });
});

describe("agent.output (F46 — the one content topic)", () => {
  const project = (e: ReturnType<typeof ev>) => TOPIC_TABLE["agent.output"].toPayload(e, ctx());

  it("projects a message_complete into {agentId, source:'assistant', text, textLower}", () => {
    expect(project(ev("message_complete", { text: "Build FAILED on main" }))).toEqual({
      agentId: "a1", source: "assistant", text: "Build FAILED on main", textLower: "build failed on main",
    });
  });

  it("projects a claude tool_result off data.result and a codex one off data.output, both source:'tool'", () => {
    expect(project(ev("tool_result", { result: "exit 1" }))).toMatchObject({ source: "tool", text: "exit 1" });
    expect(project(ev("tool_result", { output: "exit 2" }))).toMatchObject({ source: "tool", text: "exit 2" });
  });

  it("carries toolName when the event has one and omits the key entirely when it does not", () => {
    expect(project(ev("tool_result", { toolName: "command_execution", output: "ok" }))!["toolName"]).toBe("command_execution");
    expect("toolName" in project(ev("tool_result", { result: "ok" }))!).toBe(false);
  });

  it("returns null when there is no string text to match", () => {
    expect(project(ev("message_complete", { text: "" }))).toBeNull();
    expect(project(ev("message_complete", {}))).toBeNull();
    expect(project(ev("tool_result", { result: 42 }))).toBeNull();
  });

  it("scanWindow passes small text through and elides the middle of a big one with a NUL joiner", () => {
    expect(scanWindow("short")).toBe("short");
    const big = "H".repeat(2048) + "M".repeat(100_000) + "T".repeat(2048);
    const win = scanWindow(big);
    expect(win).toHaveLength(4097);
    expect(win.startsWith("H".repeat(2048))).toBe(true);
    expect(win.endsWith("T".repeat(2048))).toBe(true);
    expect(win.includes("M")).toBe(false);
    expect(win[2048]).toBe("\u0000");
  });

  it("does NOT list message_delta among its kinds (a streamed chunk splits a needle)", () => {
    expect(TOPIC_TABLE["agent.output"].kinds).not.toContain("message_delta");
    expect(TOPIC_TABLE["agent.output"].kinds).toEqual(["message_complete", "tool_result"]);
    expect(KIND_TO_TOPICS.get("message_delta") ?? []).not.toContain("agent.output");
  });

  it("contains matches case-insensitively against textLower, literally, and never without a haystack", () => {
    const payload = project(ev("message_complete", { text: "Build FAILED (a|b)+ here" }))!;
    expect(matchesTopicFilter(payload, { contains: "failed" })).toBe(true);
    expect(matchesTopicFilter(payload, { contains: "FaIlEd" })).toBe(true);
    expect(matchesTopicFilter(payload, { contains: "passed" })).toBe(false);
    expect(matchesTopicFilter(payload, { contains: "(a|b)+" })).toBe(true);   // literal, not a pattern
    // A needle whose REGEX reading would match but whose literal reading does not: the only
    // assertion that actually proves no pattern engine is involved ("a|b" is a literal substring
    // of "(a|b)+", so it proves nothing).
    expect(matchesTopicFilter(payload, { contains: "Build|nope" })).toBe(false);
    expect(matchesTopicFilter(payload, { contains: "B.ild" })).toBe(false);
    expect(matchesTopicFilter({ agentId: "a1" }, { contains: "anything" })).toBe(false);
  });

  it("narrowContentPayload returns only the matched line, redacted, capped at 200 chars, textLower gone", () => {
    const text = ["line one", "boom sk-abcdefgh12345678 tail", "line three"].join("\n");
    const out = narrowContentPayload(project(ev("message_complete", { text }))!, "boom");
    expect(out["text"]).toBe("boom [REDACTED] tail");
    expect(out["match"]).toBe("boom");
    expect(out["textLower"]).toBeUndefined();
    expect(out["agentId"]).toBe("a1");

    const long = narrowContentPayload(project(ev("message_complete", { text: "boom " + "x".repeat(500) }))!, "boom");
    expect(String(long["text"])).toHaveLength(200);
    expect(String(long["text"]).endsWith("\u2026")).toBe(true);
  });

  it("narrowContentPayload finds a regex-shaped needle as a literal, never as a pattern", () => {
    const text = ["nothing here", "value = .*", "trailing"].join("\n");
    expect(narrowContentPayload(project(ev("message_complete", { text }))!, ".*")["text"]).toBe("value = .*");
  });

  // F46.QA: scanWindow's own doc comment claims "the NUL joiner can never appear in a legal
  // needle, so head/tail can never splice into a phantom match" — but nothing in core enforces
  // that; the guarantee lives entirely in TopicFilterSchema.contains. This test pins the two
  // halves together: the phantom match is REAL if a NUL needle ever gets through, and the
  // schema is what stops it. Delete the schema refinement and this goes red, which is the
  // whole point — a comment asserting an invariant that another package enforces needs a test
  // spanning both, or the invariant silently evaporates.
  it("a NUL needle would phantom-match across the elision joiner, and the schema is what forbids it", () => {
    const NUL = String.fromCharCode(0);
    const raw = "A".repeat(2048) + "MIDDLE".repeat(10_000) + "B".repeat(2048);
    const needle = `A${NUL}B`;

    // The splice really does happen at the projection layer...
    expect(raw.includes(needle)).toBe(false);
    expect(scanWindow(raw).includes(needle)).toBe(true);
    expect(matchesTopicFilter(project(ev("message_complete", { text: raw }))!, { contains: needle })).toBe(true);

    // ...so the ONLY thing keeping the invariant true is that such a needle cannot be created.
    expect(TopicFilterSchema.safeParse({ contains: needle }).success).toBe(false);
    expect(TopicFilterSchema.safeParse({ contains: "\nERROR" }).success).toBe(false);
  });
  // F46.QA regression (pre-fix: delivered "innocent unrelated line" while stamping
  // match:"build failed"). The old code took indexOf on hay.toLowerCase() and sliced hay with
  // it; "İ".toLowerCase() is two code points, so 40 of them drift the index by 40 — far enough
  // to cross a newline and hand the subscriber a line the needle never appeared on.
  it("delivers the line the needle is really on even when lowercasing changes length", () => {
    const text = "İ".repeat(40) + "\nBUILD FAILED here\ninnocent unrelated line\ntail";
    const out = narrowContentPayload(project(ev("message_complete", { text }))!, "build failed");
    expect(out["text"]).toBe("BUILD FAILED here");
  });

  // F46.QA regression: a match on the head's last partial line used to be delivered spliced onto
  // the tail's first partial line — two regions megabytes apart, joined by a raw NUL, presented
  // to the subscriber as one line the agent never emitted.
  it("never delivers a line spliced across the scan-window elision joiner", () => {
    const head = "x\n".repeat(1000) + "BUILD FAILED at the very end of the head";
    const raw = head + "M".repeat(50_000) + "trailing fragment of the tail\n" + "y\n".repeat(1000);
    const out = narrowContentPayload(project(ev("message_complete", { text: raw }))!, "build failed");
    expect(String(out["text"])).not.toContain("trailing fragment");
    expect(String(out["text"])).not.toContain("\u0000");
    expect(String(out["text"]).startsWith("BUILD FAILED at the very end of the head")).toBe(true);
  });
});

// F46/QA finding C guard: protocol declares UNSATISFIABLE_FILTER_KEYS (currently treeId/team) as
// a static list — since protocol cannot import TOPIC_TABLE (core sits above it), that list can
// only be checked for staleness from THIS side. This is the test the comment on
// UNSATISFIABLE_FILTER_KEYS (packages/protocol/src/index.ts) promises exists: every OTHER
// TopicFilterSchema key must be emitted by at least one projector (else a new schema key would
// silently join treeId/team as an unreachable filter with no error at create time), and the
// exempted keys must stay genuinely unemitted (else the exemption itself has gone stale and
// scopeFilterIssue is now rejecting a filter that would actually work).
describe("TopicFilterSchema key coverage (F46/QA finding C guard)", () => {
  const runningAgent: TopicAgentLookup = () => ({ state: "running", spec: {} });
  const c = ctx(runningAgent);

  // One representative event per topic, permissive enough to make every projector return a
  // non-null payload with every field it can ever emit populated.
  const sampleEventsByTopic: Record<Topic, NormalizedEvent[]> = {
    "agent.settled": [ev("result", { text: "t", costUsd: 1 }), ev("status", { state: "failed" })],
    "agent.spawned": [ev("agent_started", {})],
    "task.state": [ev("task_state_changed", { queue: "q", taskId: "t", state: "s", tags: ["x"], resultPreview: "p" })],
    "gate.verdict": [ev("task_step_advanced", { taskId: "t", stepId: "s", tags: ["x"] })],
    "queue.drained": [ev("queue_drained", { queue: "q" })],
    "repo.landed": [ev("repo_head_moved", { repo: "r", branch: "b", from: "f", to: "t" })],
    "memory.added": [ev("memory_added", { id: "i", kind: "k", tags: ["x"], author: "a" })],
    "permission.pending": [ev("permission_request", { toolName: "t" })],
    "question.pending": [ev("agent_question", { prompt: "p" })],
    "budget.warning": [ev("budget_warning", { pct: 80 })],
    "system.woke": [ev("clock_jump", { direction: "forward", driftMs: 1, observedGapMs: 1 })],
    "agent.promptStalled": [ev("agent_prompt_stalled", { deliveryId: "d", from: "f", sinceMs: 1 })],
    "agent.output": [ev("message_complete", { text: "hello" })],
    "job.dead_letter": [ev("job_dead_letter", { job: "j", attempts: 1, maxAttempts: 2, reasons: [{ error: "e" }] })],
    "memory.pressure": [ev("memory_pressure", { total: 1, limit: 2, fill: 0.5, threshold: 0.9, nextToEvict: null })],
    "memory.evicted": [ev("memory_evicted", { id: "i", title: "t", kind: "note", scope: "s", pinned: false, archived: true })],
  };

  function emittedKeys(): Set<string> {
    const emitted = new Set<string>();
    for (const [topic, events] of Object.entries(sampleEventsByTopic) as [Topic, NormalizedEvent[]][]) {
      const mapping = TOPIC_TABLE[topic];
      for (const e of events) {
        const payload = mapping.toPayload(e, c);
        if (payload) for (const k of Object.keys(payload)) emitted.add(k);
      }
    }
    return emitted;
  }

  it("every satisfiable TopicFilterSchema key is emitted by some projector", () => {
    const emitted = emittedKeys();
    // "contains" is matched against the projector's `textLower` field, not a literal "contains"
    // payload key (see matchesTopicFilter) — it is satisfiable but deliberately never emitted.
    const declaredKeys = (Object.keys(TopicFilterSchema.shape) as (keyof TopicFilter)[])
      .filter((k) => k !== "contains" && !UNSATISFIABLE_FILTER_KEYS.includes(k));
    for (const key of declaredKeys) {
      expect(emitted.has(key), `expected some TOPIC_TABLE projector to emit "${key}"`).toBe(true);
    }
  });

  it("UNSATISFIABLE_FILTER_KEYS are still emitted by no projector", () => {
    const emitted = emittedKeys();
    for (const key of UNSATISFIABLE_FILTER_KEYS) {
      expect(
        emitted.has(key),
        `"${key}" is now emitted by a projector — drop it from UNSATISFIABLE_FILTER_KEYS/scopeFilterIssue`,
      ).toBe(false);
    }
  });
});
