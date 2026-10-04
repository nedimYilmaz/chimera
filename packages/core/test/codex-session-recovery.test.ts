import { describe, expect, it, vi } from "vitest";
import type { readFileSync } from "node:fs";
import { AgentSpecSchema } from "@chimera/protocol";
import { EventLog } from "@chimera/core/events";
import { reattachFromState, reconstructAgentsFromLog, type ReattachEngine } from "@chimera/core/reattach";
import type { AgentRecord } from "@chimera/core/supervisor";
import { makeEngineHome } from "./helpers.js";

function record(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: "a", spec: AgentSpecSchema.parse({ prompt: "work", cwd: "/tmp", isolation: "none" }),
    provider: "codex", accountName: "main", state: "running", depth: 0, treeId: "a", createdAt: 1,
    principal: "local", attempts: [{ account: "main", startedAt: 2 }], costUsd: 4, parentId: null, projectId: null,
    ...over,
  };
}
function log() { return new EventLog(makeEngineHome(), { maxEventsPerSegment: 3, maxSegments: 30 }); }
function start(events: EventLog, data: Record<string, unknown> = {}, agentId = "a") {
  return events.append({ agentId, kind: "agent_started", data: { provider: "codex", accountName: "main", createdAt: 1, threadId: "saved-thread", ...data } });
}
function boot(events: EventLog, agents: AgentRecord[], lastSeq = events.currentSeq()) {
  const captured: AgentRecord[] = [];
  const spawn = vi.fn<ReattachEngine["supervisor"]["spawn"]>();
  const engine: ReattachEngine = { events, supervisor: {
    spawn,
    reattachDormant: a => { captured.push(a); },
    reattachPaused: a => { captured.push(a); },
    reattachTerminal: a => { captured.push(a); },
  } };
  reattachFromState(engine, "/fake/state.json", (() => JSON.stringify({ agents, lastSeq })) as unknown as typeof readFileSync, () => true);
  expect(spawn).not.toHaveBeenCalled();
  return captured;
}

describe("legacy Codex thread identity recovery", () => {
  it("replays per-agent realtime preferences without changing paused state or session identity", () => {
    const events = log(); const agents = [record({ state: "paused", sessionId: "existing" })];
    reconstructAgentsFromLog(agents, [events.append({ agentId: "a", kind: "status", data: { nativeVoiceEnabled: true } })]);
    expect(agents[0]).toMatchObject({ state: "paused", sessionId: "existing", spec: { persistent: true, providerOptions: { codexTransport: "app-server", codexRealtime: true } } });
    reconstructAgentsFromLog(agents, [events.append({ agentId: "a", kind: "status", data: { nativeVoiceEnabled: false } })]);
    expect(agents[0]).toMatchObject({ state: "paused", sessionId: "existing", spec: { providerOptions: { codexRealtime: false } } });
  });
  it("recovers a pre-snapshot start across sealed segments without replaying prompts, costs or lifecycle", () => {
    const events = log();
    start(events);
    for (let i = 0; i < 25; i++) events.append({ agentId: "a", kind: "status", data: { i } });
    const restored = boot(events, [record({ state: "paused", pauseReason: "operator-hold" })]);
    expect(restored[0]).toMatchObject({ sessionId: "saved-thread", state: "paused", costUsd: 4 });
  });

  it("chooses the newest start in the current attempt and never another agent", () => {
    const events = log();
    start(events, { threadId: "older-thread" });
    start(events, { threadId: "newest-thread" });
    start(events, { threadId: "other-thread" }, "other");
    expect(boot(events, [record()])[0]?.sessionId).toBe("newest-thread");
  });

  it.each([
    ["different account", { accountName: "other" }],
    ["different provider", { provider: "claude" }],
    ["reused agent id", { createdAt: 0 }],
    ["empty thread", { threadId: "" }],
    ["malformed thread", { threadId: 42 }],
  ])("does not recover from a %s or fall back to an older start", (_label, data) => {
    const events = log();
    start(events);
    start(events, data);
    expect(boot(events, [record()])).toHaveLength(0);
  });

  it("does not recover a previous attempt's thread or guess when the attempt boundary is missing", () => {
    const events = log(); const e = start(events);
    expect(boot(events, [record({ attempts: [{ account: "main", startedAt: e.ts + 1 }] })])).toHaveLength(0);
    expect(boot(events, [record({ attempts: [] })])).toHaveLength(0);
  });

  it("never overwrites an already saved session or interprets another provider's threadId", () => {
    const events = log(); start(events);
    const restored = boot(events, [record({ sessionId: "authoritative" })]);
    expect(restored[0]?.sessionId).toBe("authoritative");
    expect(boot(events, [record({ provider: "claude" })])).toHaveLength(0);
  });

  it("does not revive a killed agent when recovering its historical thread", () => {
    const events = log(); start(events);
    expect(boot(events, [record({ state: "killed" })])[0]).toMatchObject({ state: "killed", sessionId: "saved-thread" });
  });

  it("folds legacy thread IDs in the post-snapshot gap too, preferring the normalized session ID", () => {
    const events = log(); start(events);
    expect(boot(events, [record()], 0)[0]?.sessionId).toBe("saved-thread");
    const agents = [record()];
    reconstructAgentsFromLog(agents, [start(events, { sessionId: "normalized" })]);
    expect(agents[0]?.sessionId).toBe("normalized");
    const claude = [record({ provider: "claude" })];
    reconstructAgentsFromLog(claude, [start(events)]);
    expect(claude[0]?.sessionId).toBeUndefined();
  });

  it("limits historical lookup to the snapshot watermark", () => {
    const events = log(); const old = start(events, { threadId: "old" });
    start(events, { threadId: "new" });
    expect(events.latestAgentStarts(new Map([["a", 2]]), old.seq).get("a")?.data.threadId).toBe("old");
  });
});
