import { existsSync, readFileSync } from "node:fs";
import { ATTENTION_EVENT_KINDS, ForkLineageSchema, type NormalizedEvent, type PermissionApplication } from "@chimera/protocol";
import type { AgentRecord } from "./supervisor.js";

// R2 (self-healing supervision): this file is the shared, reusable fold-from-log primitive —
// generalized out of reattach.ts's FEATURE-4 boot-recovery-only reducer (reconstructAgentsFromLog/
// applyEventToRecord moved here verbatim; reattach.ts re-imports them, so its own callers/tests
// are unaffected). Boot recovery (reattachFromState) folds an UNBOUNDED gap
// [lastSeq+1, currentSeq] onto the snapshot baseline before deciding what to reattach;
// replayAgentsAsOf below generalizes that same fold to an arbitrary bounded `toSeq`, for
// post-mortem/diagnostic use (the health.status/replay.agentsAsOf RPC) independent of any live
// reattach decision.

// FEATURE-4: fold events AFTER a (possibly stale) snapshot onto its `agents` list, in place.
// Pure/side-effect-free (no spawn, no event emission) — this is reconstruction of DATA the
// live supervisor already committed before the crash, not a re-simulation of the decisions
// that produced it. `events` must be in ascending seq order (EventLog.replay's fromSeq path
// guarantees this).
//
// An event for an agentId absent from `agents` is a no-op: that agent was created AND crashed
// before ever appearing in any durable snapshot. No event kind carries an AgentRecord's
// founding fields (spec/accountName/treeId/createdAt/principal/parentId/projectId — confirmed:
// agent_started's data only ever has sessionId/conductor/membership/model/tooling fields), so
// there is nothing here to reconstruct FROM. Pre-existing gap (identical under the old
// every-event-snapshot code, whose subscriber was exactly as event-driven), not introduced by
// this change.
export function reconstructAgentsFromLog(agents: AgentRecord[], events: NormalizedEvent[]): AgentRecord[] {
  const byId = new Map(agents.map((a) => [a.agentId, a]));
  for (const e of events) {
    const record = byId.get(e.agentId);
    if (record) applyEventToRecord(record, e);
  }
  return agents;
}

// FEATURE-4: mirrors the SUBSET of supervisor.ts's onEvent/onError state mutations that (a)
// are actually observable from the event log and (b) matter to reattachConductors' decision
// (state, sessionId, resumeAt). Deliberately excludes bare "error" events: onEvent's generic
// passthrough appends one unconditionally regardless of which of onError's three outcomes
// occurred (cross-account failover / session-limit HOLD / plain fail), so its mere presence
// does NOT mean "failed" — the failover/status event that actually reflects the real outcome
// is appended FIRST, in the same onEvent call, before the generic "error" passthrough. Treating
// bare "error" as authoritative would clobber a correct "running"/"paused" back to "failed".
function applyEventToRecord(record: AgentRecord, e: NormalizedEvent): void {
  // F47.QA2: attentionAt is stamped OUTSIDE the switch because bare "error" (an attention kind)
  // deliberately falls through to `default` above — the stamp is orthogonal to the state question
  // the switch answers, and skipping it would lose the row. `e.ts`, never Date.now(): this is
  // reconstruction of a fact already committed before the crash, so the ordering against a
  // reviewedAt from the same gap must be the one the live supervisor saw. Shadow rows are skipped
  // to mirror supervisor.noteAttention — markSeen cannot clear a shadow, so a stamp here would
  // strand it permanently unseen.
  if (record.shadow !== true && ATTENTION_EVENT_KINDS.has(e.kind)) record.attentionAt = e.ts;
  // A branch registration can land between snapshots; preserve its identity on recovery.
  if (e.kind === "agent_started" || e.kind === "status") {
    const lineage = ForkLineageSchema.safeParse(e.data["forkLineage"]);
    if (lineage.success) record.forkLineage = lineage.data;
  }
  switch (e.kind) {
    case "agent_started":
      record.state = "running";   // only ever fires from a live spawned/resumed handle
      if (typeof e.data["sessionId"] === "string") record.sessionId = e.data["sessionId"] as string;
      else if (record.provider === "codex" && (e.data["provider"] === undefined || e.data["provider"] === "codex") && typeof e.data["threadId"] === "string" && e.data["threadId"]) {
        // Legacy Codex events predate the threadId -> Chimera sessionId mapping.
        record.sessionId = e.data["threadId"];
      }
      // Match live supervision: startup alone does not prove a failing turn recovered.
      break;
    case "turn_complete":
      if (e.data["interrupted"] !== true) record.crashCount = 0;
      break;
    case "result": {
      record.crashCount = 0;
      record.state = "done";
      record.resultText = String(e.data["text"] ?? "");
      record.costUsd += Number(e.data["costUsd"] ?? 0);
      const att = record.attempts[record.attempts.length - 1];
      if (att) att.endedAt = e.ts;
      break;
    }
    case "failover":
      // Cross-account reroute keeps the agent running (supervisor.ts onError) — explicit so a
      // trailing bare "error" passthrough (appended right after, same onEvent call) can't
      // clobber this back to "failed".
      record.state = "running";
      break;
    case "status": {
      const application = e.data["permissionApplication"] as PermissionApplication | undefined;
      const current = application ? application.version >= (record.permissionApplication?.version ?? -1) : !record.permissionApplication;
      if (application && current) record.permissionApplication = application;
      if (e.data["permissionChanged"] === true && current) {
        const profile = e.data["permissionProfile"];
        const routing = e.data["permissionRequest"];
        if (profile === "readOnly" || profile === "acceptEdits" || profile === "full") record.spec = { ...record.spec, permissionProfile: profile };
        if (routing === "auto" || routing === "poke:caller" || routing === "tui") record.spec = { ...record.spec, on: { ...record.spec.on, permissionRequest: routing } };
      }
      if (record.provider === "codex" && typeof e.data["nativeVoiceEnabled"] === "boolean") {
        const enabled = e.data["nativeVoiceEnabled"];
        record.spec = { ...record.spec, ...(enabled ? { persistent: true } : {}), providerOptions: { ...record.spec.providerOptions, ...(enabled ? { codexTransport: "app-server" } : {}), codexRealtime: enabled } };
      }
      // F47.QA2: agent.markSeen's only durable trace is the status{state, reviewedAt} it emits per
      // agent, so a mark-seen that landed after the last snapshot is lost unless folded here.
      if (typeof e.data["reviewedAt"] === "number") record.reviewedAt = e.data["reviewedAt"] as number;
      const state = e.data["state"];
      if (state === "running") {
        record.state = "running";
        delete record.resumeAt;
      } else if (state === "paused") {
        record.state = "paused";
        if (typeof e.data["resumeScheduledAt"] === "number") record.resumeAt = e.data["resumeScheduledAt"] as number;
      } else if (state === "failed" || state === "killed") {
        record.state = state;
      }
      if (e.data["turnBudgetExceeded"] === true) record.turnBudgetExceeded = true;
      // R2: crashCount/circuitOpen ride the SAME status event crash-loop-backoff/circuit-breaker
      // transitions already use (holdUntilReset's reason:"session-limit" precedent) — no new
      // event kind needed for the fold to stay in sync with live state.
      if (typeof e.data["crashCount"] === "number") record.crashCount = e.data["crashCount"] as number;
      if (e.data["circuitOpen"] === true) record.circuitOpen = true;
      // STALE-WORKTREE-RECORD: rides its own "status" event (no `state` field, appended right
      // after kill()'s/reportUnresponsive()'s state-carrying one) the same way crashCount/
      // circuitOpen ride the circuit-breaker's — so a boot replay reconstructs it identically.
      if (typeof e.data["worktreeUnlanded"] === "boolean") record.worktreeUnlanded = e.data["worktreeUnlanded"] as boolean;
      if (typeof e.data["worktreeLandingCheckedAt"] === "number") record.worktreeLandingCheckedAt = e.data["worktreeLandingCheckedAt"] as number;
      // F09: the clearing half of the prompt-stall pair — rides a "status" event the same way
      // crashCount/worktreeUnlanded do, so a boot replay never resurrects a stall the agent
      // already answered.
      if (e.data["promptStallCleared"] === true) record.promptStall = null;
      break;
    }
    // F09: the stall itself is its own kind (it is a report an operator subscribes to), so the
    // fold reconstructs the advisory from the event data rather than from a status side-channel.
    case "agent_prompt_stalled": {
      record.promptStall = {
        deliveryId: String(e.data["deliveryId"] ?? ""),
        from: String(e.data["from"] ?? ""),
        sinceTs: typeof e.data["sinceTs"] === "number" ? e.data["sinceTs"] : e.ts,
        sinceMs: typeof e.data["sinceMs"] === "number" ? e.data["sinceMs"] : 0,
        lastSeq: typeof e.data["lastSeq"] === "number" ? e.data["lastSeq"] : 0,
        messageCount: typeof e.data["messageCount"] === "number" ? e.data["messageCount"] : 1,
      };
      break;
    }
    default:
      break;   // agent_task/tool_call/message_*/etc: no AgentRecord field this reducer owns
  }
}

// R2 (self-healing supervision): the baseline/event-source shapes replayAgentsAsOf needs —
// structurally satisfied by a parsed state.json (`{agents, lastSeq}`) and a real EventLog's
// `replay`/`currentSeq`, but kept as their own types so a post-mortem caller (e.g. the
// replay.agentsAsOf RPC handler) never needs a live Engine.
export type ReplaySnapshotSource = { agents?: AgentRecord[]; lastSeq?: number };
export type ReplayEventSource = { replay(opts: { fromSeq: number; toSeq?: number; limit: number }): NormalizedEvent[]; currentSeq(): number };

// Reads the given (already-parsed) baseline snapshot and folds events (lastSeq, toSeq] onto it.
// toSeq omitted ⇒ fold everything up to the log's current tip (mirrors reattachFromState's own
// unbounded gap-fold, generalized to a caller-supplied bound). Pure w.r.t. its inputs — unlike
// reattachFromState's original in-place fold (which owned a freshly-JSON.parsed object nobody
// else held a reference to), `baseline.agents` is deep-copied before mutation so a caller who
// reuses the same parsed snapshot object across multiple replayAgentsAsOf calls (e.g. one per
// candidate toSeq) never sees an earlier call's fold bleed into a later one.
export function replayAgentsAsOf(baseline: ReplaySnapshotSource, events: ReplayEventSource, toSeq?: number): AgentRecord[] {
  const agents = structuredClone(baseline.agents ?? []);
  const target = toSeq ?? events.currentSeq();
  if (typeof baseline.lastSeq === "number") {
    const gap = events.replay({ fromSeq: baseline.lastSeq + 1, toSeq: target, limit: Number.MAX_SAFE_INTEGER });
    reconstructAgentsFromLog(agents, gap);
  }
  return agents;
}

// Boot-glue-shaped sibling of reattach.ts's reattachFromState — reads the SAME state.json shape
// for a standalone post-mortem query (the replay.agentsAsOf RPC handler) rather than a reattach
// decision. Same torn/missing-file tolerance (returns [] rather than throwing) as
// reattachFromState, for the same reason: a crash mid-snapshot must never turn a diagnostic
// read into a thrown error.
export function replayAgentsAsOfFromStateFile(
  stateFilePath: string,
  events: ReplayEventSource,
  toSeq: number | undefined,
  readFile: typeof readFileSync = readFileSync,
  exists: typeof existsSync = existsSync,
): AgentRecord[] {
  if (!exists(stateFilePath)) return [];
  try {
    const prior = JSON.parse(String(readFile(stateFilePath, "utf8"))) as ReplaySnapshotSource;
    return replayAgentsAsOf(prior, events, toSeq);
  } catch {
    return [];
  }
}
