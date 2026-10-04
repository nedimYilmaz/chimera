import { describe, expect, it } from "vitest";
import { singleFlight } from "../src/state/singleFlight";

describe("singleFlight", () => {
  it("starts a fresh round once the trailing one has finished", async () => {
    let runs = 0;
    const releases: Array<() => void> = [];
    const go = singleFlight(() => { runs++; return new Promise<void>((r) => releases.push(r)); });
    const a = go(); const b = go(); const c = go();
    expect(runs).toBe(1);
    expect(b).toBe(c);
    releases[0]!(); await a;
    await Promise.resolve();
    expect(runs).toBe(2);
    releases[1]!(); await b;
    const d = go();
    expect(runs).toBe(3);
    releases[2]!(); await d;
  });

  it("keeps working after a round rejects", async () => {
    let runs = 0;
    const go = singleFlight(async () => { runs++; if (runs === 1) throw new Error("boom"); });
    await expect(go()).rejects.toThrow("boom");
    await go();
    expect(runs).toBe(2);
  });

  it("still runs the trailing round when the round in flight rejects", async () => {
    let runs = 0;
    let fail: (e: Error) => void = () => {};
    const go = singleFlight(() => { runs++; return runs === 1 ? new Promise<void>((_, rej) => { fail = rej; }) : Promise.resolve(); });
    const first = go(); const second = go();
    fail(new Error("transient"));
    await expect(first).rejects.toThrow("transient");
    await second;
    expect(runs).toBe(2);
  });
});
