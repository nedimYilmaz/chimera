import type { ShellCommandRecord } from "@chimera/protocol/contract";
import { appStore } from "../../src/state/store";
import { composerLocal } from "../../src/state/commands.agents";
import { agentRecords } from "./ui-browser-data.mjs";

export const agentControlsFixture = {
  active: false,
  shells: {} as Record<string, ShellCommandRecord>,
  seq: 2000000,
  checkpointId: "12",
  failPermission: false,
  deferMode: false,
  failShellAck: false,
  failRemote: false,
  previousComposer: null as ReturnType<typeof composerLocal.getState> | null,
  records: [] as Record<string, unknown>[],
  calls: [] as { method: string; params: Record<string, unknown> }[],
  reset() {
    this.previousComposer = composerLocal.getState();
    composerLocal.reset();
    this.checkpointId = "12";
    this.calls = []; this.shells = {}; this.deferMode = false; this.failPermission = false; this.failShellAck = false; this.failRemote = false;
    this.records = ["controls-a", "controls-b"].map(agentId => ({ ...agentRecords[0], agentId, state: "running", actualModel: agentId === "controls-a" ? "gpt-6-astra" : undefined, spec: { cwd: "/synthetic/checkpoint-repo", displayLabel: agentId, persistent: true, model: "gpt-6.1-sol", effort: agentId === "controls-a" ? "high" : "low", permissionProfile: "full" } }));
    appStore.dispatch({ type: "connected", connected: true });
    appStore.dispatch({ type: "selectTab", tab: "agents" });
    this.publish();
    this.select("controls-a");
    composerLocal.set({ composeText: "Retained draft", target: "selected", agentDetail: null, spawnOpen: false });
  },
  claude() { this.provider("claude"); },
  provider(provider: string) {
    this.records = this.records.map(r => ({ ...r, provider, executionMode: "auto", executionModePending: false, spec: { ...(r.spec as object), executionMode: "auto" } }));
    this.publish();
  },
  restore() {
    if (this.previousComposer) composerLocal.set(this.previousComposer);
    this.previousComposer = null;
  },
  publish() { appStore.dispatch({ type: "agentRecords", records: this.records as never }); },
  select(agentId: string) { appStore.dispatch({ type: "selectAgent", agentId }); },
  connected(connected: boolean) { appStore.dispatch({ type: "connected", connected }); },
  draft(text: string) { composerLocal.set({ composeText: text }); },
  stall() {
    appStore.dispatch({ type: "userSent", agentId: "controls-a", text: "synthetic resend" });
    const promptStall = { deliveryId: "synthetic-stall", from: "conductor", sinceTs: Date.now() - 55000, sinceMs: 55000, text: "synthetic resend" };
    this.records = this.records.map(r => r.agentId === "controls-a" ? { ...r, promptStall, promptStalled: true } : r);
    appStore.dispatch({ type: "event", event: { seq: this.seq++, ts: Date.now(), agentId: "controls-a", kind: "agent_prompt_stalled", data: promptStall } });
  },
  turn(complete = false, steering = false) {
    appStore.dispatch({ type: "event", event: { seq: this.seq++, ts: Date.now(), agentId: "controls-a", kind: complete ? "turn_complete" : "tool_call", data: complete ? { interrupted: steering, steering } : { toolName: "synthetic_work", toolUseId: `work-${this.seq}`, input: {} } } });
  },
  context(percent: number) {
    appStore.dispatch({ type: "event", event: { seq: this.seq++, ts: Date.now(), agentId: "controls-a", kind: "usage", data: {
      contextOnly: true, contextUsage: { input_tokens: percent * 1000, output_tokens: 999999, cached_input_tokens: 1000 },
      effectiveContextLimit: 100000, contextLimits: { source: "codex", sessionWindow: 100000 },
    } } });
  },
  compaction(active: boolean) {
    appStore.dispatch({ type: "event", event: { seq: this.seq++, ts: Date.now(), agentId: "controls-a", kind: "compaction", data: { phase: active ? "start" : "end" } } });
  },
  remote(enabled: boolean, connectionStatus: "connected" | "errored" | "disabled") {
    appStore.dispatch({ type: "event", event: { seq: this.seq++, ts: Date.now(), agentId: "controls-a", kind: "status", data: { remoteControl: { enabled, connectionStatus } } } });
  },
  finishShell(agentId: string) {
    const record = this.shells[agentId];
    if (!record) return;
    record.state = "done"; record.exitCode = 0; record.output = "synthetic Bash output\n";
    appStore.dispatch({ type: "event", event: { seq: this.seq++, ts: Date.now(), agentId, kind: "tool_result", data: { toolName: "operator_shell", toolUseId: record.requestId, result: record.output, operatorInitiated: true } } });
  },
  checkpoint(id: string) {
    this.checkpointId = id;
    appStore.dispatch({ type: "event", event: { seq: this.seq++, ts: Date.now(), agentId: "controls-a", kind: "checkpoint_created", data: { id } } });
  },
  rpc(method: string, params: Record<string, unknown>) {
    const checkpoint = { id: this.checkpointId, ref: `refs/chimera/checkpoints/${this.checkpointId}`, sha: "synthetic-sha", cwd: "/synthetic/checkpoint-repo", ts: 1000, trigger: "manual" };
    if (method === "checkpoint.status") return { supported: true, count: 1, latest: checkpoint };
    if (method === "checkpoint.list") return [checkpoint];
    if (method === "events.search") {
      this.calls.push({ method, params });
      return { hits: [], nextCursor: null };
    }
    if (method === "agent.send") { this.calls.push({ method, params }); return {}; }
    if (method === "agent.list") return this.records;
    if (method === "agent.reconfigure") {
      this.calls.push({ method, params });
      if (this.failPermission) throw new Error("Synthetic provider policy refused the change");
      const mode = (params.live as { executionMode?: string }).executionMode;
      this.records = this.records.map(r => r.agentId === params.agentId ? { ...r, ...(mode ? { ...(this.deferMode ? {} : { executionMode: mode }), executionModePending: this.deferMode } : {}), spec: { ...(r.spec as object), ...(params.live as object) } } : r);
      return { applied: [mode ? "executionMode" : "permission"], respawned: false, executionModePending: this.deferMode };
    }
    if (method === "agent.shellStatus") return this.shells[String(params.agentId)] ?? null;
    if (method === "agent.shellStart") {
      this.calls.push({ method, params });
      const agentId = String(params.agentId), requestId = String(params.requestId);
      const existing = this.shells[agentId];
      if (existing?.requestId === requestId) return existing;
      const record: ShellCommandRecord = { agentId, requestId, command: String(params.command), cwd: "/synthetic/agent-cwd", state: "running", output: "", exitCode: null, truncated: false, startedAt: Date.now() };
      this.shells[agentId] = record;
      appStore.dispatch({ type: "event", event: { seq: this.seq++, ts: Date.now(), agentId, kind: "tool_call", data: { toolName: "operator_shell", toolUseId: requestId, operatorInitiated: true, input: { command: record.command } } } });
      if (this.failShellAck) throw new Error("Synthetic lost acknowledgement");
      return record;
    }
    if (method === "agent.shellCancel") {
      this.calls.push({ method, params });
      const record = this.shells[String(params.agentId)];
      this.finishShell(String(params.agentId));
      if (record) record.state = "cancelled";
      return record;
    }
    if (method === "agent.hold" || method === "agent.release") {
      this.calls.push({ method, params });
      const ids = params.agentIds as string[];
      this.records = this.records.map(r => ids.includes(String(r.agentId)) ? { ...r, state: method === "agent.hold" ? "paused" : "running", pauseReason: method === "agent.hold" ? "operator-hold" : undefined } : r);
      return method === "agent.hold" ? { held: ids, skipped: [] } : { released: ids, skipped: [] };
    }
    if (method === "agent.remoteControl") {
      this.calls.push({ method, params });
      if (this.failRemote) throw new Error("Synthetic remote failure");
      const enabled = params.enable === true;
      appStore.dispatch({ type: "event", event: { seq: this.seq++, ts: Date.now(), agentId: String(params.agentId), kind: "status", data: { remoteControl: { enabled, connectionStatus: enabled ? "connected" : "disabled" } } } });
      return { enabled, connectionStatus: enabled ? "connected" : "disabled" };
    }
    if (method === "agent.compact") {
      this.calls.push({ method, params });
      this.compaction(true);
      return { ok: true, message: "Synthetic compaction started" };
    }
    if (method === "agent.status") return this.records.find(r => r.agentId === params.agentId);
    return undefined;
  },
  snapshot() { return { calls: this.calls, outbox: appStore.getState().outbox, draft: composerLocal.getState().composeText, selected: appStore.getState().selectedAgentId }; },
};
