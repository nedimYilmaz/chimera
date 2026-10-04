import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// CONDUCTOR-SPAWN-RUNAWAY: project.status calls ensureProjectConductor, and the projects screen
// refreshes project.status — so a conductor that dies the instant it is born turns a passive
// screen into a spawn loop. Seen live: 272 conductors created in one project directory (183
// done, 87 killed) while the operator sat there trying to DELETE the project, every attempt
// refused because the loop had just created another "active" agent for the guard to trip over.

// Every scenario ends immediately — i.e. every conductor dies on arrival, the exact condition.
const dyingBackends = () => new Map<string, AgentBackend>([
  ["claude", new FakeAgentBackend(Array.from({ length: 50 }, () => [{ end: { resultText: "" } }]))],
]);
const newDir = (): string => mkdtempSync(join(tmpdir(), "chimera-brake-"));
const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function conductorsIn(e: Engine): Promise<number> {
  const l = (await e.handle("agent.list", { lite: true })) as Array<Record<string, unknown>>;
  return l.filter((a) => (a["spec"] as { conductor?: boolean } | undefined)?.conductor === true).length;
}

describe("automatic conductor spawning cannot run away", () => {
  it("stops re-spawning after repeated die-on-arrival, however many times a read asks", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: dyingBackends() });
    await e.handle("project.create", { name: "p", path: newDir() });
    await flush();

    // A passive screen refreshing project.status over and over.
    for (let i = 0; i < 12; i++) {
      await e.handle("project.status", { name: "p" }).catch(() => {});
      await flush(5);
    }

    // Without the brake this grows with every read; with it, it stops at the threshold.
    expect(await conductorsIn(e)).toBeLessThanOrEqual(4);
  });

  it("an EXPLICIT start still works and clears the brake — the guard never locks the operator out", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: dyingBackends() });
    await e.handle("project.create", { name: "p", path: newDir() });
    await flush();
    for (let i = 0; i < 8; i++) { await e.handle("project.status", { name: "p" }).catch(() => {}); await flush(5); }

    // the automatic path is braked...
    const before = await conductorsIn(e);
    await e.handle("project.status", { name: "p" }).catch(() => {});
    await flush();
    expect(await conductorsIn(e)).toBeLessThanOrEqual(before + 1);

    // ...but asking by name is always honoured
    await e.handle("project.conductor.start", { name: "p" });
    await flush();
    expect(await conductorsIn(e)).toBeGreaterThan(before);
  });

  it("a HEALTHY conductor is reused, never re-spawned — the brake changes nothing for the normal case", async () => {
    const e = new Engine({
      home: makeEngineHome(),
      backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([[{ awaitSend: true }], [{ awaitSend: true }]])]]),
    });
    await e.handle("project.create", { name: "ok", path: newDir() });
    await flush();
    const first = await conductorsIn(e);
    for (let i = 0; i < 5; i++) { await e.handle("project.status", { name: "ok" }); await flush(5); }
    expect(await conductorsIn(e)).toBe(first);
  });
});
