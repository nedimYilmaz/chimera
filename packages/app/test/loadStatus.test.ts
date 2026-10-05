import { describe, expect, it } from "vitest";
import { createLoadStatus, runLoad } from "../src/state/loadStatus";

// A refresh can be superseded while it is in flight (retry click, reconnect edge, a mutation's
// follow-up reload).  These cover the contract the screens rely on: only the NEWEST load may write
// data or status, a failed refresh keeps `loaded`, and a bug in `apply` is never reported as a
// daemon failure.

function defer<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("runLoad / createLoadStatus", () => {
  it("drops an older response that resolves AFTER the newer load already applied", async () => {
    const status = createLoadStatus();
    const older = defer<string>();
    const newer = defer<string>();
    const applied: string[] = [];
    const first = runLoad(status, () => older.promise, (v) => applied.push(v));
    const second = runLoad(status, () => newer.promise, (v) => applied.push(v));

    newer.resolve("new");
    await second;
    older.resolve("old");
    await first;

    expect(applied).toEqual(["new"]);
    expect(status.getState()).toEqual({ loaded: true, loading: false, error: null, unsupported: false });
  });

  it("an older FAILURE arriving after a newer success cannot flag the fresh data as stale", async () => {
    const status = createLoadStatus();
    const older = defer<string>();
    const first = runLoad(status, () => older.promise, () => {});
    await runLoad(status, async () => "fresh", () => {});

    older.reject({ code: "transport", message: "socket closed" });
    await first;

    expect(status.getState().error).toBeNull();
    expect(status.getState().loaded).toBe(true);
  });

  it("keeps `loaded` (rows are stale, not absent) and the last error text across a failed refresh", async () => {
    const status = createLoadStatus();
    await runLoad(status, async () => 1, () => {});
    // the bridge rejects with plain {code,message} objects, not Error instances
    await runLoad(status, () => Promise.reject({ code: "transport", message: "daemon busy" }), () => {});

    expect(status.getState()).toEqual({ loaded: true, loading: false, error: "daemon busy", unsupported: false });
  });

  it("keeps the previous error visible while a retry is in flight (no flicker), then clears it on success", async () => {
    const status = createLoadStatus();
    await runLoad(status, () => Promise.reject(new Error("boom")), () => {});
    const retry = defer<number>();
    const running = runLoad(status, () => retry.promise, () => {});

    expect(status.getState()).toMatchObject({ loading: true, error: "boom" });
    retry.resolve(2);
    await running;
    expect(status.getState()).toMatchObject({ loading: false, error: null, loaded: true });
  });

  it("classifies an unsupported method as a stable capability fact, not a retryable error", async () => {
    const status = createLoadStatus();
    let unsupportedCalls = 0;
    await runLoad(
      status,
      () => Promise.reject({ code: "protocol", message: "unknown method role.list" }),
      () => { throw new Error("apply must not run for an unsupported method"); },
      { isUnsupported: () => true, onUnsupported: () => { unsupportedCalls += 1; } },
    );

    expect(unsupportedCalls).toBe(1);
    expect(status.getState()).toEqual({ loaded: true, loading: false, error: null, unsupported: true });
  });

  it("does not report an exception thrown by `apply` as a daemon failure", async () => {
    const status = createLoadStatus();
    await expect(
      runLoad(status, async () => "rows", () => { throw new Error("reducer bug"); }),
    ).rejects.toThrow("reducer bug");

    expect(status.getState().error).toBeNull();
    expect(status.getState().loaded).toBe(false);
  });

  it("reset() invalidates an in-flight load so a stale reply cannot repopulate a reset screen", async () => {
    const status = createLoadStatus();
    const pending = defer<string>();
    const applied: string[] = [];
    const running = runLoad(status, () => pending.promise, (v) => applied.push(v));

    status.reset();
    pending.resolve("late");
    await running;

    expect(applied).toEqual([]);
    expect(status.getState()).toEqual({ loaded: false, loading: false, error: null, unsupported: false });
  });

  // The Tauri driver settles in-flight calls with {code:"disconnected"} when the socket drops, but a
  // response it had ALREADY resolved can still be delivered after the state event.  Without
  // interrupt() that reply is the newest load, so it would pass the generation check and present
  // pre-drop data as fresh while no reconnect load has started.
  describe("interrupt (connection dropped)", () => {
    it("a reply that lands after the drop is not applied, and the in-flight load reads as failed-but-loaded", async () => {
      const status = createLoadStatus();
      await runLoad(status, () => Promise.resolve(["a"]), () => {});
      const pending = defer<string[]>();
      const applied: string[][] = [];
      const running = runLoad(status, () => pending.promise, (v) => applied.push(v));

      status.interrupt("connection lost");
      pending.resolve(["pre-drop"]);
      await running;

      expect(applied).toEqual([]);
      expect(status.getState()).toEqual({ loaded: true, loading: false, error: "connection lost", unsupported: false });
    });

    it("a rejection that lands after the drop cannot overwrite the interrupt message", async () => {
      const status = createLoadStatus();
      const pending = defer<string>();
      const running = runLoad(status, () => pending.promise, () => {});

      status.interrupt("connection lost");
      pending.reject({ code: "disconnected", message: "chimerad connection closed" });
      await running;

      expect(status.getState()).toEqual({ loaded: false, loading: false, error: "connection lost", unsupported: false });
    });

    it("an idle status is left exactly as it was — the rows are still the last good ones", async () => {
      const status = createLoadStatus();
      await runLoad(status, () => Promise.resolve("ok"), () => {});
      const before = status.getState();

      status.interrupt("connection lost");

      expect(status.getState()).toEqual(before);
      expect(status.getState().error).toBeNull();
    });

    it("the load started after the interrupt (the reconnect reload) applies normally and clears the error", async () => {
      const status = createLoadStatus();
      const dropped = defer<string>();
      const applied: string[] = [];
      const first = runLoad(status, () => dropped.promise, (v) => applied.push(v));
      status.interrupt("connection lost");

      await runLoad(status, () => Promise.resolve("fresh"), (v) => applied.push(v));
      dropped.resolve("stale");
      await first;

      expect(applied).toEqual(["fresh"]);
      expect(status.getState()).toEqual({ loaded: true, loading: false, error: null, unsupported: false });
    });
  });
});
