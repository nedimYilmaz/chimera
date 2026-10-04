import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { InMemoryKeychain } from "@chimera/core/keychain";
import { FakeAccountProber } from "@chimera/core/prober";
import { FakeAgentBackend } from "@chimera/core/backends/fake";

// EVENT-LOG-RETENTION: cfg.eventRetention (protocol's EventLogRetentionConfigSchema) must reach
// EventLog's constructor options, the same way cfg.durability already does — this covers the
// wiring in engine.ts, not EventLog's own rotation/pruning logic (see events-rotation.test.ts).
function makeHome(config: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "chm-evret-"));
  writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2));
  return home;
}

const BASE = {
  accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
  autoOrder: ["main"],
  dailyCapUsd: 5,
};

function makeEngine(home: string) {
  const backends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
  return new Engine({ home, backends, keychain: new InMemoryKeychain(), accountProber: new FakeAccountProber("ok") });
}

describe("EVENT-LOG-RETENTION: cfg.eventRetention wiring", () => {
  it("a config-less install behaves exactly as today (default bound applies)", () => {
    const home = makeHome(BASE);
    const engine = makeEngine(home);
    for (let i = 0; i < 12; i++) engine.events.append({ agentId: "a1", kind: "status", data: { i } });
    // default maxEventsPerSegment (5000) is far above 12 appends: no rotation yet, one active file.
    const names = readdirSync(join(home, "events"));
    expect(names.filter((n) => /^events\.\d+-\d+\.jsonl$/.test(n))).toHaveLength(0);
  });

  it("a configured eventRetention bound reaches EventLog and is honoured", () => {
    const home = makeHome({ ...BASE, eventRetention: { maxEventsPerSegment: 5, maxSegments: 2 } });
    const engine = makeEngine(home);
    for (let i = 0; i < 37; i++) engine.events.append({ agentId: "a1", kind: "status", data: { i } });

    const names = readdirSync(join(home, "events"));
    const sealed = names.filter((n) => /^events\.\d+-\d+\.jsonl$/.test(n));
    // proves the configured maxSegments (2), not the code default (60), governs pruning.
    expect(sealed.length).toBe(2);
  });
});
