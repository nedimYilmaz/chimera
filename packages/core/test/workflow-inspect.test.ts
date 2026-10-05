import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseJournal,
  parseTranscript,
  parseMeta,
  parseWorkflowTranscriptRef,
  firstPromptLabel,
  inspectWorkflowDir,
  expandHome,
} from "@chimera/core/rpc/workflow-inspect";

// SHADOW-WORKFLOW-VISIBILITY: the on-disk workflow-dir parser. The journal/transcript formats
// here are the exact shapes verified across the real ~/.claude/.../subagents/workflows/wf_* dirs
// (journal: {type:"started"|"result", key, agentId, result?}; transcript: SDK user/assistant
// records with message.content + ISO timestamp; meta: {agentType, spawnDepth?, model?}).

describe("parseWorkflowTranscriptRef", () => {
  it("pulls Transcript dir + Run ID out of a Workflow tool_result, expanding ~", () => {
    const home = expandHome("~");
    const text = [
      "Workflow complete. 4 agents ran.",
      "Transcript dir: ~/.claude/projects/abc/sess/subagents/workflows/wf_1234",
      "Run ID: wf_1234-deadbeef",
    ].join("\n");
    const ref = parseWorkflowTranscriptRef(text);
    expect(ref.dir).toBe(join(home, ".claude/projects/abc/sess/subagents/workflows/wf_1234"));
    expect(ref.runId).toBe("wf_1234-deadbeef");
  });

  it("returns nothing when the markers are absent (ordinary tool_result)", () => {
    expect(parseWorkflowTranscriptRef("just some Read output, no markers")).toEqual({});
  });

  it("tolerates reversed ordering and an absolute dir", () => {
    const ref = parseWorkflowTranscriptRef("Run ID: wf_x\nTranscript dir: /var/run/wf_x");
    expect(ref).toEqual({ dir: "/var/run/wf_x", runId: "wf_x" });
  });

  it("captures a transcript dir path containing spaces (home dir with a space)", () => {
    const ref = parseWorkflowTranscriptRef("Transcript dir: /Users/John Doe/.claude/wf_1\nRun ID: wf_1");
    expect(ref).toEqual({ dir: "/Users/John Doe/.claude/wf_1", runId: "wf_1" });
  });
});

describe("parseJournal", () => {
  it("folds started/result records into per-agent state with a result preview", () => {
    const text = [
      JSON.stringify({ type: "started", key: "v2:a", agentId: "a1" }),
      JSON.stringify({ type: "started", key: "v2:b", agentId: "a2" }),
      JSON.stringify({ type: "result", key: "v2:a", agentId: "a1", result: { findings: ["x", "y"] } }),
    ].join("\n");
    const m = parseJournal(text);
    expect(m.get("a1")).toEqual({ state: "done", resultPreview: '{"findings":["x","y"]}' });
    expect(m.get("a2")).toEqual({ state: "running", resultPreview: null });
  });

  it("skips a truncated/partial trailing line without throwing (workflow still writing)", () => {
    const text =
      JSON.stringify({ type: "started", key: "v2:a", agentId: "a1" }) +
      "\n" +
      JSON.stringify({ type: "result", key: "v2:a", agentId: "a1", result: "done" }) +
      '\n{"type":"started","key":"v2:b","agentId":"a2"';  // <- truncated, no closing brace
    const m = parseJournal(text);
    expect(m.get("a1")).toEqual({ state: "done", resultPreview: "done" });
    expect(m.has("a2")).toBe(false);   // partial line dropped, not fatal
  });

  it("ignores blank lines and records with no agentId", () => {
    const text = ['{"type":"meta"}', "", "   ", JSON.stringify({ type: "started", agentId: "a1" })].join("\n");
    const m = parseJournal(text);
    expect([...m.keys()]).toEqual(["a1"]);
  });
});

describe("parseTranscript / firstPromptLabel", () => {
  const transcript = [
    JSON.stringify({ type: "user", timestamp: "2026-07-01T15:00:00.000Z", message: { role: "user", content: "Investigate the health probe" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-01T15:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "Looking now" }, { type: "tool_use", name: "Read", id: "t1" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-07-01T15:00:06.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body here" }] } }),
    "not json — skip me",
  ].join("\n");

  it("flattens text / tool_use / tool_result blocks into display lines", () => {
    const lines = parseTranscript(transcript);
    expect(lines).toEqual([
      { role: "user", text: "Investigate the health probe", ts: Date.parse("2026-07-01T15:00:00.000Z") },
      { role: "assistant", text: "Looking now", ts: Date.parse("2026-07-01T15:00:05.000Z") },
      { role: "tool", text: "⚙ Read", ts: Date.parse("2026-07-01T15:00:05.000Z") },
      { role: "tool", text: "↳ file body here", ts: Date.parse("2026-07-01T15:00:06.000Z") },
    ]);
  });

  it("derives the label from the first user prompt line, truncated", () => {
    expect(firstPromptLabel(parseTranscript(transcript))).toBe("Investigate the health probe");
    const long = firstPromptLabel([{ role: "user", text: "x".repeat(300), ts: null }], 10);
    expect(long).toBe(`${"x".repeat(10)}…`);
  });

  it("returns null when there is no user line", () => {
    expect(firstPromptLabel([{ role: "assistant", text: "hi", ts: null }])).toBeNull();
  });
});

describe("parseMeta", () => {
  it("reads agentType/spawnDepth/model defensively", () => {
    expect(parseMeta('{"agentType":"general-purpose","spawnDepth":1,"model":"claude"}')).toEqual({
      agentType: "general-purpose", spawnDepth: 1, model: "claude",
    });
    expect(parseMeta('{"agentType":"x"}')).toEqual({ agentType: "x", spawnDepth: null, model: null });
    expect(parseMeta("garbage")).toEqual({ agentType: null, spawnDepth: null, model: null });
  });
});

describe("inspectWorkflowDir", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wf-inspect-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seed() {
    // a1: started + result (done). a2: started only (running).
    await writeFile(join(dir, "journal.jsonl"), [
      JSON.stringify({ type: "started", key: "v2:a", agentId: "a1" }),
      JSON.stringify({ type: "started", key: "v2:b", agentId: "a2" }),
      JSON.stringify({ type: "result", key: "v2:a", agentId: "a1", result: "a1 is done" }),
    ].join("\n"));
    await writeFile(join(dir, "agent-a1.meta.json"), JSON.stringify({ agentType: "reviewer", spawnDepth: 1 }));
    await writeFile(join(dir, "agent-a1.jsonl"),
      JSON.stringify({ type: "user", timestamp: "2026-07-01T15:00:00.000Z", message: { role: "user", content: "Review the diff" } }) + "\n" +
      JSON.stringify({ type: "assistant", timestamp: "2026-07-01T15:00:09.000Z", message: { role: "assistant", content: [{ type: "text", text: "done reviewing" }] } }));
    await writeFile(join(dir, "agent-a2.meta.json"), JSON.stringify({ agentType: "finder", model: "claude" }));
    await writeFile(join(dir, "agent-a2.jsonl"),
      JSON.stringify({ type: "user", timestamp: "2026-07-01T15:00:20.000Z", message: { role: "user", content: "Find the bug" } }));
    // The roster orders by transcript mtime. Writes a few ms apart can share one timestamp (Linux
    // stamps files from a coarse clock tick), so the order is set explicitly: a2 is the newer one.
    await utimes(join(dir, "agent-a1.jsonl"), new Date("2026-07-01T15:00:09Z"), new Date("2026-07-01T15:00:09Z"));
    await utimes(join(dir, "agent-a2.jsonl"), new Date("2026-07-01T15:00:20Z"), new Date("2026-07-01T15:00:20Z"));
  }

  it("assembles the inner-agent roster (state, label, resultPreview, meta) newest-first", async () => {
    await seed();
    const { agents, transcript } = await inspectWorkflowDir(dir);
    expect(transcript).toBeNull();                      // no innerAgentId requested
    expect(agents.map((a) => a.agentId)).toEqual(["a2", "a1"]);  // a2 mtime newer -> first
    const a1 = agents.find((a) => a.agentId === "a1")!;
    expect(a1.state).toBe("done");
    expect(a1.resultPreview).toBe("a1 is done");
    expect(a1.label).toBe("Review the diff");
    expect(a1.agentType).toBe("reviewer");
    expect(a1.spawnDepth).toBe(1);
    const a2 = agents.find((a) => a.agentId === "a2")!;
    expect(a2.state).toBe("running");
    expect(a2.resultPreview).toBeNull();
    expect(a2.model).toBe("claude");
  });

  it("returns a transcript tail for the drilled-into inner agent", async () => {
    await seed();
    const { transcript } = await inspectWorkflowDir(dir, { innerAgentId: "a1", tailLines: 1 });
    expect(transcript).toEqual([{ role: "assistant", text: "done reviewing", ts: Date.parse("2026-07-01T15:00:09.000Z") }]);
  });

  it("degrades an unknown innerAgentId to an empty transcript, not a throw", async () => {
    await seed();
    const { transcript } = await inspectWorkflowDir(dir, { innerAgentId: "ghost" });
    expect(transcript).toEqual([]);
  });

  it("throws when the dir itself is missing (caller degrades to available:false)", async () => {
    await expect(inspectWorkflowDir(join(dir, "does-not-exist"))).rejects.toBeTruthy();
  });
});
