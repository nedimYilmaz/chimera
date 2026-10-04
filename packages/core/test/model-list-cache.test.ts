import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelListCache } from "@chimera/core/providers/model-list-cache";

const dir = () => mkdtempSync(join(tmpdir(), "chimera-modellists-"));
const SONNET = { value: "sonnet", displayName: "Sonnet", description: "fast" };
const OPUS = { value: "opus", displayName: "Opus" };

describe("ModelListCache", () => {
  it("round-trips a provider's list and SURVIVES a restart — the whole point over the old in-memory cache", () => {
    const d = dir();
    new ModelListCache(d).set("claude", [SONNET, OPUS]);
    // a second instance is a fresh daemon process reading the same CHIMERA_HOME
    expect(new ModelListCache(d).get("claude")).toEqual([SONNET, OPUS]);
  });

  it("keeps providers independent", () => {
    const d = dir();
    const c = new ModelListCache(d);
    c.set("claude", [SONNET]);
    c.set("kimi", [{ value: "kimi-code/k3", displayName: "K3" }]);
    expect(new ModelListCache(d).get("kimi")).toEqual([{ value: "kimi-code/k3", displayName: "K3" }]);
    expect(new ModelListCache(d).get("claude")).toEqual([SONNET]);
  });

  it("ignores an empty list — a FAILED probe must never blank a good entry", () => {
    const d = dir();
    const c = new ModelListCache(d);
    c.set("claude", [SONNET]);
    c.set("claude", []);
    expect(c.get("claude")).toEqual([SONNET]);
  });

  it("reports staleness against the TTL, so a caller knows when to re-probe", () => {
    const d = dir();
    let now = 1_000_000;
    const c = new ModelListCache(d, { ttlMs: 1000, now: () => now });
    expect(c.isStale("claude")).toBe(true);      // nothing learned yet
    c.set("claude", [SONNET]);
    expect(c.isStale("claude")).toBe(false);
    now += 1001;
    expect(c.isStale("claude")).toBe(true);
    expect(c.get("claude")).toEqual([SONNET]);   // stale still beats the static catalog
  });

  it("treats a corrupt or foreign-version file as an empty cache rather than throwing", () => {
    const d = dir();
    writeFileSync(join(d, "model-lists.json"), "{not json");
    expect(new ModelListCache(d).get("claude")).toBeNull();
    writeFileSync(join(d, "model-lists.json"), JSON.stringify({ version: 99, providers: { claude: { models: [SONNET] } } }));
    expect(new ModelListCache(d).get("claude")).toBeNull();
  });

  it("persists atomically and human-readably (an operator can inspect what a picker will show)", () => {
    const d = dir();
    new ModelListCache(d).set("codex", [{ value: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" }]);
    const doc = JSON.parse(readFileSync(join(d, "model-lists.json"), "utf8"));
    expect(doc.version).toBe(1);
    expect(doc.providers.codex.models[0].value).toBe("gpt-5.6-sol");
    expect(typeof doc.providers.codex.fetchedAt).toBe("number");
  });
});
