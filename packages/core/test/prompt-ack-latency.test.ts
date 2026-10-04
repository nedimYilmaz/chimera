// F09 acceptance A12: prompt-ack-latency.mjs classifies deliveries and computes latency
// correctly against a hand-built fixture. Runs the script as a real subprocess (it is a
// standalone CLI with zero runtime dependency on packages/*/src) and asserts its JSON sidecar.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts/prompt-ack-latency.mjs");
const FIXTURES_DIR = join(TEST_DIR, "fixtures");

function runScript() {
  const stdout = execFileSync(
    process.execPath,
    [SCRIPT, "--events", FIXTURES_DIR, "--stdout"],
    { encoding: "utf8" },
  );
  return JSON.parse(stdout);
}

describe("prompt-ack-latency.mjs", () => {
  it("emits the frozen JSON sidecar shape with no extra top-level keys", () => {
    const report = runScript();
    expect(Object.keys(report).sort()).toEqual(
      ["schemaVersion", "generatedAt", "eventsHome", "window", "idle", "midTurn", "orphans", "recommended"].sort(),
    );
  });

  it("classifies a fast idle delivery and a slow idle delivery correctly (acceptance A12)", () => {
    const report = runScript();
    // agentIdle1: 400, 400, 300; agentIdle2: 6500, 150, 25000 (the slow one)
    expect(report.idle.n).toBe(6);
    expect(report.idle.max).toBe(25000);
    expect(report.idle.p50).toBe(400);
  });

  it("never lands a mid-turn delivery in the idle population", () => {
    const report = runScript();
    // agentMid: 5000 (resolved by tool_result), 200 (resolved by compaction) — both mid-turn only
    expect(report.midTurn.n).toBe(2);
    expect(report.midTurn.max).toBe(5000);
    expect(report.midTurn.p50).toBe(200);
  });

  it("flags a delivery with no following stream event as an orphan from the idle state", () => {
    const report = runScript();
    expect(report.orphans.total).toBe(1);
    expect(report.orphans.fromIdle).toBe(1);
    expect(report.orphans.fromMidTurn).toBe(0);
  });

  it("computes idle threshold coverage matching the fixture's hand-computed distribution", () => {
    const report = runScript();
    // idle sorted: [150, 300, 400, 400, 6500, 25000]
    expect(report.idle.coverage["5000"]).toBeCloseTo(4 / 6, 6);
    expect(report.idle.coverage["10000"]).toBeCloseTo(5 / 6, 6);
    expect(report.idle.coverage["30000"]).toBe(1);
  });

  it("recommends per the coverage-threshold policy and computes the false-signal rate off the idle population", () => {
    const report = runScript();
    // Smallest coverage bucket at or under a 2% false-signal rate: 30000 is the first bucket at
    // 100% coverage in this fixture's tiny population (F09 QA item 1's derivation policy).
    expect(report.recommended.promptStallMs).toBe(30000);
    // p90 of [150, 300, 400, 400, 6500, 25000], rounded to the nearest second, is the max itself.
    expect(report.recommended.promptAckWaitMs).toBe(25000);
    expect(report.recommended.falseSignalRateAtStall).toBe(0);
  });
});
