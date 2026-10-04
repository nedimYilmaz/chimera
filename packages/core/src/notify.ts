import type { NormalizedEvent, NotifyRule } from "@chimera/protocol";
import type { EventLog } from "./events.js";

export class UnknownNotifyRuleError extends Error { code = "protocol" as const; name = "UnknownNotifyRuleError"; }

// D14 (notifications, coverage C16, F18): watches the shared EventLog for events matching a
// config-driven NotifyRule and delivers through the rule's channel. See NotifyRuleSchema
// (@chimera/protocol) for the rule shape/defaults and PLAN-DAEMON.md D14 for the design.
//
// Throttle/dedupe (spec: "a burst collapses to ONE delivery carrying a ×N counter"): the
// FIRST match for a rule opens a window; every further match within `throttleSec` only
// increments the window's counter; the window's single timer fires the ONE delivery at
// close, carrying the accumulated count. A rule that never matches again never delivers
// early — this is a batching/rate-limit window, not a leading-edge notify.
//
// Delivery must NEVER block the event stream (D0-style invariant, explicit in the F18
// spec for webhook): `onEvent` runs synchronously inside EventLog.append's listener loop,
// so every delivery path here is fire-and-forget (a2a/webhook are async; a2a/webhook
// failures are caught and turned into a `notify_error` event, never thrown/rethrown).

export type SendFn = (agentId: string, text: string, from?: string) => Promise<void>;
export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;
export type TimerFn = (fn: () => void, ms: number) => unknown;
export type ClearTimerFn = (h: unknown) => void;

const WEBHOOK_MAX_ATTEMPTS = 3;
const WEBHOOK_RETRY_BASE_MS = 500;

type Window = { count: number; sample: NormalizedEvent; timer: unknown };

// Exported so PLAN-HOOKS.md's HookEngine (hooks.ts, HOOK-4) can apply the SAME shallow-match
// semantics against a topic's curated payload (TopicFilterSchema documents this explicitly) —
// one matcher, two consumers, never a diverging copy.
export function matchesFilter(data: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    const actual = data[k];
    if (Array.isArray(v)) {
      if (!v.includes(actual)) return false;
    } else if (actual !== v) {
      return false;
    }
  }
  return true;
}

export class NotifyEvaluator {
  private rules: NotifyRule[] = [];
  private windows = new Map<string, Window>();   // keyed by rule name
  private send: SendFn;
  private fetchFn: FetchFn;
  private setTimer: TimerFn;
  private clearTimer: ClearTimerFn;
  // Resolves an event's agentId to its tree's depth-0 agent (the a2a "main" target) — null
  // when the source agentId isn't a live tracked agent (e.g. a "config"/"job:<name>" system
  // event, or the tree already finished).
  private resolveTreeAgent: (agentId: string) => string | null;

  constructor(private opts: {
    events: EventLog;
    send: SendFn;
    resolveTreeAgent: (agentId: string) => string | null;
    fetchFn?: FetchFn;
    setTimer?: TimerFn;
    clearTimer?: ClearTimerFn;
  }) {
    this.send = opts.send;
    this.resolveTreeAgent = opts.resolveTreeAgent;
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.opts.events.subscribe((e) => this.onEvent(e));
  }

  // D7 diff-apply hook: config.notify changed → swap the live rule set. A rule removed/
  // disabled mid-window still delivers its already-open window (the timer already fired or
  // is about to; nothing to reconcile — the next match under the old name just opens a
  // fresh window under whatever rule now owns that name, if any).
  setRules(rules: NotifyRule[]): void {
    this.rules = rules;
  }

  private onEvent(e: NormalizedEvent): void {
    if (e.kind === "notify" || e.kind === "notify_error") return;   // never self-trigger
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.on.kind !== e.kind) continue;
      if (rule.on.filter && !matchesFilter(e.data, rule.on.filter)) continue;
      this.schedule(rule, e);
    }
  }

  private schedule(rule: NotifyRule, e: NormalizedEvent): void {
    const existing = this.windows.get(rule.name);
    if (existing) {
      existing.count += 1;
      existing.sample = e;
      return;
    }
    const win: Window = { count: 1, sample: e, timer: null };
    win.timer = this.setTimer(() => {
      this.windows.delete(rule.name);
      this.deliver(rule, win.sample, win.count);
    }, rule.throttleSec * 1000);
    this.windows.set(rule.name, win);
  }

  private deliver(rule: NotifyRule, sample: NormalizedEvent, count: number): void {
    const payload = { ruleId: rule.name, kind: sample.kind, channel: rule.channel, agentId: sample.agentId, count };
    switch (rule.channel) {
      case "os":
      case "toast":
        this.opts.events.append({ agentId: "notify", kind: "notify", data: payload });
        return;
      case "a2a": {
        const target = this.resolveTreeAgent(sample.agentId);
        if (!target) {
          this.opts.events.append({ agentId: "notify", kind: "notify_error", data: { ...payload, message: `no live target agent for "${sample.agentId}"` } });
          return;
        }
        const text = `[notify:${rule.name}] ${sample.kind} on ${sample.agentId}${count > 1 ? ` (×${count})` : ""}`;
        void this.send(target, text, "notify")
          .then(() => this.opts.events.append({ agentId: "notify", kind: "notify", data: payload }))
          .catch((err) => this.opts.events.append({ agentId: "notify", kind: "notify_error", data: { ...payload, message: String((err as Error)?.message ?? err) } }));
        return;
      }
      case "webhook":
        void this.deliverWebhook(rule, payload, sample);
        return;
    }
  }

  private async deliverWebhook(rule: NotifyRule, payload: Record<string, unknown>, sample: NormalizedEvent): Promise<void> {
    if (!rule.webhookUrl) {
      this.opts.events.append({ agentId: "notify", kind: "notify_error", data: { ...payload, message: "webhook channel with no webhookUrl configured" } });
      return;
    }
    const body = JSON.stringify({ rule: rule.name, event: sample.kind, agent: sample.agentId, ts: sample.ts, count: payload["count"] });
    let lastMessage = "";
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchFn(rule.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
        if (!res.ok) throw new Error(`webhook responded ${res.status}`);
        this.opts.events.append({ agentId: "notify", kind: "notify", data: payload });
        return;
      } catch (err) {
        lastMessage = String((err as Error)?.message ?? err);
        if (attempt < WEBHOOK_MAX_ATTEMPTS) await this.delay(WEBHOOK_RETRY_BASE_MS * attempt);
      }
    }
    // Never blocks/throws — the webhook failing is only ever an agentId:"notify" log line.
    this.opts.events.append({ agentId: "notify", kind: "notify_error", data: { ...payload, message: lastMessage, attempts: WEBHOOK_MAX_ATTEMPTS } });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimer(() => resolve(), ms));
  }

  // PLAN-HOOKS.md §3.2 (HOOK-4): the HookEngine `channel` action's delivery seam — reuses this
  // evaluator's deliver machinery (a2a tree-resolution, webhook retry+backoff, notify/notify_error
  // audit events) for a ONE-OFF delivery that isn't backed by a config NotifyRule at all. No
  // throttle window (HookEngine owns its own rate limiting, §3.3) — this always delivers
  // immediately, mirroring test()'s bypass-the-window posture.
  deliverChannel(channel: NotifyRule["channel"], sample: NormalizedEvent, opts: { name: string; webhookUrl?: string }): void {
    const rule: NotifyRule = { name: opts.name, on: { kind: sample.kind }, channel, webhookUrl: opts.webhookUrl, throttleSec: 0, enabled: true };
    this.deliver(rule, sample, 1);
  }

  // notify.test {rule}: fires a synthetic sample through the named rule's channel
  // immediately — bypasses the throttle window entirely (this is an on-demand probe, not a
  // real event match).
  test(name: string): { ok: true } {
    const rule = this.rules.find((r) => r.name === name);
    if (!rule) throw new UnknownNotifyRuleError(`unknown notify rule "${name}"`);
    // rule.on.kind is a loose string (NotifyRuleSchema, by design — see the class doc), so a
    // cast is needed to build a synthetic NormalizedEvent for the delivery path.
    const sample: NormalizedEvent = { ts: Date.now(), seq: -1, engineId: "local", agentId: "notify:test", kind: rule.on.kind as NormalizedEvent["kind"], data: { sample: true } };
    this.deliver(rule, sample, 1);
    return { ok: true };
  }
}
