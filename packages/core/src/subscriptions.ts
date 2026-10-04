import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CONTENT_TOPICS, SubscriptionSchema, contentFilterIssue, scopeFilterIssue, type NormalizedEvent, type Subscription, type Topic } from "@chimera/protocol";
import type { EventLog } from "./events.js";
import type { MailboxStore } from "./mailbox.js";
import { KIND_TO_TOPICS, TOPIC_TABLE, matchesTopicFilter, narrowContentPayload, type TopicAgentLookup, type TopicPayload } from "./topics.js";

export class SubscriptionCapError extends Error { code = "guardrail" as const; name = "SubscriptionCapError"; }
// F46: a refused content-topic shape (contains missing/misplaced, or once:false). Distinct from
// the cap error so a caller can tell "you asked for the impossible" from "we are full".
export class SubscriptionFilterError extends Error { code = "guardrail" as const; name = "SubscriptionFilterError"; }

// §2.4 caps/budgets (PLAN-HOOKS.md §9).
const MAX_SUBS_PER_AGENT = 32;
const MAX_UNDELIVERED_SIGNALS = 50;
const DURABLE_COALESCE_MS_DEFAULT = 5000;
const MAX_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;   // 7d
const DEFAULT_EXPIRES_MS = 24 * 60 * 60 * 1000;   // 24h
const MAX_SIGNAL_CHARS = 600;
// F46: a DAEMON-WIDE cap, not per-agent — every content subscription scans every output event
// in the fleet, so 32 agents × 32 subs each would be 1024 substring passes per message.
const MAX_CONTENT_SUBS_TOTAL = 64;

export type SubTimerFn = (fn: () => void, ms: number) => unknown;
export type SubClearTimerFn = (h: unknown) => void;

export type SubscriptionRegistryDeps = {
  events: EventLog;
  mailboxes: MailboxStore;
  getAgent: TopicAgentLookup;
  // Public deliverPending-equivalent (engine.ts's Engine.wakeMailbox / AgentSupervisor.wakeMailbox)
  // — no-op unless the subscriber is currently RUNNING; wakes an idle running agent INSTANTLY
  // (the AsyncQueue waiter, §0.1) or buffers for the next turn boundary if mid-turn.
  wakeMailbox: (agentId: string) => void;
  // §2.3 wake:"resume" — generalizes checkPendingOnSettle's resume machinery (supervisor.ts) to
  // a subscriber that is ALREADY settled by the time a resume-eligible signal lands in its
  // mailbox (checkPendingOnSettle itself only fires at the subscriber's OWN settle moment, which
  // is unrelated in time to a signal caused by some OTHER agent/topic firing later).
  resumeForSignal: (agentId: string) => void;
  now?: () => number;
  setTimer?: SubTimerFn;
  clearTimer?: SubClearTimerFn;
};

type Window = { count: number; payload: TopicPayload; eventSeq: number; timer: unknown };

// §2.1: persisted <home>/subscriptions.json (temp+rename, QueueStore/MemoryStore Pattern B) so
// subscriptions survive a daemon restart alongside the paused/terminal agents they belong to.
// Kind-indexed matching inside the EventLog's synchronous listener (topics.ts's KIND_TO_TOPICS)
// keeps the match step itself O(subs-on-this-topic), not O(all subs) — §9's <0.5ms budget.
export class SubscriptionRegistry {
  private subs = new Map<string, Subscription>();
  private byTopic = new Map<Topic, Set<string>>();
  private bySubscriber = new Map<string, Set<string>>();
  private windows = new Map<string, Window>();
  // Storm insurance (§2.4): once a subscriber's mailbox has MAX_UNDELIVERED_SIGNALS pending
  // signals, further matches are suppressed (ONE coalesce notice, not one per suppressed match)
  // until the mailbox actually drains below the cap again.
  private collapsedNotified = new Set<string>();
  private file: string;
  private setTimer: SubTimerFn;
  private clearTimer: SubClearTimerFn;
  private nowFn: () => number;

  constructor(homeDir: string, private deps: SubscriptionRegistryDeps) {
    this.file = join(homeDir, "subscriptions.json");
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.nowFn = deps.now ?? Date.now;
    this.load();
    this.deps.events.subscribe((e) => this.onEvent(e));
  }

  private now(): number { return this.nowFn(); }

  // ---------- public API (SubRpc's sub.create/remove/list) ----------

  create(input: unknown): Subscription {
    const parsed = SubscriptionSchema.omit({ id: true }).strict().parse(input);
    // The content rules live outside the schema (see contentFilterIssue) — apply them here so
    // the registry refuses the same shapes the RPC boundary does, however it was reached.
    const issue = contentFilterIssue(parsed.topic, parsed.filter, { once: parsed.once }) ?? scopeFilterIssue(parsed.filter);
    if (issue) throw new SubscriptionFilterError(issue);
    this.gcExpiredFor(parsed.subscriberId);
    const live = this.bySubscriber.get(parsed.subscriberId)?.size ?? 0;
    if (live >= MAX_SUBS_PER_AGENT) {
      throw new SubscriptionCapError(`subscriber "${parsed.subscriberId}" already has ${MAX_SUBS_PER_AGENT} live subscriptions (cap)`);
    }
    if (TOPIC_TABLE[parsed.topic].matchField && this.countContentSubs() >= MAX_CONTENT_SUBS_TOTAL) {
      throw new SubscriptionCapError(`content subscriptions are capped at ${MAX_CONTENT_SUBS_TOTAL} daemon-wide (each one scans every output event)`);
    }
    const now = this.now();
    // coalesceMs has NO schema default (it depends on the sibling `once` field, which
    // z.default() can't express) — apply the conditional default here, at create time.
    const coalesceMs = parsed.coalesceMs ?? (parsed.once ? 0 : DURABLE_COALESCE_MS_DEFAULT);
    // F46: a content subscription MUST be once:true, so the historical "once ⇒ never expires"
    // rule would make every never-matching needle scan the whole fleet's output forever. Content
    // subs therefore always get a TTL, and an EXPLICIT expiresAt is now honored on any once sub
    // (it was silently dropped before, despite the schema accepting it). A plain lifecycle
    // once-sub that asks for no TTL still gets none.
    const needsTtl = !parsed.once || parsed.expiresAt !== undefined || TOPIC_TABLE[parsed.topic].matchField !== undefined;
    const expiresAt = needsTtl
      ? Math.min(parsed.expiresAt ?? now + DEFAULT_EXPIRES_MS, now + MAX_EXPIRES_MS)
      : undefined;
    const sub: Subscription = { ...parsed, id: randomUUID(), coalesceMs, expiresAt };
    this.subs.set(sub.id, sub);
    this.indexAdd(sub);
    this.persist();
    return sub;
  }

  private countContentSubs(): number {
    let n = 0;
    for (const t of CONTENT_TOPICS) n += this.byTopic.get(t)?.size ?? 0;
    return n;
  }

  remove(subscriberId: string, id: string): boolean {
    const sub = this.subs.get(id);
    if (!sub || sub.subscriberId !== subscriberId) return false;
    this.removeInternal(sub);
    return true;
  }

  list(subscriberId: string): Subscription[] {
    this.gcExpiredFor(subscriberId);
    const ids = this.bySubscriber.get(subscriberId);
    if (!ids) return [];
    return [...ids].map((id) => this.subs.get(id)!).filter(Boolean);
  }

  // ---------- event-bus matching ----------

  private onEvent(e: NormalizedEvent): void {
    const topics = KIND_TO_TOPICS.get(e.kind);
    if (topics) {
      for (const topic of topics) {
        // Projecting costs real work for a content topic (a scan-window slice + a full
        // toLowerCase of it) — with nobody subscribed that is pure waste on EVERY message the
        // fleet emits, so the zero-subscriber check comes BEFORE toPayload, not inside it.
        if ((this.byTopic.get(topic)?.size ?? 0) === 0) continue;
        const payload = TOPIC_TABLE[topic].toPayload(e, { getAgent: this.deps.getAgent });
        if (payload !== null) this.matchAndDeliver(topic, payload, e.seq);
      }
    }
    // §2.4 subscriber-terminal GC piggybacks on the SAME settle-shaped events agent.settled
    // already listens for — no extra EventLog subscription needed.
    if (e.kind === "result" || (e.kind === "status" && (e.data["state"] === "failed" || e.data["state"] === "killed"))) {
      this.gcTerminalSubscriber(e.agentId);
    }
  }

  private matchAndDeliver(topic: Topic, payload: TopicPayload, eventSeq: number): void {
    const ids = this.byTopic.get(topic);
    if (!ids || ids.size === 0) return;
    const mapping = TOPIC_TABLE[topic];
    for (const id of [...ids]) {
      const sub = this.subs.get(id);
      if (!sub) continue;
      if (this.isExpired(sub)) { this.removeInternal(sub); continue; }
      // An agent watching for a word it itself writes would wake on its own output forever.
      if (mapping.matchField && payload["agentId"] === sub.subscriberId) continue;
      if (!matchesTopicFilter(payload, sub.filter)) continue;
      this.scheduleDelivery(sub, mapping.matchField ? narrowContentPayload(payload, sub.filter?.contains) : payload, eventSeq);
    }
  }

  // §2.3 coalescing: once:true subs default coalesceMs:0 (deliver immediately — the sub is
  // one-shot anyway, no point windowing). Durable subs batch rapid-fire matches into ONE
  // delivery per window, carrying a ×count suffix (NotifyEvaluator's own Window pattern).
  private scheduleDelivery(sub: Subscription, payload: TopicPayload, eventSeq: number): void {
    const coalesceMs = sub.coalesceMs ?? 0;
    if (coalesceMs <= 0) { this.deliverNow(sub.id, payload, eventSeq, 1); return; }
    const existing = this.windows.get(sub.id);
    if (existing) { existing.count += 1; existing.payload = payload; existing.eventSeq = eventSeq; return; }
    const win: Window = { count: 1, payload, eventSeq, timer: null };
    win.timer = this.setTimer(() => {
      this.windows.delete(sub.id);
      this.deliverNow(sub.id, win.payload, win.eventSeq, win.count);
    }, coalesceMs);
    this.windows.set(sub.id, win);
  }

  // ---------- delivery + wake policy (§2.3) ----------

  private deliverNow(subId: string, payload: TopicPayload, eventSeq: number, count: number): void {
    const sub = this.subs.get(subId);
    if (!sub) return;   // removed/expired mid-window
    if (this.isExpired(sub)) { this.removeInternal(sub); return; }

    const agent = this.deps.getAgent(sub.subscriberId);
    const settled = !agent || agent.state === "done" || agent.state === "failed" || agent.state === "killed";

    if (settled && sub.wake === "drop") {
      this.deps.events.append({
        agentId: sub.subscriberId, kind: "status",
        data: { signalDropped: true, topic: sub.topic, subscriptionId: sub.id, eventSeq },
      });
      this.afterDelivered(sub);
      return;
    }

    const pendingSignals = this.deps.mailboxes.pending(sub.subscriberId).filter((m) => m.kind === "signal").length;
    if (pendingSignals >= MAX_UNDELIVERED_SIGNALS) {
      if (!this.collapsedNotified.has(sub.subscriberId)) {
        this.collapsedNotified.add(sub.subscriberId);
        this.deps.mailboxes.enqueue(sub.subscriberId, {
          from: "chimera", kind: "signal",
          text: `[signals coalesced: undelivered-signal cap (${MAX_UNDELIVERED_SIGNALS}) reached — further matches suppressed until this mailbox drains]`,
          meta: { coalesced: true },
        });
        this.deps.wakeMailbox(sub.subscriberId);
      }
      // NOT afterDelivered(sub): nothing was actually delivered here, so a once:true sub must
      // survive the suppression and still fire once the mailbox drains below the cap — calling
      // afterDelivered would auto-remove it having never delivered its one signal.
      return;
    }
    this.collapsedNotified.delete(sub.subscriberId);

    this.deps.mailboxes.enqueue(sub.subscriberId, {
      from: "chimera", kind: "signal",
      text: this.buildSignalText(sub, payload, eventSeq, count),
      meta: { topic: sub.topic, eventSeq, subscriptionId: sub.id, wake: sub.wake },
    });
    this.deps.events.append({
      agentId: sub.subscriberId, kind: "signal_delivered",
      data: { subscriptionId: sub.id, eventSeq, topic: sub.topic },
    });
    this.deps.wakeMailbox(sub.subscriberId);
    if (settled && sub.wake === "resume") this.deps.resumeForSignal(sub.subscriberId);

    this.afterDelivered(sub);
  }

  private afterDelivered(sub: Subscription): void {
    if (sub.once) this.removeInternal(sub);
    else this.persist();
  }

  // TOKEN ECONOMY (§2.3): one line + minimal JSON, hard cap ~600 chars.
  private buildSignalText(sub: Subscription, payload: TopicPayload, eventSeq: number, count: number): string {
    const countSuffix = count > 1 ? ` ×${count}` : "";
    const noteSuffix = sub.note ? ` · note: "${sub.note}"` : "";
    const text = `[signal:${sub.topic}]${countSuffix}${noteSuffix} · seq ${eventSeq}\n${JSON.stringify(payload)}`;
    return text.length > MAX_SIGNAL_CHARS ? text.slice(0, MAX_SIGNAL_CHARS - 1) + "…" : text;
  }

  // ---------- lifecycle/GC (§2.4) ----------

  private isExpired(sub: Subscription): boolean {
    return sub.expiresAt !== undefined && sub.expiresAt <= this.now();
  }

  // Lazy expiry (no new polling timer, §11 guardrail) — swept on the two access points that
  // actually need an up-to-date view (create()'s cap check, list()) plus opportunistically at
  // match time (matchAndDeliver). An expired sub nobody ever touches again just sits harmlessly
  // until the next list()/create() call or daemon restart reload.
  private gcExpiredFor(subscriberId: string): void {
    const ids = this.bySubscriber.get(subscriberId);
    if (!ids) return;
    for (const id of [...ids]) {
      const sub = this.subs.get(id);
      if (sub && this.isExpired(sub)) this.removeInternal(sub);
    }
  }

  private gcTerminalSubscriber(agentId: string): void {
    const ids = this.bySubscriber.get(agentId);
    if (!ids) return;
    for (const id of [...ids]) {
      const sub = this.subs.get(id);
      if (!sub) continue;
      if (sub.wake === "resume") continue;   // survives until fired or expired (§2.4)
      this.removeInternal(sub);
    }
  }

  private indexAdd(sub: Subscription): void {
    if (!this.byTopic.has(sub.topic)) this.byTopic.set(sub.topic, new Set());
    this.byTopic.get(sub.topic)!.add(sub.id);
    if (!this.bySubscriber.has(sub.subscriberId)) this.bySubscriber.set(sub.subscriberId, new Set());
    this.bySubscriber.get(sub.subscriberId)!.add(sub.id);
  }

  private removeInternal(sub: Subscription): void {
    this.subs.delete(sub.id);
    this.byTopic.get(sub.topic)?.delete(sub.id);
    this.bySubscriber.get(sub.subscriberId)?.delete(sub.id);
    const win = this.windows.get(sub.id);
    if (win) { this.clearTimer(win.timer); this.windows.delete(sub.id); }
    this.persist();
  }

  // ---------- persistence (temp+rename snapshot, Pattern B) ----------

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ subscriptions: [...this.subs.values()] }, null, 2));
    renameSync(tmp, this.file);
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { subscriptions: unknown[] };
      for (const s of raw.subscriptions) {
        const sub = SubscriptionSchema.parse(s);
        this.subs.set(sub.id, sub);
        this.indexAdd(sub);
      }
    } catch (err) {
      // Torn/corrupt snapshot: subscriptions are a soft feature nothing else depends on for
      // correctness — degrade to empty rather than crash-looping the daemon (memory.ts's
      // quarantine posture for the same failure class); self-heals on the next persist().
      console.warn(`chimerad: corrupt subscriptions snapshot at ${this.file}: ${(err as Error).message} — booting with none`);
    }
  }
}
