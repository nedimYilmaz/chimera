import type { EventKind, PromptStall, SendAck } from "@chimera/protocol";
import { isTurnOpening, TURN_CLOSING_KINDS } from "./turn-kinds.js";

// F09 QA (item 1): DERIVED, NOT GUESSED, and config-backed (ChimeraConfigSchema.promptAck) so an
// operator can override without a code change — see that field's own comment in
// packages/protocol/src/index.ts for the full derivation policy and provenance. These two
// exports are DEFAULTS ONLY (used when a caller doesn't thread the config value through, and by
// tests that want the documented baseline); the live values actually armed by the supervisor are
// `this.promptStallMs` / `this.cfg.promptAck.ackWaitMs`, both resolved once at construction from
// config. Both values come from docs/superpowers/measurements/2026-09-02-prompt-ack-latency.json
// (idle-send latencies, n=400): PROMPT_ACK_WAIT_MS = p90, rounded (p50 585ms / p90 8708ms / p95
// 21722ms / p99 114153ms); PROMPT_STALL_MS = the smallest coverage-table bucket at or above a 2%
// false-signal rate (98% coverage at 45s, flat out to 90s, so nothing is bought by waiting
// longer). Re-derive both by re-running scripts/prompt-ack-latency.mjs; do not tune by feel.
export const PROMPT_ACK_WAIT_MS = 9_000;
export const PROMPT_STALL_MS = 45_000;

export type PromptAckOutcome = { ack: SendAck; ackMs: number | null };

// What observe() hands back when a turn-opening event closes a stall that had ALREADY fired —
// the supervisor needs both fields to append the clearing status event. Undefined for the
// overwhelmingly common case (a normal turn opening), so a healthy fleet appends no noise.
export type PromptStallResolved = { deliveryId: string; ackMs: number };

type Binding = { agentId: string; armedAt: number; midTurn: boolean };
type Waiter = { resolve: (o: PromptAckOutcome) => void; timer: ReturnType<typeof setTimeout> };
type StallEntry = {
  deliveryId: string;
  from: string;
  sinceTs: number;
  lastSeq: number;
  messageCount: number;
  timer: ReturnType<typeof setTimeout>;
  fired: boolean;
};

// Bounded memory for outcomes nobody has awaited yet: send() registers its waiter one tick after
// deliverBatch arms, so a very fast agent can open its turn before the waiter exists. Without
// this the RPC would report "pending" for a delivery it can prove started.
const SETTLED_CAP = 256;

/**
 * One per supervisor. Holds no reference to AgentRecord/AgentHandle — it is told about deliveries
 * and events and answers questions, which keeps it unit-testable with a fake clock and keeps
 * supervisor.ts's diff to five call sites.
 *
 * Waiters are keyed by MAILBOX MESSAGE ID, not by agent: deliverBatch coalesces a group and the
 * RPC caller only knows the id it enqueued, so an agent-keyed waiter would resolve the wrong
 * caller when two sends race into one delivery.
 */
export class PromptAckWatch {
  private readonly open = new Set<string>();
  private readonly lastSeq = new Map<string, number>();
  // The seq of the last TURN-OPENING event seen per agent, kept apart from `lastSeq` (which
  // moves on EVERY kind). armed() compares it against the seq captured before handle.send to
  // catch a turn that opened inside the send/arm window — see the ALREADY-OPENED branch there.
  private readonly lastOpenSeq = new Map<string, number>();
  private readonly bindings = new Map<string, Binding>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly settled = new Map<string, PromptAckOutcome>();
  private readonly stalls = new Map<string, StallEntry>();

  constructor(
    private readonly deps: {
      now: () => number;
      onStall: (agentId: string, stall: PromptStall) => void;
      // F09 QA (item 1): boot-time-only, resolved once by the caller from
      // ChimeraConfigSchema.promptAck.stallMs. Defaults to PROMPT_STALL_MS so existing
      // fixtures that don't pass it stay byte-identical.
      stallMs?: number;
    },
  ) {}

  observe(agentId: string, kind: EventKind, seq: number, data?: Record<string, unknown>): PromptStallResolved | undefined {
    this.lastSeq.set(agentId, seq);
    if (TURN_CLOSING_KINDS.has(kind)) {
      this.open.delete(agentId);
      return undefined;
    }
    if (!isTurnOpening(kind, data)) return undefined;
    this.open.add(agentId);
    this.lastOpenSeq.set(agentId, seq);

    const now = this.deps.now();
    for (const [id, b] of this.bindings) {
      if (b.agentId !== agentId) continue;
      this.bindings.delete(id);
      // A binding that was mid_turn at delivery has already answered; this event is that turn
      // continuing, not proof the message started one.
      if (b.midTurn) continue;
      this.settle(id, { ack: "started", ackMs: Math.max(0, now - b.armedAt) });
    }

    const entry = this.stalls.get(agentId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.stalls.delete(agentId);
    return entry.fired ? { deliveryId: entry.deliveryId, ackMs: Math.max(0, now - entry.sinceTs) } : undefined;
  }

  isMidTurn(agentId: string): boolean {
    return this.open.has(agentId);
  }

  armed(
    agentId: string,
    d: {
      deliveryId: string;
      messageIds: readonly string[];
      from: string;
      messageCount: number;
      midTurn: boolean;
      slash: boolean;
      lastSeq: number;
      // The event seq read BEFORE handle.send — the window opens there, not here.
      preSendSeq: number;
    },
  ): void {
    const now = this.deps.now();
    for (const id of d.messageIds) this.bindings.set(id, { agentId, armedAt: now, midTurn: d.midTurn });
    if (d.slash) {
      // F09.QA: a slash command is NOT a prompt. /compact and friends can run for minutes
      // (supervisor's SLASH-COMMAND-IN-FLIGHT note) and some of them — /compact — report back
      // with a `compaction` event, which is in neither TURN_OPENING_KINDS nor
      // TURN_CLOSING_KINDS, so the watch would never see an opening and would fire a stall on a
      // perfectly healthy agent. J5 already exempts slash from the ack WAIT; the stall watch is
      // the same exemption for the same reason.
      for (const id of d.messageIds) {
        this.bindings.delete(id);
        this.settle(id, { ack: "pending", ackMs: null });
      }
      return;
    }
    if (d.midTurn) {
      // A2: the message joins the turn already running. No watch, no timer, ever.
      for (const id of d.messageIds) {
        this.bindings.delete(id);
        this.settle(id, { ack: "mid_turn", ackMs: null });
      }
      return;
    }
    // ALREADY-OPENED (the send/arm race): the backend can emit its first turn-opening event
    // while we are still inside `await handle.send(...)`, so observe() ran with NO binding to
    // settle and open/close again before we got here. Arming blind then costs twice: the caller
    // waits out the whole ackWaitMs for an opening that already happened, and — because observe()
    // only clears a stall on an OPENING kind — a turn that also CLOSED in that window leaves an
    // armed stall firing a false agent.promptStalled on a healthy agent.
    //
    // The comparison is `>=`, not `>`: supervisor.onEvent calls observe() with
    // events.currentSeq() BEFORE appending that event, so an opening seen inside the window
    // carries exactly `preSendSeq`. A STALE opening cannot satisfy it — it would need to be the
    // last observed event with nothing appended since, and in that state the agent is still
    // `open`, so the midTurn branch above already returned.
    if ((this.lastOpenSeq.get(agentId) ?? -1) >= d.preSendSeq) {
      for (const id of d.messageIds) {
        this.bindings.delete(id);
        // ackMs 0, not `now - armedAt`: the turn opened before this call, so the honest measured
        // latency is "within the send", and armedAt is already past it.
        this.settle(id, { ack: "started", ackMs: 0 });
      }
      return;
    }
    const existing = this.stalls.get(agentId);
    if (existing) {
      // A second delivery while the first is still unacknowledged ACCUMULATES: the original
      // deadline stands (the first message has been waiting longest, and resetting the clock on
      // every new message would let a chatty conductor postpone the alarm forever).
      existing.messageCount += d.messageCount;
      existing.lastSeq = Math.max(existing.lastSeq, d.lastSeq);
      return;
    }
    const timer = setTimeout(() => this.fire(agentId), this.deps.stallMs ?? PROMPT_STALL_MS);
    timer.unref?.();
    this.stalls.set(agentId, {
      deliveryId: d.deliveryId,
      from: d.from,
      sinceTs: now,
      lastSeq: d.lastSeq,
      messageCount: d.messageCount,
      timer,
      fired: false,
    });
  }

  await(deliveryId: string, waitMs: number): Promise<PromptAckOutcome> {
    const already = this.settled.get(deliveryId);
    if (already) {
      this.settled.delete(deliveryId);
      return Promise.resolve(already);
    }
    const binding = this.bindings.get(deliveryId);
    if (binding?.midTurn) return Promise.resolve({ ack: "mid_turn", ackMs: null });
    return new Promise<PromptAckOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(deliveryId);
        resolve({ ack: "pending", ackMs: null });
      }, waitMs);
      timer.unref?.();
      this.waiters.set(deliveryId, { resolve, timer });
    });
  }

  forget(agentId: string): void {
    const entry = this.stalls.get(agentId);
    if (entry) {
      clearTimeout(entry.timer);
      this.stalls.delete(agentId);
    }
    for (const [id, b] of this.bindings) {
      if (b.agentId !== agentId) continue;
      this.bindings.delete(id);
      this.settle(id, { ack: "pending", ackMs: null });
    }
    this.open.delete(agentId);
    this.lastSeq.delete(agentId);
    this.lastOpenSeq.delete(agentId);
  }

  dispose(): void {
    for (const agentId of [...this.stalls.keys()]) this.forget(agentId);
    for (const [id, w] of this.waiters) {
      clearTimeout(w.timer);
      this.waiters.delete(id);
      w.resolve({ ack: "pending", ackMs: null });
    }
    this.bindings.clear();
    this.settled.clear();
    this.open.clear();
    this.lastSeq.clear();
    this.lastOpenSeq.clear();
  }

  private fire(agentId: string): void {
    const entry = this.stalls.get(agentId);
    if (!entry || entry.fired) return;
    entry.fired = true;
    this.deps.onStall(agentId, {
      deliveryId: entry.deliveryId,
      from: entry.from,
      sinceTs: entry.sinceTs,
      sinceMs: Math.max(0, this.deps.now() - entry.sinceTs),
      lastSeq: Math.max(entry.lastSeq, this.lastSeq.get(agentId) ?? 0),
      messageCount: entry.messageCount,
    });
  }

  private settle(deliveryId: string, outcome: PromptAckOutcome): void {
    const waiter = this.waiters.get(deliveryId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(deliveryId);
      waiter.resolve(outcome);
      return;
    }
    this.settled.set(deliveryId, outcome);
    if (this.settled.size > SETTLED_CAP) {
      const oldest = this.settled.keys().next();
      if (!oldest.done) this.settled.delete(oldest.value);
    }
  }
}
