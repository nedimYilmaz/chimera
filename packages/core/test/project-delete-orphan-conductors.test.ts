import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ORPHANED-CONDUCTOR-BLOCKS-DELETE: archive/delete tore down only the conductor the project spec
// currently POINTS at. Every earlier conductor whose id was overwritten by the next spawn stayed
// running and blocked the delete forever — the operator was told to "kill or finish" sessions
// they never created, and the projects screen (project.status ensures a conductor on a READ) kept
// minting more. Observed live: 272 conductors under one project, delete refused every time.

const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend(
  Array.from({ length: 12 }, () => [{ awaitSend: true }]),
)]]);
const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const project = async (e: Engine, name: string): Promise<string> => {
  const path = mkdtempSync(join(tmpdir(), "chimera-proj-"));
  await e.handle("project.create", { name, path });
  return path;
};

describe("project.delete with orphaned conductors", () => {
  it("tears down EVERY conductor it created, not just the one the spec points at", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const path = await project(e, "evetle");

    // The pointer's conductor, plus two ORPHANS: conductors created for this project whose ids
    // the spec no longer holds. That is exactly what the spawn loop left behind — each new spawn
    // overwrote setConductorId, and the previous record kept running unreferenced.
    await e.handle("project.conductor.start", { name: "evetle" });
    for (let i = 0; i < 2; i++) {
      await e.supervisor.spawn(
        { prompt: `(auto-created conductor for project "evetle")`, cwd: path, isolation: "none", conductor: true },
        { projectId: "evetle" },
      );
    }
    await flush();
    const conductors = e.supervisor.list().filter((a) => a.spec.conductor && a.spec.cwd === path);
    expect(conductors).toHaveLength(3);
    expect(conductors.every((a) => a.state === "running" || a.state === "paused")).toBe(true);

    expect(await e.handle("project.delete", { name: "evetle" })).toMatchObject({ deleted: true });
    for (const c of conductors) expect(["done", "failed", "killed"]).toContain(e.supervisor.status(c.agentId).state);
  });

  it("still refuses for REAL work under the path, and names it so the operator can act", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const path = await project(e, "evetle");
    await e.handle("agent.spawn", { spec: { prompt: "real work", cwd: path, isolation: "none", displayLabel: "worker-1" } });
    await flush();

    await expect(e.handle("project.delete", { name: "evetle" })).rejects.toThrow(/worker-1/);
    // the refusal must name the blocker — "has 1 live session(s)" was unactionable in a fleet
    // where every row carries the same label
    await expect(e.handle("project.delete", { name: "evetle" })).rejects.toThrow(/live session/);
  });
});
