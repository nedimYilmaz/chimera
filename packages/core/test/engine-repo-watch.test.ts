import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { RepoWatcher } from "@chimera/core/repo-watch";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// HOOK-5 (engine.ts boot wiring, INTEGRATION gap): the Engine constructs a RepoWatcher,
// forwards it into SupervisorDeps.repoWatcher, and seeds it with the REAL project list
// (seedProjects(this.projects.list())) once ProjectStore has loaded. RepoWatcher's own
// behavior is covered in repo-watch*.test.ts; this file pins only that the Engine actually
// wires the seam in and seeds it at boot.

const HAPPY: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "ok" } }];

function engineOn(home: string, scenarios: FakeStep[][] = [HAPPY]): Engine {
  return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]) });
}

function makeDir(): string { return mkdtempSync(join(tmpdir(), "chimera-engine-repowatch-")); }

describe("Engine: RepoWatcher boot wiring (HOOK-5)", () => {
  it("constructs and exposes a RepoWatcher instance", () => {
    const engine = engineOn(makeEngineHome());
    expect(engine.repoWatcher).toBeInstanceOf(RepoWatcher);
  });

  it("seeds the watcher with the project list at boot (empty home ⇒ seeded with [])", () => {
    const seedSpy = vi.spyOn(RepoWatcher.prototype, "seedProjects");
    try {
      const engine = engineOn(makeEngineHome());
      expect(seedSpy).toHaveBeenCalledTimes(1);
      expect(seedSpy).toHaveBeenCalledWith(engine.projects.list());
      expect(engine.projects.list()).toEqual([]);
    } finally {
      seedSpy.mockRestore();
    }
  });

  it("seeds the watcher with the REAL registered project list at boot", async () => {
    const home = makeEngineHome();
    // Register a project on THIS home first (persisted to projects.json).
    const bootstrap = engineOn(home);
    await bootstrap.handle("project.create", { name: "alpha", path: makeDir(), autoConductor: false });

    // A fresh Engine on the same home loads that project and must seed the watcher with it.
    const seedSpy = vi.spyOn(RepoWatcher.prototype, "seedProjects");
    try {
      const engine = engineOn(home);
      expect(seedSpy).toHaveBeenCalledTimes(1);
      const seeded = seedSpy.mock.calls[0]![0];
      expect(seeded).toEqual(engine.projects.list());
      expect(seeded.map((p) => p.name)).toContain("alpha");
    } finally {
      seedSpy.mockRestore();
    }
  });

  it("forwards repoWatcher into SupervisorDeps — a worktree spawn registers a watch on the exposed instance", async () => {
    const engine = engineOn(makeEngineHome());
    const watchSpy = vi.spyOn(engine.repoWatcher, "watch");
    const rec = (await engine.handle("agent.spawn", {
      spec: { prompt: "x", cwd: "/tmp/wt-engine", account: "main", isolation: "worktree" },
    })) as { agentId: string };
    expect(watchSpy).toHaveBeenCalledWith("/tmp/wt-engine", rec.agentId);
  });

  it("an isolation:none spawn does NOT register a watch on the exposed instance", async () => {
    const engine = engineOn(makeEngineHome());
    const watchSpy = vi.spyOn(engine.repoWatcher, "watch");
    await engine.handle("agent.spawn", {
      spec: { prompt: "x", cwd: "/tmp/none-engine", account: "main", isolation: "none" },
    });
    expect(watchSpy).not.toHaveBeenCalled();
  });
});
