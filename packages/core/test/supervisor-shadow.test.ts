import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { UnknownAgentError } from "@chimera/core/supervisor";
import { makeSupervisor } from "./helpers.js";

// Task N-SHADOW: native Task/Agent-tool sub-agents (and workflow tasks) surface
// as LIVE, nested "shadow" rows via daemon-side synthetic records. The claude
// backend maps the SDK's task lifecycle into an `agent_task` BackendEvent (see
// claude.ts); the supervisor folds that into a shadow record kept in a SEPARATE
// map from this.agents, returned alongside real agents from list() so the TUI's
// existing treeOrder/AgentList nesting renders it beneath its parent.

// Wait a macrotask so the fake backend's deferred step loop (setTimeout(run,0))
// reaches the point we want to observe (it holds at an awaitSend step).
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("AgentSupervisor: native sub-agent shadow rows (Task N-SHADOW)", () => {
  it("surfaces a native task as a nested, running shadow row in list()", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "T1", toolUseId: "tu_a", subagentType: "code-reviewer" } },
      { awaitSend: true },                          // park so we can observe the RUNNING shadow
      { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();

    const shadow = sup.list().find((a) => a.shadow);
    expect(shadow).toBeDefined();
    // id keys on taskId (task_updated can drop the toolUseId), parented under the caller.
    expect(shadow!.agentId).toBe(`shadow:${parent.agentId}:T1`);
    expect(shadow!.treeId).toBe(parent.treeId);        // same tree -> treeOrder nests it under the parent
    expect(shadow!.depth).toBe(parent.depth + 1);      // one level deeper -> AgentList indents it
    expect(shadow!.label).toBe("code-reviewer");       // friendly label, not the raw id
    expect(shadow!.state).toBe("running");
    expect(shadow!.accountName).toBe(parent.accountName);
    expect(shadow!.provider).toBe(parent.provider);
    expect(shadow!.costUsd).toBe(0);
  });

  it("does NOT synthesize a shadow for a local_bash task (the agent's own shell gate runs)", async () => {
    // Task SHADOW-FILTER: the SDK emits agent_task for backgrounded local bash
    // (taskType "local_bash") — those are the agent's OWN tool executions, not
    // sub-agents, so they must never appear as nested shadow rows.
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "B1", taskType: "local_bash", description: "cd /x && npx vitest run" } },
      { task: { taskId: "T1", subagentType: "reviewer" } },   // a REAL sub-agent alongside it
      { awaitSend: true },
      { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();

    const shadows = sup.list().filter((a) => a.shadow);
    expect(shadows).toHaveLength(1);                                    // only the real sub-agent, not the bash run
    expect(shadows[0]!.agentId).toBe(`shadow:${parent.agentId}:T1`);
    expect(shadows.some((s) => s.agentId.endsWith(":B1"))).toBe(false); // local_bash dropped
  });

  it("marks the shadow terminal from a task_updated, keyed on taskId even when toolUseId is dropped", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "W1", toolUseId: "tu_b", workflowName: "build" } },   // task_started (running)
      { task: { taskId: "W1", status: "completed" } },                        // task_updated (no toolUseId)
      { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(parent.agentId, 1000);

    const shadows = sup.list().filter((a) => a.shadow);
    expect(shadows).toHaveLength(1);                   // the second event UPDATED, not duplicated
    expect(shadows[0]!.agentId).toBe(`shadow:${parent.agentId}:W1`);
    expect(shadows[0]!.label).toBe("build");           // workflowName label survives the status-only update
    expect(shadows[0]!.state).toBe("done");            // completed -> done
  });

  it("evicts a still-running shadow to terminal when the parent finishes without a terminal task_updated", async () => {
    // The SDK does not always emit a terminal task_updated; the parent's own
    // `result` must sweep the lingering shadow so it never sticks at 'running'.
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "N1", subagentType: "worker" } },   // running, never updated to a terminal status
      { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(parent.agentId, 1000);

    const shadow = sup.list().find((a) => a.shadow);
    expect(shadow!.state).toBe("done");               // swept terminal by the parent's result (not left 'running')
  });

  it("evicts a still-running shadow to killed when the parent is killed", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "K1", subagentType: "worker" } },
      { awaitSend: true },                              // hold the parent (and its shadow) running
      { end: { resultText: "never" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();
    expect(sup.list().find((a) => a.shadow)!.state).toBe("running");

    await sup.kill(parent.agentId);
    expect(sup.list().find((a) => a.shadow)!.state).toBe("killed");
  });

  // LINEAGE (shadow-live-state's remainder): the shadow-directed agent_task re-emit under the
  // shadow's OWN agentId (used by an event-only client with no agent.list poll, e.g. the
  // desktop app) now also carries parentId/treeId/depth/projectId/membership, matching the
  // snapshot record's own lineage exactly -- without this an event-only client had no way to
  // learn the shadow's lineage and the row rendered detached at the top level instead of
  // nested under its parent.
  describe("LINEAGE: the shadow-directed agent_task re-emit carries parentId/treeId/depth/projectId", () => {
    it("upsertShadow's shadow-directed event carries the same lineage as the snapshot record", async () => {
      const scenario: FakeStep[] = [
        { emit: { kind: "agent_started", data: {} } },
        { task: { taskId: "T1", toolUseId: "tu_a", subagentType: "code-reviewer" } },
        { awaitSend: true },
        { end: { resultText: "ok" } },
      ];
      const { sup, events } = makeSupervisor([scenario]);
      const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
      await tick();

      const shadow = sup.list().find((a) => a.shadow)!;
      const shadowEvents = events.tail(shadow.agentId, 50).filter((e) => e.kind === "agent_task");
      expect(shadowEvents.length).toBeGreaterThan(0);
      const last = shadowEvents[shadowEvents.length - 1]!;
      expect(last.data["parentId"]).toBe(parent.agentId);
      expect(last.data["treeId"]).toBe(shadow.treeId);
      expect(last.data["depth"]).toBe(shadow.depth);
      expect(last.data["projectId"]).toBe(shadow.projectId ?? null);
      // SHADOW-NESTING-UI: the owner rides along too, so an event-only client can bump the
      // shadow's displayDepth the same way the poll-snapshot record does (nests under the worker).
      expect(last.data["originConductorId"]).toBe(shadow.originConductorId ?? null);

      // The PARENT-directed copy (feeds flowTree) must stay unchanged -- no lineage keys added.
      const parentEvents = events.tail(parent.agentId, 50).filter((e) => e.kind === "agent_task");
      expect(parentEvents.length).toBeGreaterThan(0);
      const parentLast = parentEvents[parentEvents.length - 1]!;
      expect(parentLast.data["parentId"]).toBeUndefined();
      expect(parentLast.data["treeId"]).toBeUndefined();
      expect(parentLast.data["depth"]).toBeUndefined();
    });

    it("terminateShadows' forced-terminal synthetic event also carries lineage (the parent-ended race: no earlier task_updated ever reached the wire)", async () => {
      const scenario: FakeStep[] = [
        { emit: { kind: "agent_started", data: {} } },
        { task: { taskId: "N1", subagentType: "worker" } },
        { end: { resultText: "ok" } },
      ];
      const { sup, events } = makeSupervisor([scenario]);
      const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
      await sup.waitFor(parent.agentId, 1000);

      const shadow = sup.list().find((a) => a.shadow)!;
      expect(shadow.state).toBe("done");
      const shadowEvents = events.tail(shadow.agentId, 50).filter((e) => e.kind === "agent_task");
      const last = shadowEvents[shadowEvents.length - 1]!;
      expect(last.data["status"]).toBe("completed");
      expect(last.data["parentId"]).toBe(parent.agentId);
      expect(last.data["treeId"]).toBe(shadow.treeId);
      expect(last.data["depth"]).toBe(shadow.depth);
    });
  });

  it("does not count a shadow against spawn guardrails (it lives outside this.agents)", async () => {
    // helpers CFG: maxAgentsTotal=2. The shadow must not occupy a slot, so a
    // SECOND real spawn still fits even while a shadow is live.
    const withTask: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "S1", subagentType: "rev" } },
      { awaitSend: true }, { end: { resultText: "-" } },
    ];
    const parked: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "-" } }];
    const { sup } = makeSupervisor([withTask, parked]);
    await sup.spawn({ prompt: "1", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();
    expect(sup.list().some((a) => a.shadow)).toBe(true);

    const p2 = await sup.spawn({ prompt: "2", cwd: "/tmp", account: "second", isolation: "none" });
    expect(p2.state).toBe("running");                 // shadow did NOT consume the maxAgentsTotal=2 budget
    expect(sup.list().filter((a) => !a.shadow)).toHaveLength(2);
    expect(sup.list().filter((a) => a.shadow)).toHaveLength(1);
  });

  it("status()/result() resolve a shadow id instead of throwing (selected-row actions stay safe)", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "R1", subagentType: "rev" } },
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();
    const shadowId = `shadow:${parent.agentId}:R1`;

    expect(sup.status(shadowId).agentId).toBe(shadowId);
    expect(sup.result(shadowId)).toEqual({ state: "running", text: undefined, costUsd: 0 });
    // a genuinely unknown id still throws
    expect(() => sup.status("shadow:nope:X")).toThrow(UnknownAgentError);
  });

  it("kill() on a selected shadow id marks that shadow killed without throwing", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "KS1", subagentType: "rev" } },
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();
    const shadowId = `shadow:${parent.agentId}:KS1`;
    await expect(sup.kill(shadowId)).resolves.toBeTypeOf("boolean");   // no live handle -> no throw
    expect(sup.status(shadowId).state).toBe("killed");
  });

  it("maps a killed task_updated to the terminal 'killed' state, and a later parent-done sweep never overwrites it", async () => {
    // Regression: 'killed' is a first-class terminal AgentState (and a real SDK
    // task status). It must NOT fall through to 'running' (which would leave the
    // sub-agent live forever) nor be flipped to 'done' by terminateShadows.
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "X1", subagentType: "qa" } },      // running
      { task: { taskId: "X1", status: "killed" } },        // terminal: killed
      { awaitSend: true },                                  // hold the parent so the mapping isn't masked by a sweep
      { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();
    expect(sup.list().find((a) => a.shadow)!.state).toBe("killed");   // not "running"

    await sup.send(parent.agentId, "go");                  // unblock -> parent result -> terminateShadows("done")
    await sup.waitFor(parent.agentId, 1000);
    expect(sup.list().find((a) => a.shadow)!.state).toBe("killed");   // the done-sweep left the killed shadow alone
  });

  it("a later description-only progress update does not downgrade an established subagentType label", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "L1", subagentType: "qa", description: "review PR" } },   // strong label -> "qa"
      { task: { taskId: "L1", description: "analyzing files" } },                 // weak-only update
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();
    expect(sup.list().find((a) => a.shadow)!.label).toBe("qa");       // NOT "analyzing files"
    void parent;
  });

  it("ignores an agent_task with an empty-string taskId (no shadow row, no collision)", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "", subagentType: "ghost" } },     // "" is a string but not a usable dedup key
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();
    expect(sup.list().some((a) => a.shadow)).toBe(false);
  });

  it("stores shadowInfo from the first agent_task and REFRESHES it across task_started -> task_progress -> task_updated", async () => {
    // Task SHADOW-ACT: the rich per-task progress claude.ts forwards must land on the
    // shadow record and update on every subsequent agent_task, last-known-value-wins
    // per field (a later event carrying only SOME fields never wipes the others).
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      // task_started: description + first metrics, no tool yet
      { task: { taskId: "A1", subagentType: "reviewer", description: "review the diff", usage: { totalTokens: 100, toolUses: 1 } } },
      // task_progress: last tool + growing metrics, NO description (must not wipe it)
      { task: { taskId: "A1", lastToolName: "Read", usage: { totalTokens: 250, toolUses: 3, durationMs: 4200 } } },
      // task_updated terminal: summary + failed status + error
      { task: { taskId: "A1", status: "failed", summary: "found 2 bugs", error: "boom" } },
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();

    const shadow = sup.list().find((a) => a.shadow)!;
    expect(shadow.state).toBe("failed");
    expect(shadow.shadowInfo).toEqual({
      // R2 (inline sub-agent/workflow surfacing): subagentType is now captured into
      // shadowInfo too (alongside the flattened `label`), so the UI can tell a
      // sub-agent card from an attached-workflow view apart.
      subagentType: "reviewer",
      description: "review the diff",   // survived the description-less progress update
      lastToolName: "Read",             // from task_progress
      summary: "found 2 bugs",          // from the terminal update
      totalTokens: 250,                 // refreshed to the latest
      toolUses: 3,
      durationMs: 4200,
      error: "boom",
    });
  });

  // TASK-SHADOW-GHOST: a task that never says it is a sub-agent or a workflow gets NO row. It used
  // to get one labelled with the raw task id and no shadowInfo — a permanently empty row you could
  // select but never read anything in.
  it("creates NO shadow row for a task carrying no sub-agent identity", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "B1" } },
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();
    expect(sup.list().find((a) => a.shadow)).toBeUndefined();
  });

  it("keeps a backgrounded Bash task out of the tree on its COMPLETION event, not just its start", async () => {
    // The bug this whole gate exists for. The SDK stamps a task's identity only on task_started:
    // the completion event is bare (task_id + status). The old stateless `taskType === "local_bash"`
    // check therefore passed it through, and a ghost row appeared at the moment the work FINISHED.
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "bg1", taskType: "local_bash", description: "Wait and check scan progress", status: "running" } },
      { task: { taskId: "bg1", status: "completed" } },      // no taskType, no description — as the SDK sends it
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();
    expect(sup.list().find((a) => a.shadow)).toBeUndefined();
  });

  it("still lets a REAL sub-agent reach its terminal state on that same bare update", async () => {
    // The gate must read "no identity AND no row yet", not "no identity". A real sub-agent's
    // completion event is just as bare as the backgrounded script's — gating updates on identity
    // too would freeze every shadow at "running" forever.
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "R1", subagentType: "code-reviewer", status: "running" } },
      { task: { taskId: "R1", status: "completed" } },
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();
    const shadow = sup.list().find((a) => a.shadow)!;
    expect(shadow.label).toBe("code-reviewer");
    expect(shadow.state).toBe("done");
  });

  it("sanitizes newlines/control chars out of shadowInfo fields (activity panel + terminal stay safe)", async () => {
    // Task SHADOW-ACT: lastToolName rides a single-line panel row and an ANSI escape
    // in any field could corrupt the terminal — every free-text field is sanitized,
    // mirroring the row-label rule.
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "C1", subagentType: "rev", description: "review\nthe\tdiff", lastToolName: "Re\nad", summary: "line1\nline2", error: "bad\tthing" } },
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();
    const info = sup.list().find((a) => a.shadow)!.shadowInfo!;
    expect(info.description).toBe("review the diff");
    expect(info.lastToolName).toBe("Re ad");
    expect(info.summary).toBe("line1 line2");
    expect(info.error).toBe("bad thing");
    for (const v of Object.values(info)) expect(String(v)).not.toMatch(/[\n\t]/);
  });

  it("a junk-only field update (sanitizes to empty) does not wipe a prior good value", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "J1", subagentType: "rev", description: "real description" } },
      { task: { taskId: "J1", description: "\n\t  " } },   // all-whitespace -> sanitizes to "" -> must NOT clobber
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();
    expect(sup.list().find((a) => a.shadow)!.shadowInfo!.description).toBe("real description");
  });

  it("keeps each shadow's shadowInfo isolated — a sibling task's progress never leaks across", async () => {
    // Two concurrent sub-agents under one parent: their activity must not cross-write.
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "S1", subagentType: "a", lastToolName: "Grep" } },
      { task: { taskId: "S2", subagentType: "b", lastToolName: "Bash" } },
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();
    const byId = (t: string) => sup.list().find((a) => a.agentId === `shadow:${parent.agentId}:${t}`)!;
    expect(byId("S1").shadowInfo).toEqual({ subagentType: "a", lastToolName: "Grep" });
    expect(byId("S2").shadowInfo).toEqual({ subagentType: "b", lastToolName: "Bash" });
  });

  it("sanitizes newlines/control chars out of the row label (shadow rows stay one physical line)", async () => {
    // AgentList windowing and click hit-testing both assume ONE physical row per agent, so a label
    // carrying a newline desyncs them. Asserted through subagentType because that (or workflowName)
    // is now the ONLY thing a label can be built from — a description can no longer become one.
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "S1", subagentType: "refactor\nauth\tmodule" } },
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();
    const label = sup.list().find((a) => a.shadow)!.label!;
    expect(label).toBe("refactor auth module");
    expect(label).not.toMatch(/[\n\t]/);
  });
});

// R2 (inline sub-agent/workflow surfacing): message_complete/tool_call/tool_result carrying a
// parentToolUseId (claude.ts threads it off the SDK's parent_tool_use_id, forwardSubagentText
// makes subagent text arrive at all) get re-emitted under the SHADOW's own agentId instead of the
// parent's — a real per-shadow transcript, served by the SAME agent.tail/events.replay machinery
// every other agent already uses (no daemon RPC change). Deterministic full-boot blackbox test:
// drives the supervisor through the real FakeAgentBackend event stream and asserts on the actual
// persisted EventLog per agentId — not internals.
describe("AgentSupervisor: routes subagent-tagged events into the shadow's own transcript (R2)", () => {
  it("routes message_complete/tool_call/tool_result carrying parentToolUseId into the shadow's event log, and keeps the parent's own log free of them", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "T1", toolUseId: "tu_a", subagentType: "code-reviewer" } },
      { emit: { kind: "message_complete", data: { text: "sub-agent says hi", parentToolUseId: "tu_a" } } },
      { emit: { kind: "tool_call", data: { toolName: "Read", parentToolUseId: "tu_a" } } },
      { emit: { kind: "tool_result", data: { result: "file contents", parentToolUseId: "tu_a" } } },
      { emit: { kind: "message_complete", data: { text: "parent's own turn" } } },   // no parentToolUseId
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();

    const shadowId = `shadow:${parent.agentId}:T1`;
    const shadowEvents = events.replay({ agentId: shadowId, fromSeq: 1, limit: 100 });
    // BUG shadow-live-state: upsertShadow now ALSO mirrors its own agent_task lifecycle event
    // under the shadow's id (leading entry here) so a live-only client can derive the row's
    // state/label without a snapshot — see supervisor.ts's upsertShadow/reducer.ts's
    // "agent_task" case. The R2 inner-turn routing under test here is otherwise unchanged.
    expect(shadowEvents.map((e) => e.kind)).toEqual(["agent_task", "message_complete", "tool_call", "tool_result"]);
    expect(shadowEvents[1]!.data["text"]).toBe("sub-agent says hi");
    expect(shadowEvents[2]!.data["toolName"]).toBe("Read");
    expect(shadowEvents[3]!.data["result"]).toBe("file contents");

    // The subagent's three events must NOT also leak into the parent's own log (the bug this
    // routing fixes — see claude.ts/supervisor.ts's R2 comments).
    const parentEvents = events.replay({ agentId: parent.agentId, fromSeq: 1, limit: 100 });
    // PROJECT-CONDUCTOR-VISIBILITY: spawn()'s leading registration status event now precedes
    // agent_started for every record.
    expect(parentEvents.map((e) => e.kind)).toEqual(["status", "agent_started", "agent_task", "message_complete"]);
    expect(parentEvents[3]!.data["text"]).toBe("parent's own turn");
  });

  it("captures subagentType (not workflowName) into shadowInfo for a plain sub-agent task", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "T2", toolUseId: "tu_b", subagentType: "code-reviewer" } },
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();

    const info = sup.list().find((a) => a.shadow)!.shadowInfo!;
    expect(info.subagentType).toBe("code-reviewer");
    expect(info.workflowName).toBeUndefined();
  });

  it("captures workflowName (not subagentType) into shadowInfo for an inline workflow task", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "T3", toolUseId: "tu_c", workflowName: "spec", taskType: "local_workflow" } },
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();

    const info = sup.list().find((a) => a.shadow)!.shadowInfo!;
    expect(info.workflowName).toBe("spec");
    expect(info.subagentType).toBeUndefined();
  });

  it("a skipTranscript task's inner messages are dropped — neither the shadow's log nor the parent's — but its own lifecycle event still lands (BUG shadow-live-state: a skipTranscript shadow still renders a row and needs its state/label too)", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "T4", toolUseId: "tu_hidden", subagentType: "housekeeping", skipTranscript: true } },
      { emit: { kind: "message_complete", data: { text: "should be hidden", parentToolUseId: "tu_hidden" } } },
      { emit: { kind: "tool_call", data: { toolName: "Bash", parentToolUseId: "tu_hidden" } } },
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();

    const shadowId = `shadow:${parent.agentId}:T4`;
    // skipTranscript only gates the INNER turn routing (message_complete/tool_call/tool_result
    // via subagentToolUseIndex) — the shadow's own agent_task lifecycle event is unaffected.
    expect(events.replay({ agentId: shadowId, fromSeq: 1, limit: 100 }).map((e) => e.kind)).toEqual(["agent_task"]);
    const parentEvents = events.replay({ agentId: parent.agentId, fromSeq: 1, limit: 100 });
    // PROJECT-CONDUCTOR-VISIBILITY: spawn()'s leading registration status event now precedes
    // agent_started for every record.
    expect(parentEvents.map((e) => e.kind)).toEqual(["status", "agent_started", "agent_task"]);   // no message_complete/tool_call leaked in
  });

  it("an unresolvable parentToolUseId (never indexed) is dropped, not leaked into the parent", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { emit: { kind: "message_complete", data: { text: "orphaned", parentToolUseId: "tu_never_seen" } } },
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    const parent = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await tick();

    const parentEvents = events.replay({ agentId: parent.agentId, fromSeq: 1, limit: 100 });
    // PROJECT-CONDUCTOR-VISIBILITY: spawn()'s leading registration status event now precedes
    // agent_started for every record.
    expect(parentEvents.map((e) => e.kind)).toEqual(["status", "agent_started"]);   // the orphaned message_complete never landed anywhere
  });
});
