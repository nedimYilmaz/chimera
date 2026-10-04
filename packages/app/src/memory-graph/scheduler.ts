// MEM-6 §5.3 — the on-demand rАF scheduler. THE load-bearing piece of the
// "zero idle rAF work" acceptance: a frame is scheduled ONLY while something is
// actually moving (sim warm, an interaction, or a transition). The tick callback
// returns whether more frames are needed; the moment it returns false the loop
// stops and schedules nothing until `wake()` is called again. No idle timer, no
// perpetual requestAnimationFrame — idle CPU is genuinely 0.
//
// raf/caf are injectable so the state machine is unit-testable without a DOM.
export type Raf = (cb: (now: number) => void) => number;
export type Caf = (handle: number) => void;

export class FrameScheduler {
  private handle: number | null = null;
  private readonly raf: Raf;
  private readonly caf: Caf;
  /** Total frames actually run — the perf harness reads this to prove idle rAF
   *  count stops advancing after settle. */
  frameCount = 0;

  constructor(private readonly tick: (now: number) => boolean, raf?: Raf, caf?: Caf) {
    this.raf =
      raf ?? ((cb) => (typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame(cb) : 0));
    this.caf =
      caf ?? ((h) => {
        if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(h);
      });
  }

  /** Request that the loop run. Idempotent: a second wake() while a frame is
   *  already pending is a no-op (never double-schedules). */
  wake(): void {
    if (this.handle === null) this.handle = this.raf(this.loop);
  }

  private readonly loop = (now: number): void => {
    // Null the handle BEFORE ticking so a wake() triggered inside tick()
    // re-arms correctly instead of being swallowed as "already pending".
    this.handle = null;
    this.frameCount++;
    const keepGoing = this.tick(now);
    if (keepGoing && this.handle === null) this.handle = this.raf(this.loop);
  };

  /** Cancel any pending frame and go quiet. */
  stop(): void {
    if (this.handle !== null) {
      this.caf(this.handle);
      this.handle = null;
    }
  }

  /** Is a frame currently pending? (idle ⇒ false — the acceptance invariant). */
  isScheduled(): boolean {
    return this.handle !== null;
  }
}
