// BACKEND-KIT: shared queue/interrupt/grace/AbortController mechanics extracted from
// backends/codex.ts and backends/generic.ts, which independently hand-rolled the identical
// "await next queued input, abort the in-flight turn on interrupt(), wait up to graceMs for a
// follow-up send() before idling out" loop. claude.ts is NOT built on this: it drives the Claude
// Agent SDK's own streaming AsyncQueue input and delegates interrupt() to the SDK's own
// stream.interrupt() — a different shape, out of scope here.
//
// Deliberately does NOT own a `send()`-after-ended throw: each backend checks `.ended`/`.closed`
// itself so queue mechanics stay provider-neutral.
export type TurnLoopOptions = { graceMs?: number };

export class InterruptibleTurnLoop<T = string> {
  private queue: T[] = [];
  private killedFlag = false;
  private interruptedFlag = false;
  private interruptGraceFlag = false;
  private closedFlag = false;
  private endedFlag = false;
  private wake: (() => void) | null = null;
  private currentController: AbortController | null = null;
  readonly graceMs: number;

  constructor(opts: TurnLoopOptions = {}) {
    this.graceMs = opts.graceMs ?? 250;
  }

  get killed(): boolean {
    return this.killedFlag;
  }

  get ended(): boolean {
    return this.endedFlag;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  // Call at the top of each turn; replaces `controller = new AbortController()`. The returned
  // controller's `.signal` is what the caller threads into its SDK/fetch call for this turn.
  beginTurn(): AbortController {
    this.currentController = new AbortController();
    return this.currentController;
  }

  // Synchronous, non-blocking queue pop — deliberately NOT async. Both migrated backends spawn
  // their run() loop with a synchronously pre-seeded first input and rely on JS running that
  // loop synchronously up to its first REAL await (the SDK/fetch call) before yielding control
  // back to spawn()'s caller — an `async shift()` wrapped in `await` would add a microtask tick
  // even on this already-available fast path and desync interrupt()-called-immediately-after-
  // spawn() from the turn's AbortController actually existing yet (caught by
  // codex-backend.test.ts's "recovers from a mid-turn interrupt" case).
  shift(): T | undefined {
    return this.queue.shift();
  }

  // Non-destructive FIFO snapshot, so a caller can decide how much of the queue to drain into one
  // turn (via shift()) without having to push a non-matching input back to the front.
  pending(): readonly T[] {
    return [...this.queue];
  }

  // True right after consumeInterrupt() armed the grace window, until either a follow-up push()
  // arrives or waitForNext() below times out. Callers check this only after shift() returns
  // undefined, exactly mirroring the original inlined `if (prompt === undefined && interruptGrace)`.
  get armed(): boolean {
    return this.interruptGraceFlag;
  }

  // Only call when shift() just returned undefined AND `armed` is true. Waits up to graceMs for
  // a follow-up push() (which wakes it early), then makes one more shift() attempt. Caller must
  // check `.killed` immediately after awaiting this, before acting on the resolved value — kill()
  // wakes this promise too, without guaranteeing the re-shift below is meaningful.
  async waitForNext(): Promise<T | undefined> {
    await new Promise<void>((resolve) => {
      this.wake = resolve;
      setTimeout(resolve, this.graceMs);
    });
    this.wake = null;
    this.interruptGraceFlag = false;
    return this.queue.shift();
  }

  // Persistent/conductor sessions wait indefinitely between turns instead of applying the
  // short interrupt-recovery grace window. push(), close(), and kill() all wake this wait;
  // undefined therefore means the input was explicitly closed/killed, never a mere idle gap.
  async waitForInput(): Promise<T | undefined> {
    const queued = this.queue.shift();
    if (queued !== undefined || this.killedFlag || this.closedFlag) return queued;
    await new Promise<void>((resolve) => { this.wake = resolve; });
    this.wake = null;
    return this.queue.shift();
  }

  // Called from the catch block around a turn's stream. Returns true (and arms the grace window
  // for the NEXT shift()/waitForNext() pair) iff the just-caught error was this loop's own
  // interrupt-caused abort — the caller should then sink its own turn_complete{interrupted:true}
  // and `continue` its loop rather than rethrow. Returns false for any other error (caller should
  // rethrow).
  consumeInterrupt(): boolean {
    if (!this.interruptedFlag) return false;
    this.interruptedFlag = false;
    this.interruptGraceFlag = true;
    return true;
  }

  push(text: T): void {
    this.queue.push(text);
    this.wake?.();
  }

  interrupt(): void {
    this.interruptedFlag = true;
    this.currentController?.abort();
  }

  kill(): void {
    this.killedFlag = true;
    this.currentController?.abort();
    this.wake?.();
  }

  // Graceful input close: an in-flight turn may finish, but an idle persistent loop wakes and
  // exits. Unlike kill(), this does not abort the provider request already in progress.
  close(): void {
    this.closedFlag = true;
    this.wake?.();
  }

  // LATE-MESSAGE-RESUME marker: call once the run loop has left for good (natural end, kill, or
  // an unrecoverable error) so a send() arriving after that point can be told the input stream is
  // closed rather than silently queuing into an array nothing will ever drain again.
  end(): void {
    this.endedFlag = true;
  }
}
