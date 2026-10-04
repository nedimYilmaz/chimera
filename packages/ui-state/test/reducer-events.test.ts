import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { qualifiedAgentId, reduce } from "@chimera/ui-state";
import { EVENT_BUFFER_MAX, TOOLS_BUFFER_MAX, TRANSCRIPT_BUFFER_MAX, initialState, type UiState } from "@chimera/ui-state";

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}, s?: number): NormalizedEvent =>
  ({ ts: 1000 + (s ?? ++seq), seq: s ?? seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);

describe("reducer: event projection", () => {
  it("accumulates message_deltas into one streaming item and finalizes on message_complete", () => {
    const st = feed(initialState, [
      ev("a1", "agent_started", { model: "m1" }),
      ev("a1", "message_delta", { text: "hel" }),
      ev("a1", "message_delta", { text: "lo" }),
    ]);
    const agent = st.agents["a1"]!;
    expect(agent.state).toBe("running");
    expect(agent.model).toBe("m1");
    expect(agent.transcript).toMatchObject([{ role: "assistant", text: "hello", streaming: true }]);

    const st2 = feed(st, [ev("a1", "message_complete", { text: "hello world" })]);
    expect(st2.agents["a1"]!.transcript).toMatchObject([{ role: "assistant", text: "hello world", streaming: false }]);
  });

  it("system-namespace events (config/network/federation/capability) never create a phantom agent", () => {
    const st = feed(initialState, [
      ev("config", "config_changed", { keys: ["providers"] }),
      ev("capability", "capability_decision", { decision: "allow" }),
    ]);
    // no phantom agent record, no agent-list row, no auto-selection off a system event
    expect(st.agents["config"]).toBeUndefined();
    expect(st.agents["capability"]).toBeUndefined();
    expect(st.agentOrder).not.toContain("config");
    expect(st.agentOrder).not.toContain("capability");
    expect(st.selectedAgentId).not.toBe("config");
    expect(st.selectedAgentId).not.toBe("capability");
    // but they DO stay in the global event feed (Events tab)
    expect(st.events.map((e) => e.kind)).toEqual(["config_changed", "capability_decision"]);
    // a real agent event alongside them still creates exactly one agent
    const st2 = feed(st, [ev("a1", "agent_started", { model: "m1" })]);
    expect(st2.agentOrder).toEqual(["a1"]);
  });

  it("PHANTOM-PRINCIPAL-ROWS: notify's 'notify' agentId and jobs' 'job:<name>' agentId never create a phantom agent", () => {
    const st = feed(initialState, [
      ev("notify", "notify", { ruleId: "job-failed", kind: "job_run_finished", channel: "toast", agentId: "a1", count: 1 }),
      ev("notify", "notify_error", { ruleId: "budget-80", kind: "budget_warning", channel: "webhook", agentId: "a1", count: 1, message: "boom" }),
      ev("job:nightly-sync", "job_run_finished", { job: "nightly-sync", result: "failed", costUsd: 0, error: "boom" }),
    ]);
    expect(st.agents["notify"]).toBeUndefined();
    expect(st.agents["job:nightly-sync"]).toBeUndefined();
    expect(st.agentOrder).not.toContain("notify");
    expect(st.agentOrder).not.toContain("job:nightly-sync");
    expect(st.selectedAgentId).not.toBe("notify");
    // events remain reachable on the global feed (Events tab / chronicle) — nothing is swallowed
    expect(st.events.map((e) => e.kind)).toEqual(["notify", "notify_error", "job_run_finished"]);
    // agent COUNT (agentOrder.length, what App.tsx/fleetSummary both read) isn't inflated
    expect(st.agentOrder.length).toBe(0);
    // a real agent alongside these synthetic principals still creates exactly one row
    const st2 = feed(st, [ev("a1", "agent_started", { model: "m1" })]);
    expect(st2.agentOrder).toEqual(["a1"]);
    expect(st2.agentOrder.length).toBe(1);
  });

  it("F02: clock_jump's 'clock' agentId never creates a phantom agent", () => {
    const st = feed(initialState, [
      ev("clock", "clock_jump", { driftMs: 33180000, observedGapMs: 33180000, expectedGapMs: 60000, thresholdMs: 120000, direction: "forward", source: "jobs" }),
    ]);
    expect(st.agents["clock"]).toBeUndefined();
    expect(st.agentOrder).not.toContain("clock");
    expect(st.selectedAgentId).not.toBe("clock");
    // stays in the global event feed (Events tab / clockJumpNotice selector)
    expect(st.events.map((e) => e.kind)).toEqual(["clock_jump"]);
    expect(st.agentOrder.length).toBe(0);
  });

  it("F01: job_wake_scheduled/job_wake_failed's 'wake' agentId never creates a phantom agent", () => {
    const st = feed(initialState, [
      ev("wake", "job_wake_scheduled", { atMs: 1_700_000_000_000, forJob: "nightly", leadMs: 120000 }),
      ev("wake", "job_wake_failed", { atMs: 1_700_000_000_000, reason: "wrapper not installed" }),
    ]);
    expect(st.agents["wake"]).toBeUndefined();
    expect(st.agentOrder).not.toContain("wake");
    expect(st.selectedAgentId).not.toBe("wake");
    expect(st.events.map((e) => e.kind)).toEqual(["job_wake_scheduled", "job_wake_failed"]);
    expect(st.agentOrder.length).toBe(0);
  });

  it("F02.UI: a clock jump drops a system line into the transcript of every MID-TURN agent", () => {
    const st = feed(initialState, [
      ev("a1", "agent_started", { model: "m1" }),
      ev("a1", "message_delta", { text: "thinking" }),   // a1 is mid-turn
      ev("a2", "agent_started", { model: "m1" }),
      ev("a2", "turn_complete", {}),                      // a2 is idle
    ]);
    expect(st.agents["a1"]!.busy).toBe(true);
    expect(st.agents["a2"]!.busy).toBe(false);
    const idleLines = st.agents["a2"]!.transcript.length;
    const after = feed(st, [
      ev("clock", "clock_jump", { driftMs: 33_180_000, observedGapMs: 33_240_000, expectedGapMs: 60_000, direction: "forward", source: "jobs" }),
    ]);
    const line = after.agents["a1"]!.transcript.at(-1)!;
    expect(line.role).toBe("system");
    expect(line.text).toBe("⏱ chimera slept 9h 13m — elapsed time on this turn includes the sleep");
    // an idle agent was not misled by the gap, so a suspend never spams every transcript
    expect(after.agents["a2"]!.transcript.length).toBe(idleLines);
    // and the phantom-row guard still holds
    expect(after.agentOrder).not.toContain("clock");
  });

  it("F02.UI: a BACKWARD step says elapsed times are unreliable, not that anything slept", () => {
    const st = feed(initialState, [ev("a1", "agent_started", {}), ev("a1", "message_delta", { text: "x" })]);
    const after = feed(st, [ev("clock", "clock_jump", { driftMs: -780_000, observedGapMs: -720_000, direction: "backward", source: "jobs" })]);
    expect(after.agents["a1"]!.transcript.at(-1)!.text)
      .toBe("⏱ the system clock stepped back 13m — elapsed times spanning this point are unreliable");
  });

  it("REGRESSION GUARD: the shadow: id-rule exception is unchanged — a shadow agentId still materializes a row", () => {
    const st = feed(initialState, [
      ev("shadow:a1:t1", "message_complete", { text: "sub-agent output" }),
    ]);
    expect(st.agents["shadow:a1:t1"]).toBeDefined();
    expect(st.agents["shadow:a1:t1"]!.shadow).toBe(true);
    expect(st.agentOrder).toContain("shadow:a1:t1");
  });

  it("tracks the tool lifecycle: called -> done (with input+result), and denied via status events", () => {
    const st = feed(initialState, [
      ev("a1", "tool_call", { toolName: "Edit", input: { file: "a.ts" } }),
      ev("a1", "tool_result", { result: "1 replacement" }),
      ev("a1", "status", { denied: true, toolName: "Bash" }),
    ]);
    expect(st.agents["a1"]!.tools).toEqual([
      { ts: expect.any(Number), toolName: "Edit", input: { file: "a.ts" }, status: "done" },
      { ts: expect.any(Number), toolName: "Bash", status: "denied" },
    ]);
    // The tool TranscriptItem is now first-class (carries toolName/input/status/result)
    // instead of the old `{role:"tool", text:"→ Edit"}` arrow form — this is the whole
    // point of #9 (show WHAT ran, once, inline).
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "tool", toolName: "Edit", input: { file: "a.ts" }, status: "done", result: "1 replacement" },
      { role: "tool", toolName: "Bash", status: "denied" },
    ]);
  });

  it("collects pending permissions and clears them on result/error", () => {
    const st = feed(initialState, [
      ev("a1", "permission_request", { requestId: "r1", toolName: "Bash", input: { cmd: "ls" }, policy: "tui" }),
    ]);
    expect(st.pendingPermissions).toEqual([
      { requestId: "r1", agentId: "a1", toolName: "Bash", input: { cmd: "ls" }, ts: expect.any(Number) },
    ]);
    const st2 = feed(st, [ev("a1", "result", { text: "done", costUsd: 0.2 })]);
    expect(st2.pendingPermissions).toEqual([]);
    expect(st2.agents["a1"]!.state).toBe("done");
    expect(st2.agents["a1"]!.costUsd).toBe(0.2);
    expect(st2.agents["a1"]!.transcript.at(-1)).toMatchObject({ role: "system", text: "result: done" });
  });

  it("projects turn_complete cost, error, failover and interrupted status", () => {
    const st = feed(initialState, [
      ev("a1", "turn_complete", { turnCostUsd: 0.07 }),
      ev("a2", "error", { message: "HTTP 429" }),
      ev("a3", "failover", { from: "main", to: "second", reason: "429" }),
      ev("a4", "status", { state: "interrupted" }),
    ]);
    expect(st.agents["a1"]!.costUsd).toBe(0.07);
    expect(st.agents["a2"]!.state).toBe("failed");
    expect(st.agents["a2"]!.transcript.at(-1)).toMatchObject({ role: "system", text: "error: HTTP 429" });
    expect(st.agents["a3"]!.transcript.at(-1)).toMatchObject({ role: "system", text: "failover main → second" });
    expect(st.agents["a4"]!.state).toBe("failed");
  });

  it("FAILOVER-ACCOUNT-LIVE: a failover event updates agent.account/provider, not just the transcript", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "running", accountName: "main", provider: "anthropic", costUsd: 0, createdAt: 1 }],
    });
    expect(st.agents["a1"]!.account).toBe("main");
    expect(st.agents["a1"]!.provider).toBe("anthropic");

    // auto-failover shape (onError): carries toProvider
    const st2 = feed(st, [ev("a1", "failover", { from: "main", fromProvider: "anthropic", to: "second", toProvider: "openai", reason: "429" })]);
    expect(st2.agents["a1"]!.account).toBe("second");
    expect(st2.agents["a1"]!.provider).toBe("openai");

    // manual account-switch shape (applyAccount): carries `provider`, not `toProvider`
    const st3 = feed(st2, [ev("a1", "failover", { from: "second", to: "third", provider: "openai", reason: "manual account switch" })]);
    expect(st3.agents["a1"]!.account).toBe("third");
    expect(st3.agents["a1"]!.provider).toBe("openai");
  });

  it("CIRCUIT-BREAKER-VISIBLE: circuit_breaker_tripped renders a system line explaining the crash loop", () => {
    const st = feed(initialState, [
      ev("a1", "circuit_breaker_tripped", { crashCount: 4, reason: "backend exited with code 1" }),
      ev("a1", "status", { state: "failed", circuitOpen: true, crashCount: 4 }),
    ]);
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "system", text: "crash-looped after 4 attempts, giving up: backend exited with code 1" },
    ]);
    // the paired status{failed} event still folds through the existing terminal-state path
    expect(st.agents["a1"]!.state).toBe("failed");
  });

  it("COMPACTION-OBSERVABILITY: a chimera-owned compaction event renders the exact mechanical effect, never claims 'summarized'", () => {
    const st = feed(initialState, [
      ev("a1", "compaction", {
        trigger: "budget", owner: "chimera", budgetSource: "default",
        before: { messages: 42, chars: 90_000 }, after: { messages: 22, chars: 12_000 }, droppedRounds: 20,
      }),
    ]);
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "system", text: "⇥ context compacted (budget): dropped 20 earlier round(s), 90,000 chars → 12,000 chars" },
    ]);
  });

  it("COMPACTION-OBSERVABILITY: an SDK-native compaction event reports tokens only, never a message/round count it doesn't have", () => {
    const st = feed(initialState, [
      ev("a1", "compaction", { trigger: "manual", owner: "sdk", before: { tokens: 195_000 }, after: { tokens: 20_000 } }),
    ]);
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "system", text: "⇥ context compacted (manual, provider-native): ~195,000 tok → ~20,000 tok" },
    ]);
  });

  it("UNDELIVERED-MESSAGE-EVENTS-DROPPED: a status{undeliveredMessage} event renders a system line, not silence", () => {
    const st = feed(initialState, [
      ev("a1", "status", { undeliveredMessage: true, reason: "no live session to resume" }),
    ]);
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "system", text: "message not delivered: no live session to resume" },
    ]);
    // an undelivered-message status alone is not terminal — must not clobber agent.state
    expect(st.agents["a1"]!.state).not.toBe("failed");
  });

  it("KIMI-CAPABILITY-NOTICE-INVISIBLE: a status{capabilityNotice} event renders one system line per notice line, not silence", () => {
    // The exact payload backends/kimi.ts emits once its stdio-MCP fix withholds the chimera
    // grant — the case an operator MUST see, since the agent has no chimera-native tools at all.
    const st = feed(initialState, [
      ev("a1", "status", {
        capabilityNotice: {
          mcpServersWithheld: [{ name: "chimera", reason: "stdio-unsupported" }],
          settingSourcesUnsupported: false,
          lines: ["1 MCP server(s) (chimera) were withheld entirely this session: the installed kimi CLI's ACP transport rejects stdio-transport MCP servers."],
        },
      }),
    ]);
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "system", text: /^capability notice: 1 MCP server\(s\) \(chimera\) were withheld/ },
    ]);
    // Not terminal — a withheld capability degrades the agent, it does not fail it.
    expect(st.agents["a1"]!.state).not.toBe("failed");
  });

  it("KIMI-CAPABILITY-NOTICE-INVISIBLE: two notice lines render two system lines; a status event without the field renders none", () => {
    const st = feed(initialState, [
      ev("a1", "status", { capabilityNotice: { lines: ["withheld A", "withheld B"] } }),
      ev("a1", "status", { registered: true }),
      // Defensive: a malformed/absent `lines` must degrade to silence, never to a crash or a
      // "[object Object]" line — `capabilityNotice` crosses a daemon RPC boundary untyped.
      ev("a1", "status", { capabilityNotice: { mcpServersWithheld: [{ name: "x", reason: "allowlist" }] } }),
      ev("a1", "status", { capabilityNotice: "not-an-object" }),
    ]);
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "system", text: "capability notice: withheld A" },
      { role: "system", text: "capability notice: withheld B" },
    ]);
  });

  it("LIVE-CTX-USAGE: a mid-turn usage event folds into agent.usage before turn_complete, latest-wins not additive", () => {
    const st = feed(initialState, [
      // message_start baseline: real context size for this turn, before any output exists.
      ev("a1", "usage", { usage: { input_tokens: 5000, cache_read_input_tokens: 1000 } }),
    ]);
    expect(st.agents["a1"]!.usage).toEqual({ input: 5000, output: 0, cacheRead: 1000, cacheCreation: 0 });

    // message_delta: output ticks up, replacing (not adding to) the prior snapshot.
    const st2 = feed(st, [ev("a1", "usage", { usage: { input_tokens: 5000, cache_read_input_tokens: 1000, output_tokens: 42 } })]);
    expect(st2.agents["a1"]!.usage).toEqual({ input: 5000, output: 42, cacheRead: 1000, cacheCreation: 0 });

    // turn_complete lands the turn's authoritative final usage — still latest-wins, not
    // summed with the live snapshots that preceded it.
    const st3 = feed(st2, [
      ev("a1", "turn_complete", { turnCostUsd: 0.01, usage: { input_tokens: 5000, output_tokens: 120, cache_read_input_tokens: 1000 } }),
    ]);
    expect(st3.agents["a1"]!.usage).toEqual({ input: 5000, output: 120, cacheRead: 1000, cacheCreation: 0 });
    expect(st3.agents["a1"]!.costUsd).toBe(0.01);

    // a subsequent result with no usage payload leaves the last authoritative tally intact.
    const st4 = feed(st3, [ev("a1", "result", { text: "done", costUsd: 0.01 })]);
    expect(st4.agents["a1"]!.usage).toEqual({ input: 5000, output: 120, cacheRead: 1000, cacheCreation: 0 });
  });

  it("projects billable and current-context scopes independently", () => {
    const st = feed(initialState, [ev("a1", "turn_complete", {
      billableUsage: { input_tokens: 250, cached_input_tokens: 50, output_tokens: 20 },
      contextUsage: { input_tokens: 80, cached_input_tokens: 20, output_tokens: 5 },
    })]);
    expect(st.agents["a1"]!.usage).toEqual({ input: 200, output: 20, cacheRead: 50, cacheCreation: 0 });
    expect(st.agents["a1"]!.ctxUsage).toEqual({ input: 60, output: 5, cacheRead: 20, cacheCreation: 0 });

    const done = feed(st, [ev("a1", "result", {
      billableUsage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 90 },
      contextUsage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 9 },
    })]);
    expect(done.agents["a1"]!.usage).toEqual({ input: 800, output: 90, cacheRead: 100, cacheCreation: 0 });
    expect(done.agents["a1"]!.ctxUsage).toEqual({ input: 75, output: 9, cacheRead: 25, cacheCreation: 0 });
  });

  it("discards historical exec totals from context and preserves billing during live context updates", () => {
    const total = { input_tokens: 2406861, cached_input_tokens: 2293760, output_tokens: 20007 };
    const old = feed(initialState, [
      ev("a1", "agent_started", { codexTransport: "exec" }),
      ev("a1", "turn_complete", { billableUsage: total, contextUsage: total }),
    ]);
    expect(old.agents.a1!.ctxUsage).toBeNull();
    const snapshot = { ...old, agents: { ...old.agents, a1: { ...old.agents.a1!, provider: "codex", codexTransport: undefined } } };
    const truncatedHistory = feed(snapshot, [ev("a1", "turn_complete", { billableUsage: total, contextUsage: total })]);
    expect(truncatedHistory.agents.a1!.ctxUsage).toBeNull();
    const live = feed(old, [ev("a1", "usage", { contextOnly: true, sessionUsage: total,
      contextUsage: { input_tokens: 109416, cached_input_tokens: 108800, output_tokens: 595, reasoning_output_tokens: 281 }, effectiveContextLimit: 258400 })]);
    expect(live.agents.a1!.usage).toEqual(old.agents.a1!.usage);
    expect(live.agents.a1!.sessionUsage?.cacheRead).toBe(2293760);
    expect(live.agents.a1!.ctxUsage).toEqual({ input: 616, cacheRead: 108800, cacheCreation: 0, output: 595 });
    expect(live.agents.a1!.effectiveContextLimit).toBe(258400);
  });

  it("ACCOUNT-QUOTA-METERS: a live quota event upserts the owning account's window by kind", () => {
    // Seed an account snapshot (as daemonStatus would) and attribute agent a1 to it
    // (as an agentRecords snapshot would, via AgentRecordLite.accountName -> agent.account).
    let st = reduce(initialState, {
      type: "daemonStatus",
      status: {
        protocolVersion: 1,
        agents: { running: 1, done: 0, failed: 0, killed: 0 },
        accounts: [{ name: "main", provider: "claude", authType: "subscription", cooling: false, coolingUntil: null }],
      },
    });
    st = reduce(st, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 0 }],
    });

    st = feed(st, [ev("a1", "quota", { window: { kind: "session", usedFraction: 0.4, windowStartedAt: 100, resetsAt: 200 } })]);
    expect(st.accounts[0]!.quota).toEqual({
      account: "main",
      windows: [{ kind: "session", usedFraction: 0.4, windowStartedAt: 100, resetsAt: 200 }],
      fetchedAt: expect.any(Number),
    });

    // A later window of a DIFFERENT kind is added alongside, not replacing it...
    st = feed(st, [ev("a1", "quota", { window: { kind: "weekly", usedFraction: 0.1, windowStartedAt: 0, resetsAt: 300 } })]);
    expect(st.accounts[0]!.quota!.windows).toHaveLength(2);

    // ...while a later window of the SAME kind replaces the prior one (upsert, not append).
    st = feed(st, [ev("a1", "quota", { window: { kind: "session", usedFraction: 0.9, windowStartedAt: 100, resetsAt: 200 } })]);
    expect(st.accounts[0]!.quota!.windows).toHaveLength(2);
    expect(st.accounts[0]!.quota!.windows.find((w) => w.kind === "session")!.usedFraction).toBe(0.9);
  });

  it("dedupes by seq (tail replay + live subscribe overlap)", () => {
    const dup = ev("a1", "message_complete", { text: "once" }, 42);
    const st = feed(initialState, [dup, dup]);
    expect(st.agents["a1"]!.transcript.length).toBe(1);
    expect(st.events.length).toBe(1);
    expect(st.lastSeq).toBe(42);
  });

  it("caps the global event feed at EVENT_BUFFER_MAX and auto-selects the first agent", () => {
    const many = Array.from({ length: EVENT_BUFFER_MAX + 50 }, (_, i) => ev("a1", "message_delta", { text: "x" }, 100 + i));
    const st = feed(initialState, many);
    expect(st.events.length).toBe(EVENT_BUFFER_MAX);
    expect(st.events[0]!.seq).toBe(100 + 50);
    expect(st.agentOrder).toEqual(["a1"]);
    expect(st.selectedAgentId).toBe("a1");
  });

  it("clears the pending permission on a permissionResolved status event (timeout fallback)", () => {
    const st = feed(initialState, [
      ev("a1", "permission_request", { requestId: "r7", toolName: "Bash", input: {}, policy: "tui" }),
    ]);
    expect(st.pendingPermissions.length).toBe(1);
    const st2 = feed(st, [ev("a1", "status", { permissionResolved: true, requestId: "r7", allow: false, timedOut: true })]);
    expect(st2.pendingPermissions).toEqual([]);
  });

  it("clears pendingQuestion on a questionResolved status event (timeout fallback) — FEATURE-9 phantom-inbox-item regression", () => {
    const st = feed(initialState, [ev("a1", "agent_question", { questionId: "q7", prompt: "ship it?" })]);
    expect(st.agents["a1"]!.pendingQuestion).not.toBeNull();
    const st2 = feed(st, [ev("a1", "status", { questionResolved: true, questionId: "q7", timedOut: true })]);
    expect(st2.agents["a1"]!.pendingQuestion).toBeNull();
  });

  it("questionResolved for a DIFFERENT (stale) questionId does not clear the current pendingQuestion", () => {
    const st = feed(initialState, [
      ev("a1", "agent_question", { questionId: "q1", prompt: "one" }),
      ev("a1", "agent_question", { questionId: "q2", prompt: "two" }),   // replaces q1
    ]);
    const st2 = feed(st, [ev("a1", "status", { questionResolved: true, questionId: "q1" })]);   // stale resolution for q1
    expect(st2.agents["a1"]!.pendingQuestion?.questionId).toBe("q2");
  });

  it("a status event without questionResolved:true does not touch pendingQuestion", () => {
    const st = feed(initialState, [ev("a1", "agent_question", { questionId: "q1", prompt: "one" })]);
    const st2 = feed(st, [ev("a1", "status", { denied: true, toolName: "Bash" })]);
    expect(st2.agents["a1"]!.pendingQuestion?.questionId).toBe("q1");
  });

  it("projects non-TUI delivered user turns unchanged", () => {
    const st = feed(initialState, [
      ev("a1", "status", { delivered: true, from: "mcp", text: "ship it" }),
    ]);
    // DELIVERY.MARK: the origin rides on a STRUCTURED `from` field (so the
    // renderer can mark it distinctly) -- NOT baked into the text as a prefix.
    expect(st.agents["a1"]!.transcript).toMatchObject([{ role: "user", text: "ship it", from: "mcp" }]);
  });

  it("DELIVERY.MARK: a genuine user turn (userSent) carries no `from`", () => {
    const st = reduce(initialState, { type: "userSent", agentId: "a1", text: "hello" });
    expect(st.agents["a1"]!.transcript).toMatchObject([{ role: "user", text: "hello" }]);
    expect(st.agents["a1"]!.transcript[0]).not.toHaveProperty("from");
  });

  it("OWN-TURNS-SURVIVE-RELOAD (live): a from:\"tui\" delivered event dedupes against the already-echoed (userSent) turn -- exactly one user turn, no dupe", () => {
    const echoed = reduce(initialState, { type: "userSent", agentId: "a1", text: "already echoed" });
    const st = feed(echoed, [ev("a1", "status", { delivered: true, from: "tui", text: "already echoed" })]);
    expect(st.agents["a1"]!.transcript).toMatchObject([{ role: "user", text: "already echoed" }]);
  });

  it("OWN-TURNS-SURVIVE-RELOAD (live): a from:\"app\" delivered event ALSO dedupes -- the app is a human cockpit surface that locally echoes its own sends, exactly like the tui", () => {
    const echoed = reduce(initialState, { type: "userSent", agentId: "a1", text: "already echoed" });
    const st = feed(echoed, [ev("a1", "status", { delivered: true, from: "app", text: "already echoed" })]);
    expect(st.agents["a1"]!.transcript).toMatchObject([{ role: "user", text: "already echoed" }]);
    // no `from` marker: an own-surface turn must NOT render as an inbound "[from app]" delivery
    expect(st.agents["a1"]!.transcript[0]).not.toHaveProperty("from");
  });

  it("OWN-TURNS-SURVIVE-RELOAD (live): the echo may be followed by streamed assistant output before the delivered event lands -- still dedupes", () => {
    const echoed = reduce(initialState, { type: "userSent", agentId: "a1", text: "already echoed" });
    const st = feed(echoed, [
      ev("a1", "message_delta", { text: "working on it" }),
      ev("a1", "status", { delivered: true, from: "tui", text: "already echoed" }),
    ]);
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "user", text: "already echoed" },
      { role: "assistant", text: "working on it", streaming: true },
    ]);
  });

  it("OWN-TURNS-SURVIVE-RELOAD (reload/replay): a from:\"tui\" delivered event with NO prior local echo (e.g. rebuilt from event history after a reload) IS pushed as a plain user turn", () => {
    const st = feed(initialState, [ev("a1", "status", { delivered: true, from: "tui", text: "sent before reload" })]);
    expect(st.agents["a1"]!.transcript).toMatchObject([{ role: "user", text: "sent before reload" }]);
    expect(st.agents["a1"]!.transcript[0]).not.toHaveProperty("from");
  });

  it("OWN-TURNS-SURVIVE-RELOAD: a quote-reply's encoded blockquote text survives the reload/replay push verbatim (opaque to the reducer)", () => {
    const quoted = "> line one\n> — @main · turn · 10:00:00\nfollow-up text";
    const st = feed(initialState, [ev("a1", "status", { delivered: true, from: "tui", text: quoted })]);
    expect(st.agents["a1"]!.transcript).toMatchObject([{ role: "user", text: quoted }]);
  });

  it("OWN-TURNS-SURVIVE-RELOAD: a delivered turn from ANOTHER agent is unaffected by the tui-dedup path", () => {
    const st = feed(initialState, [ev("a1", "status", { delivered: true, from: "sub-agent-1", text: "status update" })]);
    expect(st.agents["a1"]!.transcript).toMatchObject([{ role: "user", text: "status update", from: "sub-agent-1" }]);
  });

  it("DELIVERY.MARK: a delivered turn with a missing OR empty `from` coalesces to '?' (never falsy, so the renderer can't mistake it for 'you')", () => {
    const st = feed(initialState, [
      ev("a1", "status", { delivered: true, text: "no origin" }),         // from missing
      ev("a2", "status", { delivered: true, from: "", text: "empty origin" }), // from empty
    ]);
    expect(st.agents["a1"]!.transcript).toMatchObject([{ role: "user", text: "no origin", from: "?" }]);
    expect(st.agents["a2"]!.transcript).toMatchObject([{ role: "user", text: "empty origin", from: "?" }]);
  });

  it("keeps ':'-namespaced coordination events (team:/queue:/task:) out of the agent list", () => {
    const st = feed(initialState, [
      ev("task:0af3", "status", { state: "queued" }),
      ev("team:alpha", "status", { running: 1 }),
    ]);
    expect(st.agents).toEqual({});
    expect(st.agentOrder).toEqual([]);
    expect(st.selectedAgentId).toBeNull();
    expect(st.events.length).toBe(2);                 // still visible in the global feed
  });

  it("qualifiedAgentId: local ids stay bare; remote ids gain the engine prefix (PP6)", () => {
    expect(qualifiedAgentId({ agentId: "a1" })).toBe("a1");
    expect(qualifiedAgentId({ agentId: "a1", engineId: "local" })).toBe("a1");
    expect(qualifiedAgentId({ agentId: "a1", engineId: "eu-1" })).toBe("eu-1/a1");
  });

  it("keys per-agent state by qualifiedAgentId — two engines never collide (PP6)", () => {
    const local = { ts: 1, seq: 1, agentId: "a1", engineId: "local", kind: "agent_started", data: {} } as NormalizedEvent;
    const remote = { ts: 2, seq: 2, agentId: "a1", engineId: "eu-1", kind: "agent_started", data: {} } as NormalizedEvent;
    const st = feed(initialState, [local, remote]);
    expect(Object.keys(st.agents).sort()).toEqual(["a1", "eu-1/a1"]);
    expect(st.agentOrder).toEqual(["a1", "eu-1/a1"]);
  });
});

describe("reducer: additional branch/edge coverage (beyond brief examples)", () => {
  // NOTE: this suite's own P3.5-era test previously asserted that every non-
  // "event" action fell through the default arm unchanged ("Task 6 territory").
  // Task 6 fills in that territory for real (see reducer-actions.test.ts for
  // the full action-by-action coverage), so that placeholder assertion is
  // superseded rather than kept as a regression check.

  it("dedupes a strictly-stale seq (out-of-order arrival), not just an exact repeat", () => {
    const st = feed(initialState, [ev("a1", "message_complete", { text: "newer" }, 10)]);
    const st2 = feed(st, [ev("a1", "message_complete", { text: "stale" }, 5)]);
    expect(st2).toBe(st); // untouched: same reference, not just equal content
    expect(st2.lastSeq).toBe(10);
  });

  it("caps at exactly EVENT_BUFFER_MAX with no drops at the exact boundary (off-by-one guard)", () => {
    const exact = Array.from({ length: EVENT_BUFFER_MAX }, (_, i) => ev("a1", "message_delta", { text: "x" }, i + 1));
    const st = feed(initialState, exact);
    expect(st.events.length).toBe(EVENT_BUFFER_MAX);
    expect(st.events[0]!.seq).toBe(1);                      // first event NOT dropped yet
    expect(st.events[EVENT_BUFFER_MAX - 1]!.seq).toBe(EVENT_BUFFER_MAX);
  });

  it("agent_started without a model field leaves agent.model undefined", () => {
    const st = feed(initialState, [ev("a1", "agent_started", {})]);
    expect(st.agents["a1"]!.model).toBeUndefined();
    expect(st.agents["a1"]!.state).toBe("running");
  });

  it("message_delta with a missing text field accumulates an empty string (no throw)", () => {
    const st = feed(initialState, [ev("a1", "message_delta", {})]);
    expect(st.agents["a1"]!.transcript).toMatchObject([{ role: "assistant", text: "", streaming: true }]);
  });

  it("a new message_delta after a finalized message_complete starts a FRESH streaming item (doesn't reopen the old one)", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "first" }),
      ev("a1", "message_complete", { text: "first done" }),
      ev("a1", "message_delta", { text: "second" }),
    ]);
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "assistant", text: "first done", streaming: false },
      { role: "assistant", text: "second", streaming: true },
    ]);
  });

  it("message_complete with no preceding streaming delta pushes a finalized item directly", () => {
    const st = feed(initialState, [ev("a1", "message_complete", { text: "straight to done" })]);
    expect(st.agents["a1"]!.transcript).toMatchObject([{ role: "assistant", text: "straight to done", streaming: false }]);
  });

  it("tool_call with a missing toolName defaults to '?' in both the log and the transcript item", () => {
    const st = feed(initialState, [ev("a1", "tool_call", {})]);
    expect(st.agents["a1"]!.tools).toMatchObject([{ ts: expect.any(Number), toolName: "?", input: undefined, status: "called" }]);
    expect(st.agents["a1"]!.transcript).toMatchObject([{ role: "tool", toolName: "?", input: undefined, status: "called" }]);
  });

  it("tool_call omits toolId entirely when the event doesn't carry one (not just undefined)", () => {
    const st = feed(initialState, [ev("a1", "tool_call", { toolName: "Read" })]);
    expect(st.agents["a1"]!.transcript[0]).not.toHaveProperty("toolId");
  });

  it("tool_call with a toolId carries it onto the transcript item", () => {
    const st = feed(initialState, [ev("a1", "tool_call", { toolName: "Read", toolId: "t-1" })]);
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "tool", toolName: "Read", input: undefined, status: "called", toolId: "t-1" },
    ]);
  });

  it("tool_result with no matching 'called' tool is a no-op (nothing to mark done, no throw)", () => {
    const st = feed(initialState, [ev("a1", "tool_result", {})]);
    expect(st.agents["a1"]!.tools).toEqual([]);
    expect(st.agents["a1"]!.transcript).toMatchObject([]);
  });

  it("tool_result marks only the MOST RECENT 'called' tool done, searching from the end (both the log and the transcript item)", () => {
    const st = feed(initialState, [
      ev("a1", "tool_call", { toolName: "Read" }),
      ev("a1", "tool_call", { toolName: "Edit" }),
      ev("a1", "tool_result", {}),
    ]);
    expect(st.agents["a1"]!.tools).toEqual([
      { ts: expect.any(Number), toolName: "Read", input: undefined, status: "called" },
      { ts: expect.any(Number), toolName: "Edit", input: undefined, status: "done" },
    ]);
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "tool", toolName: "Read", input: undefined, status: "called" },
      { role: "tool", toolName: "Edit", input: undefined, status: "done" },
    ]);
  });

  it("tool_result with no 'result' field in e.data leaves the transcript item's result undefined (no 'result' key added)", () => {
    const st = feed(initialState, [
      ev("a1", "tool_call", { toolName: "Read" }),
      ev("a1", "tool_result", {}),
    ]);
    expect(st.agents["a1"]!.transcript[0]).toMatchObject({ role: "tool", toolName: "Read", input: undefined, status: "done" });
    expect(st.agents["a1"]!.transcript[0]).not.toHaveProperty("result");
  });

  it("tool_result matches by toolId when the calling event's toolId is present, even if it isn't the most recent 'called' item", () => {
    const st = feed(initialState, [
      ev("a1", "tool_call", { toolName: "Read", toolId: "t-1" }),
      ev("a1", "tool_call", { toolName: "Edit", toolId: "t-2" }),
      ev("a1", "tool_result", { toolId: "t-1", result: "read ok" }),
    ]);
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "tool", toolName: "Read", input: undefined, status: "done", toolId: "t-1", result: "read ok" },
      { role: "tool", toolName: "Edit", input: undefined, status: "called", toolId: "t-2" },
    ]);
  });

  it("tool_result with a toolId that matches no in-flight tool is a no-op on the transcript (strict match, no fallback)", () => {
    const st = feed(initialState, [
      ev("a1", "tool_call", { toolName: "Read", toolId: "t-1" }),
      ev("a1", "tool_result", { toolId: "no-such-id" }),
    ]);
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "tool", toolName: "Read", input: undefined, status: "called", toolId: "t-1" },
    ]);
  });

  it("tool_result without a toolId ignores toolId'd items too — falls back to the last 'called' regardless of toolId", () => {
    const st = feed(initialState, [
      ev("a1", "tool_call", { toolName: "Read", toolId: "t-1" }),
      ev("a1", "tool_result", { result: "done anyway" }),
    ]);
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "tool", toolName: "Read", input: undefined, status: "done", toolId: "t-1", result: "done anyway" },
    ]);
  });

  it("permission_request dedupes by requestId even across distinct events (not just distinct seq)", () => {
    const st = feed(initialState, [
      ev("a1", "permission_request", { requestId: "dup", toolName: "Bash", input: {}, policy: "tui" }),
      ev("a1", "permission_request", { requestId: "dup", toolName: "Bash", input: {}, policy: "tui" }),
    ]);
    expect(st.pendingPermissions.length).toBe(1);
  });

  it("turn_complete with a missing/non-numeric turnCostUsd leaves costUsd unchanged", () => {
    const st = feed(initialState, [ev("a1", "turn_complete", {})]);
    expect(st.agents["a1"]!.costUsd).toBe(0);
  });

  it("result with a missing costUsd/text keeps the prior cost and adds no transcript line", () => {
    const st = feed(initialState, [
      ev("a1", "turn_complete", { turnCostUsd: 0.5 }),
      ev("a1", "result", {}),
    ]);
    expect(st.agents["a1"]!.costUsd).toBe(0.5); // untouched by the costUsd-less result
    expect(st.agents["a1"]!.transcript).toMatchObject([]); // empty result text -> no "result: " noise line
  });

  it("result does NOT re-echo the answer already shown by message_complete (dedup)", () => {
    const st = feed(initialState, [
      ev("a1", "message_complete", { text: "İyiyim, teşekkürler!" }),
      ev("a1", "result", { text: "İyiyim, teşekkürler!", costUsd: 0.09 }),
    ]);
    // exactly one assistant line — no duplicate "result: …" system line
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "assistant", text: "İyiyim, teşekkürler!", streaming: false },
    ]);
    expect(st.agents["a1"]!.state).toBe("done");
    expect(st.agents["a1"]!.costUsd).toBe(0.09);
  });

  it("result DOES surface its text when no assistant turn rendered it (tool-only turn)", () => {
    const st = feed(initialState, [ev("a1", "result", { text: "tool-only outcome" })]);
    expect(st.agents["a1"]!.transcript.at(-1)).toMatchObject({ role: "system", text: "result: tool-only outcome" });
  });

  it("error with a missing message renders an empty error line", () => {
    const st = feed(initialState, [ev("a1", "error", {})]);
    expect(st.agents["a1"]!.transcript.at(-1)).toMatchObject({ role: "system", text: "error: " });
  });

  it("pendingPermissions also clears on 'error' (not only on 'result')", () => {
    const st = feed(initialState, [
      ev("a1", "permission_request", { requestId: "r9", toolName: "Bash", input: {}, policy: "tui" }),
    ]);
    const st2 = feed(st, [ev("a1", "error", { message: "boom" })]);
    expect(st2.pendingPermissions).toEqual([]);
  });

  it("status denied with a missing toolName defaults to '?'", () => {
    const st = feed(initialState, [ev("a1", "status", { denied: true })]);
    expect(st.agents["a1"]!.tools).toEqual([{ ts: expect.any(Number), toolName: "?", status: "denied" }]);
    expect(st.agents["a1"]!.transcript.at(-1)).toMatchObject({ role: "tool", toolName: "?", status: "denied" });
  });

  it("permissionResolved with a non-string requestId is guarded off — no clearing occurs", () => {
    const st = feed(initialState, [
      ev("a1", "permission_request", { requestId: "r5", toolName: "Bash", input: {}, policy: "tui" }),
    ]);
    const st2 = feed(st, [ev("a1", "status", { permissionResolved: true, allow: false })]); // requestId omitted
    expect(st2.pendingPermissions.length).toBe(1); // untouched: typeof requestId !== "string"
  });

  it("a status event with none of the recognized sub-fields is a harmless no-op on transcript/tools/state", () => {
    const st = feed(initialState, [ev("a5", "status", { somethingUnrelated: true })]);
    expect(st.agents["a5"]!.state).toBe("unknown");
    expect(st.agents["a5"]!.transcript).toMatchObject([]);
    expect(st.agents["a5"]!.tools).toMatchObject([]);
    expect(st.agentOrder).toMatchObject(["a5"]);
  });

  it("a single status event applies ALL matching independent effects at once (denied + interrupted together)", () => {
    const st = feed(initialState, [ev("a1", "status", { denied: true, toolName: "Bash", state: "interrupted" })]);
    expect(st.agents["a1"]!.state).toBe("failed");
    expect(st.agents["a1"]!.tools).toEqual([{ ts: expect.any(Number), toolName: "Bash", status: "denied" }]);
    expect(st.agents["a1"]!.transcript).toMatchObject([{ role: "tool", toolName: "Bash", status: "denied" }]);
  });

  it("selectedAgentId stays pinned to the FIRST agent seen even once a second agent appears", () => {
    const st = feed(initialState, [
      ev("a1", "agent_started", {}),
      ev("a2", "agent_started", {}),
    ]);
    expect(st.selectedAgentId).toBe("a1");
    expect(st.agentOrder).toEqual(["a1", "a2"]);
  });

  it("agentOrder never records the same agent twice across repeated events", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "a" }),
      ev("a1", "message_delta", { text: "b" }),
      ev("a1", "tool_call", { toolName: "Read" }),
    ]);
    expect(st.agentOrder).toEqual(["a1"]);
  });

  it("qualifiedAgentId: an empty-string engineId is falsy and is treated as local (bare id)", () => {
    expect(qualifiedAgentId({ agentId: "a1", engineId: "" })).toBe("a1");
  });

  it("emptyAgent seeds pendingQuestion as null for a freshly-created agent", () => {
    const st = feed(initialState, [ev("a1", "agent_started", {})]);
    expect(st.agents["a1"]!.pendingQuestion).toBeNull();
  });

  it("agent_question projects the full spec §17.2 shape into pendingQuestion", () => {
    const e = ev("a1", "agent_question", {
      questionId: "q1", prompt: "ship it?", header: "Confirm",
      options: [{ id: "go", label: "Go" }, { id: "stop", label: "Stop", description: "abort" }],
      multiSelect: false, freeform: false,
    });
    const st = feed(initialState, [e]);
    expect(st.agents["a1"]!.pendingQuestion).toEqual({
      questionId: "q1", prompt: "ship it?", header: "Confirm",
      options: [{ id: "go", label: "Go" }, { id: "stop", label: "Stop", description: "abort" }],
      multiSelect: false, freeform: false, ts: e.ts,
    });
  });

  it("agent_question with only the required fields omits header/options and defaults multiSelect/freeform to false", () => {
    const e = ev("a1", "agent_question", { questionId: "q2", prompt: "free text?" });
    const st = feed(initialState, [e]);
    expect(st.agents["a1"]!.pendingQuestion).toEqual({
      questionId: "q2", prompt: "free text?", multiSelect: false, freeform: false, ts: e.ts,
    });
    expect(st.agents["a1"]!.pendingQuestion).not.toHaveProperty("header");
    expect(st.agents["a1"]!.pendingQuestion).not.toHaveProperty("options");
  });

  it("a second agent_question for the same agent REPLACES the pending one (clearing is finished in T6)", () => {
    // NOTE: ev()'s seq is assigned in CALL order, which must match array order here
    // (the reducer dedupes on seq <= lastSeq) — so build the array first, then read
    // the second event's stamped `ts` back off it, rather than pre-binding it to a
    // variable (which would call ev() out of order).
    const events = [
      ev("a1", "agent_question", { questionId: "q1", prompt: "first?" }),
      ev("a1", "agent_question", { questionId: "q2", prompt: "second?" }),
    ];
    const st = feed(initialState, events);
    expect(st.agents["a1"]!.pendingQuestion).toEqual({ questionId: "q2", prompt: "second?", multiSelect: false, freeform: false, ts: events[1]!.ts });
  });

  // ASK-UNREACHABLE-TARGET-LEAK: an inter-agent ask_agent/ask_team question carries `to`
  // on the wire event — projected onto pendingQuestion so firstPendingQuestion/visibleQuestion
  // can exclude it from the human-facing card while still lighting the per-agent "?" indicator.
  it("agent_question with `to` projects it onto pendingQuestion; omitted entirely for an ask_human question", () => {
    const e1 = ev("a1", "agent_question", { questionId: "q1", prompt: "pick one", to: "b1", replyTo: "a1" });
    const st = feed(initialState, [e1]);
    expect(st.agents["a1"]!.pendingQuestion).toEqual({ questionId: "q1", prompt: "pick one", multiSelect: false, freeform: false, to: "b1", ts: e1.ts });

    const st2 = feed(initialState, [ev("a1", "agent_question", { questionId: "q2", prompt: "ask the human" })]);
    expect(st2.agents["a1"]!.pendingQuestion).not.toHaveProperty("to");
  });
});

// ---------------------------------------------------------------------------
// HOOK-6: lifecycle-hook event folding — hook_fired/hook_suppressed carry the
// synthetic "hooks" agentId and fold into state.hooks (per-rule status the HooksCard
// reads); signal_delivered rides the REAL subscriber agentId.
// ---------------------------------------------------------------------------

describe("reducer: hook event folding (HOOK-6)", () => {
  it("hook_fired folds lastFired + fireCount and never creates a phantom 'hooks' agent", () => {
    const e = ev("hooks", "hook_fired", { rule: "on-fail", eventSeq: 7, actions: [] });
    const st = feed(initialState, [e]);
    expect(st.hooks["on-fail"]).toEqual({ lastFired: e.ts, fireCount: 1, suppressCount: 0 });
    // system-namespace, exactly like config/network — no agent row, no auto-select
    expect(st.agents["hooks"]).toBeUndefined();
    expect(st.agentOrder).not.toContain("hooks");
    expect(st.selectedAgentId).not.toBe("hooks");
    // still visible in the global feed (Events tab)
    expect(st.events.map((x) => x.kind)).toEqual(["hook_fired"]);
  });

  it("hook_suppressed folds lastSuppressed + reason + suppressCount", () => {
    const e = ev("hooks", "hook_suppressed", { rule: "loopy", reason: "rate-limit", eventSeq: 9 });
    const st = feed(initialState, [e]);
    expect(st.hooks["loopy"]).toEqual({
      lastSuppressed: e.ts, suppressCount: 1, fireCount: 0, lastSuppressReason: "rate-limit",
    });
  });

  it("repeated fires/suppressions for one rule accumulate onto the same entry", () => {
    const events = [
      ev("hooks", "hook_fired", { rule: "r" }),
      ev("hooks", "hook_fired", { rule: "r" }),
      ev("hooks", "hook_suppressed", { rule: "r", reason: "self-cause" }),
    ];
    const st = feed(initialState, events);
    expect(st.hooks["r"]).toEqual({
      lastFired: events[1]!.ts, fireCount: 2,
      lastSuppressed: events[2]!.ts, suppressCount: 1, lastSuppressReason: "self-cause",
    });
  });

  it("a hook event without a rule name is a harmless no-op on state.hooks", () => {
    const st = feed(initialState, [ev("hooks", "hook_fired", {})]);
    expect(st.hooks).toEqual({});
    expect(st.events.length).toBe(1); // still in the feed
  });

  it("signal_delivered rides the REAL subscriber agentId (that agent's feed, not state.hooks)", () => {
    const st = feed(initialState, [ev("a1", "signal_delivered", { subscriptionId: "s1", topic: "task.state", eventSeq: 3 })]);
    expect(st.hooks).toEqual({});
    // a real agentId → the per-agent branch materializes the agent row + keeps the event
    expect(st.agentOrder).toContain("a1");
    expect(st.events.at(-1)!.kind).toBe("signal_delivered");
  });
});

// ---------------------------------------------------------------------------
// TUI-008 (MAJOR): per-agent transcript/tools arrays must be bounded (mirrors the
// global `events` ring buffer's own EVENT_BUFFER_MAX cap) -- unlike `events`, these
// were previously cloned in full and grown without bound on every event.
// ---------------------------------------------------------------------------

describe("reducer: per-agent transcript/tools bounded growth (TUI-008)", () => {
  it("feeding >TRANSCRIPT_BUFFER_MAX message_complete events to one agent caps transcript length at the cap, dropping the oldest and keeping the newest", () => {
    const many = Array.from({ length: TRANSCRIPT_BUFFER_MAX + 50 }, (_, i) => ev("a1", "message_complete", { text: `m${i}` }, 1 + i));
    const st = feed(initialState, many);
    expect(st.agents["a1"]!.transcript.length).toBe(TRANSCRIPT_BUFFER_MAX);
    // oldest 50 dropped -> the first surviving item is m50, the last is the newest, m(N+49)
    expect(st.agents["a1"]!.transcript[0]).toMatchObject({ role: "assistant", text: "m50", streaming: false });
    expect(st.agents["a1"]!.transcript.at(-1)).toMatchObject({ role: "assistant", text: `m${TRANSCRIPT_BUFFER_MAX + 49}`, streaming: false });
  });

  it("caps at exactly TRANSCRIPT_BUFFER_MAX with no drops at the exact boundary (off-by-one guard)", () => {
    const exact = Array.from({ length: TRANSCRIPT_BUFFER_MAX }, (_, i) => ev("a1", "message_complete", { text: `m${i}` }, 1 + i));
    const st = feed(initialState, exact);
    expect(st.agents["a1"]!.transcript.length).toBe(TRANSCRIPT_BUFFER_MAX);
    expect(st.agents["a1"]!.transcript[0]).toMatchObject({ role: "assistant", text: "m0", streaming: false }); // first NOT dropped yet
  });

  it("feeding >TOOLS_BUFFER_MAX tool_call events to one agent caps the tools log at the cap, keeping the newest", () => {
    const many = Array.from({ length: TOOLS_BUFFER_MAX + 25 }, (_, i) => ev("a1", "tool_call", { toolName: `t${i}` }, 1 + i));
    const st = feed(initialState, many);
    expect(st.agents["a1"]!.tools.length).toBe(TOOLS_BUFFER_MAX);
    expect(st.agents["a1"]!.tools[0]!.toolName).toBe("t25");
    expect(st.agents["a1"]!.tools.at(-1)!.toolName).toBe(`t${TOOLS_BUFFER_MAX + 24}`);
    // the tool transcript items are capped by TRANSCRIPT_BUFFER_MAX, a much larger
    // cap than TOOLS_BUFFER_MAX, so with only TOOLS_BUFFER_MAX+25 events the
    // transcript itself hasn't hit ITS OWN cap yet -- every tool_call produced one
    // transcript item, none dropped.
    expect(st.agents["a1"]!.transcript.length).toBe(TOOLS_BUFFER_MAX + 25);
  });

  it("a second agent's transcript/tools are entirely unaffected by the first agent's growth (per-agent, not global)", () => {
    const many = Array.from({ length: TRANSCRIPT_BUFFER_MAX + 10 }, (_, i) => ev("a1", "message_complete", { text: `m${i}` }, 1 + i));
    let st = feed(initialState, many);
    st = feed(st, [ev("a2", "message_complete", { text: "hello a2" }, TRANSCRIPT_BUFFER_MAX + 11)]);
    expect(st.agents["a1"]!.transcript.length).toBe(TRANSCRIPT_BUFFER_MAX);
    expect(st.agents["a2"]!.transcript).toMatchObject([{ role: "assistant", text: "hello a2", streaming: false }]);
  });
});

// The daemon books attempt deltas before publishing the durable agent total.
it("keeps the lifetime cost when a resumed attempt reports a smaller cost", () => {
  const state = feed(initialState, [
    ev("cost-agent", "turn_complete", { costUsd: 2, totalCostUsd: 42 }, 1),
    ev("cost-agent", "result", { costUsd: 2, totalCostUsd: 42 }, 2),
  ]);
  expect(state.agents["cost-agent"]!.costUsd).toBe(42);
});

it("keeps live session measurements when an older transcript page arrives", () => {
  const live = feed(initialState, [ev("fresh", "usage", {
    contextOnly: true,
    contextUsage: { input_tokens: 200, cached_input_tokens: 0 },
    sessionUsage: { input_tokens: 500, cached_input_tokens: 0 },
  }, 10)]);
  const state = reduce(live, { type: "backfillHistory", agentId: "fresh", events: [ev("fresh", "usage", {
    contextOnly: true,
    contextUsage: { input_tokens: 10, cached_input_tokens: 0 },
    sessionUsage: { input_tokens: 100, cached_input_tokens: 0 },
  }, 1)] });
  expect(state.agents.fresh!.ctxUsage?.input).toBe(200);
  expect(state.agents.fresh!.sessionUsage?.input).toBe(500);
});
