import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../src/engine.js";
import { FakeAgentBackend } from "../src/backends/fake.js";
import type { MemoryRecord, MemoryStatsResult } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

function engineAt(home: string) {
  return new Engine({ home, backends: new Map([["claude", new FakeAgentBackend([])]]) });
}
function stats(engine: Engine) { return engine.handle("memory.stats", {}) as Promise<MemoryStatsResult>; }
function add(engine: Engine, text: string) {
  return engine.handle("memory.add", { author: "agent", text }) as Promise<MemoryRecord>;
}

describe("Engine memory.maxRecords config", () => {
  it("defaults old configs, wires startup and applies capacity patches live without losing notes", async () => {
    const home = makeEngineHome();
    expect((await stats(engineAt(home))).capacity.limit).toBe(10_000);
    const configFile = join(home, "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    writeFileSync(configFile, JSON.stringify({ ...config, memory: { maxRecords: 2, embedder: "off" } }));
    const engine = engineAt(home);
    expect((await stats(engine)).capacity.limit).toBe(2);
    const a = await add(engine, "first retained fact");
    const b = await add(engine, "second retained fact");
    await engine.handle("config.patch", { patch: { memory: { maxRecords: 1, evictionAlarmAt: 0.5 } } });
    expect((await stats(engine)).capacity).toMatchObject({ total: 2, limit: 1, alarmAt: 0.5 });
    expect(existsSync(join(home, "memory-evicted.jsonl"))).toBe(false);
    await expect(add(engine, "blocked over reduced bound")).rejects.toMatchObject({ code: "conflict" });
    await engine.handle("memory.edit", { id: a.id, pinned: true });
    const rebooted = engineAt(home);
    expect((await stats(rebooted)).capacity).toMatchObject({ total: 2, limit: 1, pinned: 1 });
    await expect(add(rebooted, "blocked after reboot")).rejects.toMatchObject({ code: "conflict" });
    await rebooted.handle("config.patch", { patch: { memory: { maxRecords: 3 } } });
    await add(rebooted, "accepted after capacity increase");
    expect((await stats(rebooted)).capacity).toMatchObject({ total: 3, limit: 3 });
    expect(rebooted.memory.get(b.id).record.text).toBe("second retained fact");
  });

  it("rejects invalid capacity patches before persisting or applying any config", async () => {
    const home = makeEngineHome();
    const engine = engineAt(home);
    await engine.handle("config.patch", { patch: { memory: { maxRecords: 2000 } } });
    const overlay = join(home, "config.d", "ui.json");
    const before = readFileSync(overlay, "utf8");
    for (const maxRecords of [0, -1, 2.5, 100_001, "10000", false]) {
      await expect(engine.handle("config.patch", { patch: { memory: { maxRecords } } }))
        .rejects.toMatchObject({ code: "protocol" });
      expect(readFileSync(overlay, "utf8")).toBe(before);
      expect((await stats(engine)).capacity.limit).toBe(2000);
    }
    // JSON Merge Patch null removes the override and re-applies the default live.
    await engine.handle("config.patch", { patch: { memory: { maxRecords: null } } });
    expect((await stats(engine)).capacity.limit).toBe(10_000);
  });

  it("applies watcher reload capacity without eviction or a restart", async () => {
    const home = makeEngineHome();
    const engine = engineAt(home);
    const file = join(home, "config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    await add(engine, "watcher retained one");
    await add(engine, "watcher retained two");
    writeFileSync(file, JSON.stringify({ ...config, memory: { maxRecords: 1, embedder: "off" } }));
    engine.reloadConfig();
    expect((await stats(engine)).capacity).toMatchObject({ total: 2, limit: 1 });
    await expect(add(engine, "watcher rejects growth")).rejects.toMatchObject({ code: "conflict" });
  });
});
