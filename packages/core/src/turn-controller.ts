// R2-TURN-LIFECYCLE: a small, backend-agnostic watchdog over ONE turn's LLM/SDK stream call.
// Deliberately NOT folded into backend-kit.ts's InterruptibleTurnLoop -- that class already
// owns queue/interrupt/grace/AbortController mechanics for generic.ts/codex.ts specifically,
// and claude.ts isn't built on it at all (drives the Claude Agent SDK's own streaming input,
// no AbortController of its own -- see backend-kit.ts's header comment). Each backend composes
// TurnController with its own turn mechanics instead: generic.ts/codex.ts wire onTimeout to
// `controller.abort()` on the SAME AbortController their InterruptibleTurnLoop.beginTurn()
// already produces (genuine hard-cancel); claude.ts wires it to a best-effort teardown (same
// posture as its existing kill(), which also can't forcibly abort an in-flight SDK stream).
//
// idleTimeoutMs and maxDurationMs are deliberately independent, opt-in knobs with no universal
// safe default: a long but legitimate wait (e.g. the ask_human MCP tool blocking on a human, or
// a slow build tool call) can validly outlast any fixed idle window, and callers that need one
// must choose a value that fits their own use case. Absent (undefined/0) means that timer is
// simply never armed -- byte-identical to today's unbounded behavior.
export type TurnTimeoutReason = "idle" | "max-duration";
export type TurnControllerOptions = { idleTimeoutMs?: number; maxDurationMs?: number };

export class TurnController {
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private reasonFlag: TurnTimeoutReason | null = null;
  private onTimeoutCb: ((reason: TurnTimeoutReason) => void) | null = null;
  private turnStartedAt = 0;

  constructor(private readonly opts: TurnControllerOptions) {}

  // Arms both timers for one turn. `onTimeout` fires at most once per turn (first writer wins
  // if idle and max-duration would fire near-simultaneously) -- typically wired to
  // `controller.abort()` or an equivalent best-effort teardown. Safe to call again without an
  // intervening endTurn() (always clears any previous turn's timers first) -- claude.ts's
  // send()-driven re-arming relies on this idempotency, since it can't always guarantee a clean
  // endTurn() between two logical turns.
  beginTurn(onTimeout: (reason: TurnTimeoutReason) => void): void {
    this.clearTimers();
    this.reasonFlag = null;
    this.onTimeoutCb = onTimeout;
    this.turnStartedAt = Date.now();
    // maxDurationMs is a hard budget, not a sliding window -- set once here, never rearmed.
    if (this.opts.maxDurationMs) {
      this.maxTimer = setTimeout(() => this.fire("max-duration"), this.opts.maxDurationMs);
    }
    this.armIdle();
  }

  private armIdle(): void {
    if (!this.opts.idleTimeoutMs) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.fire("idle"), this.opts.idleTimeoutMs);
  }

  private fire(reason: TurnTimeoutReason): void {
    if (this.reasonFlag) return;   // already fired -- first writer wins (idle/max race)
    this.reasonFlag = reason;
    this.clearTimers();
    this.onTimeoutCb?.(reason);
  }

  // Call on every unit of turn activity (one stream event / SDK message, regardless of type)
  // to slide the idle window forward. No-op once a timeout has already fired, or when idle
  // detection is disabled.
  heartbeat(): void {
    if (this.reasonFlag) return;
    this.armIdle();
  }

  // Call in the turn's `finally` -- clears any pending timers so a turn that ends normally (or
  // via a real user interrupt) never fires a stale timeout into the NEXT turn. Does NOT clear
  // reasonFlag: callers must read it via consumeTimeout() in the catch block BEFORE calling
  // this in finally, mirroring InterruptibleTurnLoop's consumeInterrupt()/lifecycle discipline.
  endTurn(): void {
    this.clearTimers();
    this.onTimeoutCb = null;
  }

  private clearTimers(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null; }
  }

  // Read-once, mirrors InterruptibleTurnLoop.consumeInterrupt(): true (well, non-null) iff the
  // just-caught error was THIS controller's own timeout-triggered abort.
  consumeTimeout(): TurnTimeoutReason | null {
    const r = this.reasonFlag;
    this.reasonFlag = null;
    return r;
  }

  get elapsedMs(): number {
    return this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
  }
}
