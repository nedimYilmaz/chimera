import { MeetingPlanSchema, type MeetingPlan } from "@chimera/protocol/meeting-plan";
import { randomUUID } from "node:crypto";
import type { ContractHandlers } from "@chimera/protocol/contract";
import type { VoiceRoom, VoiceRoomSpec, VoiceLimits, VoiceIdentity, VoiceDiagnostic, VoiceDiagnosticInput } from "@chimera/protocol/voice-rooms";

type Deps = {
  plan?(agentId: string, input: string, signal: AbortSignal): Promise<MeetingPlan>;
  limits(): VoiceLimits;
  identity(id: string): VoiceIdentity & { state: string; conductor: boolean };
  check(id: string, allowOwnedTransition?: boolean): unknown;
  stop(roomId: string): void;
  stopParticipant(roomId: string, agentId: string): void;
  updated?(roomId: string, context: { roomId: string; name: string; agenda: string; participants: VoiceIdentity[] }): void;
  diagnostic?(agentId: string, roomId: string, diagnostic: VoiceDiagnostic): void;
};
type Entry = { planningId?: string; planning?: AbortController; plans?: number; room: VoiceRoom; hostId?: string; diagnosticHostId?: string; reports?: number; heartbeat?: number; utterances: number; incremental?: Set<string> };
// Definitions are session-local; no meeting or audio silently restarts after a
// daemon restart. A live desktop owns the media lease, never a transcript tab.
export class VoiceRoomRpc {
  private rooms = new Map<string, Entry>();
  readonly handlers: Pick<ContractHandlers, "voice.room.cancelPlan" | "voice.room.plan" | "voice.room.create" | "voice.room.list" | "voice.room.update" | "voice.room.end" | "voice.room.delete" | "voice.room.approve" | "voice.room.heartbeat" | "voice.room.report" | "voice.room.removeParticipant" | "voice.room.reviewUpdate">;
  constructor(private deps: Deps, private now = Date.now) {
    this.handlers = {
      "voice.room.cancelPlan": p => {
        const e = this.host(p.roomId, p.hostId);
        const cancelled = !!e.planning && e.planningId === p.requestId;
        if (cancelled) e.planning!.abort();
        return { cancelled };
      },
      "voice.room.plan": async p => {
        const e = this.host(p.roomId, p.hostId);
        if (e.room.revision !== p.revision) throw new Error("Room changed before participation planning");
        const candidates = [...new Set(p.input.candidates)];
        if (candidates.some(id => !e.room.agentIds.includes(id)) || p.input.spoken.some(id => !e.room.agentIds.includes(id))) throw new Error("Plan refers to an unapproved participant");
        if (!this.deps.plan) throw new Error("Participation planning is unavailable");
        if ((e.plans ?? 0) >= 200) throw new Error("Meeting participation planning budget exhausted");
        e.plans = (e.plans ?? 0) + 1;
        e.planning?.abort(); const controller = new AbortController(); e.planning = controller; e.planningId = p.requestId;
        const timer = setTimeout(() => controller.abort(), 15_000); timer.unref();
        let onAbort!: () => void;
        const cancelled = new Promise<never>((_, reject) => { onAbort = () => reject(new Error("Participation planning cancelled")); controller.signal.addEventListener("abort", onAbort, { once: true }); });
        try {
          const identities = e.room.agentIds.map(id => this.deps.identity(id));
          const conductor = identities.find(i => i.role === "conductor")?.agentId ?? e.room.agentIds[0]!;
          const plan = MeetingPlanSchema.parse(await Promise.race([this.deps.plan(conductor, JSON.stringify({ ...p.input,
            meeting: { name: e.room.name, agenda: e.room.agenda }, participants: identities.map(({ agentId, name, role }) => ({ agentId, name, role })),
          }), controller.signal), cancelled]));
          this.host(p.roomId, p.hostId);
          if (controller.signal.aborted || e.room.revision !== p.revision) throw new Error("Participation plan superseded");
          if (plan.agentId && !candidates.includes(plan.agentId)) throw new Error("Planner selected an ineligible participant");
          this.record(p.roomId, { source: "meeting", event: "participation-planned", ...(plan.agentId ? { agentId: plan.agentId } : {}), code: plan.action });
          return plan;
        } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", onAbort); if (e.planning === controller) { e.planning = undefined; e.planningId = undefined; } }
      },
      "voice.room.create": p => {
        this.prune();
        if (p.callerAgentId) this.conductor(p.callerAgentId);
        if (this.rooms.size >= this.deps.limits().maxRooms) throw new Error("Voice room limit reached; delete an ended room or raise nativeVoice.maxRooms");
        this.validate(p);
        const room: VoiceRoom = { name: p.name, agenda: p.agenda, agentIds: [...p.agentIds], durationMinutes: p.durationMinutes, maxUtterances: p.maxUtterances,
          id: randomUUID(), revision: 1, ownerAgentId: p.callerAgentId ?? null, state: "pending", createdAt: this.now(), expiresAt: null, reason: null, participants: [] };
        this.rooms.set(room.id, { room, utterances: 0 });
        this.record(room.id, { source: "meeting", event: "created" }); return this.view(room);
      },
      "voice.room.list": p => {
        this.prune();
        if (p.callerAgentId) this.deps.identity(p.callerAgentId);
        return { limits: this.deps.limits(), rooms: [...this.rooms.values()].filter(e => !p.callerAgentId || e.room.ownerAgentId === p.callerAgentId || e.room.agentIds.includes(p.callerAgentId)).map(e => this.view(e.room)) };
      },
      "voice.room.update": p => {
        this.prune();
        const e = this.owned(p.roomId, p.callerAgentId);
        if (p.revision !== e.room.revision) throw new Error("Room changed; refresh before editing");
        this.validate(p.spec);
        if (e.room.state === "active") {
          // A proposal grants no audio access. Keep the approved roster, host,
          // media sessions, expiration and utterance count until host review.
          e.room.pendingUpdate = { ...p.spec, agentIds: [...p.spec.agentIds] };
          e.room.revision++;
          this.record(e.room.id, { source: "meeting", event: "update-requested" });
        } else {
          Object.assign(e.room, p.spec, { agentIds: [...p.spec.agentIds], revision: e.room.revision + 1, state: "pending", expiresAt: null, reason: null });
          delete e.room.pendingUpdate;
        }
        return this.view(e.room);
      },
      "voice.room.reviewUpdate": p => {
        const e = this.host(p.roomId, p.hostId);
        if (e.room.revision !== p.revision || !e.room.pendingUpdate) throw new Error("Room changed; review the latest proposal");
        if (!p.accept) {
          delete e.room.pendingUpdate; e.room.revision++;
          this.record(e.room.id, { source: "meeting", event: "update-declined" });
          return this.view(e.room);
        }
        const spec = e.room.pendingUpdate;
        this.validate(spec);
        for (const other of this.rooms.values()) if (other !== e && other.room.state === "active" && other.room.agentIds.some(id => spec.agentIds.includes(id))) throw new Error("A participant is already in another meeting");
        const expiresAt = e.room.expiresAt! + (spec.durationMinutes - e.room.durationMinutes) * 60_000;
        if (expiresAt <= this.now() || spec.maxUtterances <= e.utterances) throw new Error("Proposed meeting limits are already exhausted");
        e.incremental ??= new Set();
        for (const id of spec.agentIds) if (!e.room.agentIds.includes(id)) e.incremental.add(id);
        const removed = e.room.agentIds.filter(id => !spec.agentIds.includes(id));
        Object.assign(e.room, spec, { agentIds: [...spec.agentIds], expiresAt, revision: e.room.revision + 1 });
        delete e.room.pendingUpdate;
        for (const id of removed) { e.incremental.delete(id); this.deps.stopParticipant(p.roomId, id); }
        this.record(e.room.id, { source: "meeting", event: "update-approved" });
        this.deps.updated?.(p.roomId, this.context(p.roomId, p.hostId, e.room.agentIds[0]!));
        return this.view(e.room);
      },
      "voice.room.end": p => { const e = this.owned(p.roomId, p.callerAgentId); this.end(e, p.reason ?? "Meeting ended", p.source ?? (p.callerAgentId ? "agent-request" : "operator-request")); return this.view(e.room); },
      "voice.room.delete": p => { const e = this.owned(p.roomId, p.callerAgentId); if (e.room.state !== "ended") throw new Error("End the meeting before deleting its room"); return { deleted: this.rooms.delete(p.roomId) }; },
      "voice.room.approve": p => {
        this.prune(); const e = this.get(p.roomId);
        if (e.room.revision !== p.revision || e.room.state !== "pending") throw new Error("Room changed or already hosted; review it again");
        this.validate(e.room);
        for (const other of this.rooms.values()) if (other.room.state === "active" && other.room.agentIds.some(id => e.room.agentIds.includes(id))) throw new Error("A participant is already in another meeting");
        e.hostId = p.hostId; e.diagnosticHostId = p.hostId; e.reports = 0; e.heartbeat = this.now(); e.utterances = 0;
        e.room.state = "active"; e.room.reason = null; e.room.expiresAt = this.now() + e.room.durationMinutes * 60_000;
        this.record(e.room.id, { source: "meeting", event: "approved" });
        return this.view(e.room);
      },
      "voice.room.heartbeat": p => { const e = this.host(p.roomId, p.hostId); e.heartbeat = this.now(); return this.view(e.room); },
      "voice.room.report": p => {
        const e = this.get(p.roomId);
        // Allow cleanup diagnostics after end, but never from a different or
        // superseded host. Reporting must not renew an expired audio lease.
        if (e.diagnosticHostId !== p.hostId) throw new Error("Diagnostic belongs to another desktop lease");
        if (p.diagnostic.agentId && !e.room.agentIds.includes(p.diagnostic.agentId)) throw new Error("Diagnostic agent is not a participant");
        if ((e.reports ?? 0) >= 1000) return { recorded: false };
        e.reports = (e.reports ?? 0) + 1;
        this.record(p.roomId, p.diagnostic, "desktop"); return { recorded: true };
      },
      "voice.room.removeParticipant": p => {
        const e = this.host(p.roomId, p.hostId);
        if (e.room.revision !== p.revision) throw new Error("Room changed; refresh before removing a participant");
        if (!e.room.agentIds.includes(p.agentId)) throw new Error("Agent is not a room participant");
        e.room.agentIds = e.room.agentIds.filter(id => id !== p.agentId); e.room.revision++;
        delete e.room.pendingUpdate; e.incremental?.delete(p.agentId);
        this.deps.stopParticipant(p.roomId, p.agentId);
        if (!e.room.agentIds.length) this.end(e, "All participants dismissed");
        return this.view(e.room);
      },
    };
  }
  context(roomId: string, hostId: string, agentId: string) {
    const e = this.host(roomId, hostId);
    if (!e.room.agentIds.includes(agentId)) throw new Error("Agent is not an approved room participant");
    return { roomId, name: e.room.name, agenda: e.room.agenda, participants: e.room.agentIds.map(id => { const { agentId, name, role } = this.deps.identity(id); return { agentId, name, role }; }) };
  }
  message(agentId: string): void {
    for (const e of this.rooms.values()) if (e.room.state === "active" && e.room.agentIds.includes(agentId) && ++e.utterances >= e.room.maxUtterances) this.end(e, "Meeting utterance budget reached");
  }
  private get(id: string): Entry { const e = this.rooms.get(id); if (!e) throw new Error("Unknown voice room"); return e; }
  private conductor(id: string): void { const a = this.deps.identity(id); if (!a.conductor || a.state !== "running") throw new Error("Only running conductors can manage meeting rooms"); }
  private owned(id: string, caller?: string): Entry { const e = this.get(id); if (caller) { this.conductor(caller); if (e.room.ownerAgentId !== caller) throw new Error("Only the room owner or operator can manage this meeting"); } return e; }
  private host(id: string, hostId: string): Entry { this.prune(); const e = this.get(id); if (e.room.state !== "active" || e.hostId !== hostId) throw new Error("Meeting lease expired, ended or belongs to another desktop"); return e; }
  private validate(spec: VoiceRoomSpec): void {
    if (spec.agentIds.length > this.deps.limits().maxParticipants || spec.agentIds.length > this.deps.limits().maxSessions) throw new Error("Meeting participant/session limit exceeded");
    for (const id of spec.agentIds) this.deps.check(id);
  }
  record(roomId: string, input: VoiceDiagnosticInput, origin: VoiceDiagnostic["origin"] = "daemon"): void {
    const e = this.rooms.get(roomId);
    if (!e) return;
    const diagnostic: VoiceDiagnostic = { ...input, at: this.now(), origin };
    e.room.diagnostics = [...(e.room.diagnostics ?? []), diagnostic].slice(-50);
    this.deps.diagnostic?.(input.agentId ?? e.room.ownerAgentId ?? e.room.agentIds[0] ?? "voice", roomId, diagnostic);
  }
  private end(e: Entry, reason: string, cause = "room-policy"): void {
    if (e.room.state === "ended") return;
    e.planning?.abort();
    e.room.state = "ended"; e.room.reason = reason; e.hostId = undefined;
    delete e.room.pendingUpdate;
    this.record(e.room.id, { source: "meeting", event: "ended", message: reason, code: cause });
    this.deps.stop(e.room.id);
  }
  private prune(): void {
    for (const e of this.rooms.values()) if (e.room.state === "active") {
      if (this.now() >= e.room.expiresAt!) { this.end(e, "Meeting duration expired", "duration-expired"); continue; }
      if (this.now() - e.heartbeat! > 20_000) { this.end(e, "Desktop heartbeat lease expired", "heartbeat-expired"); continue; }
      // Lowering capacity governs new meetings, never kills an approved one.
      for (const id of [...e.room.agentIds]) {
        try { this.deps.check(id, true); }
        catch (error) {
          this.record(e.room.id, { source: "daemon", event: "participant-unavailable", agentId: id, message: String(error).slice(0, 1000) });
          // A failed incremental join must never tear down existing peers.
          if (e.incremental?.has(id)) {
            e.incremental.delete(id); e.room.agentIds = e.room.agentIds.filter(other => other !== id); e.room.revision++;
            delete e.room.pendingUpdate; this.deps.stopParticipant(e.room.id, id);
            if (!e.room.agentIds.length) this.end(e, "All participants dismissed");
          } else { this.end(e, "A participant is no longer voice-capable; coding work is unchanged", "participant-unavailable"); break; }
        }
      }
    }
  }
  private view(room: VoiceRoom): VoiceRoom {
    return { ...room, agentIds: [...room.agentIds], participants: room.agentIds.map(id => {
      try { const { agentId, name, role, state } = this.deps.identity(id); return { agentId, name, role, state }; }
      catch { return { agentId: id, name: id.slice(0, 8), role: "agent", state: "unavailable" }; }
    }) };
  }
}
