import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TeamSpec } from "@chimera/protocol";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// PROJECT-NATIVE-TEAMS T4: wires T3's syncProjectTeam into the lifecycle itself
// (project.create/project.import, project.status focus) instead of requiring a
// manual call — see project-native-teams-sync.test.ts for syncProjectTeam's own
// merge/provenance behavior, exercised here only through the public RPC surface.

function engineOn(home: string): Engine {
  return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
}

function makeProjectDir(): string {
  return mkdtempSync(join(tmpdir(), "chimera-projnative-lc-"));
}

function writeAgentFile(projectPath: string, fileName: string, name: string, description: string): void {
  const agentsDir = join(projectPath, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, fileName), ["---", `name: ${name}`, `description: ${description}`, "---", "Body."].join("\n"));
}

function nativeTeam(e: Engine, project: string): TeamSpec | undefined {
  return (e as unknown as { teams: { list(): TeamSpec[] } }).teams.list().find((t) => t.projectNative === project);
}

describe("project-native team lifecycle wiring (T4)", () => {
  it("project.create on a repo shipping .claude/agents materializes + assigns its project-native team immediately", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProjectDir();
    writeAgentFile(path, "dev.md", "dev", "writes code");
    writeAgentFile(path, "qa.md", "qa", "tests code");

    const spec = (await e.handle("project.create", { name: "alpha", path, autoConductor: false })) as { teams: string[] };

    const team = nativeTeam(e, "alpha");
    expect(team).toBeDefined();
    expect(Object.keys(team!.roles).sort()).toEqual(["dev", "qa"]);
    expect(spec.teams).toEqual([team!.name]);
  });

  it("project.import (local path) on a repo shipping .claude/agents materializes + assigns its project-native team immediately", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProjectDir();
    writeAgentFile(path, "dev.md", "dev", "writes code");

    const spec = (await e.handle("project.import", { source: path, name: "beta" })) as { teams: string[] };

    const team = nativeTeam(e, "beta");
    expect(team).toBeDefined();
    expect(Object.keys(team!.roles)).toEqual(["dev"]);
    expect(spec.teams).toEqual([team!.name]);
  });

  it("project.create on a repo with NO .claude/agents creates no project-native team", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProjectDir();

    const spec = (await e.handle("project.create", { name: "alpha", path, autoConductor: false })) as { teams: string[] };

    expect(nativeTeam(e, "alpha")).toBeUndefined();
    expect(spec.teams).toEqual([]);
  });

  it("project.status re-syncs the project-native team after .claude/agents changes on disk", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProjectDir();
    writeAgentFile(path, "dev.md", "dev", "writes code");
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });
    expect(Object.keys(nativeTeam(e, "alpha")!.roles)).toEqual(["dev"]);

    writeAgentFile(path, "qa.md", "qa", "tests code");
    await e.handle("project.status", { name: "alpha" });

    expect(Object.keys(nativeTeam(e, "alpha")!.roles).sort()).toEqual(["dev", "qa"]);
  });

  it("project.status on a project with no .claude/agents never at all does nothing", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProjectDir();
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });

    await e.handle("project.status", { name: "alpha" });

    expect(nativeTeam(e, "alpha")).toBeUndefined();
  });

  it("a syncProjectTeam throw never breaks project.status", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProjectDir();
    writeAgentFile(path, "dev.md", "dev", "writes code");
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });

    (e as unknown as { syncProjectTeam(name: string): void }).syncProjectTeam = () => {
      throw new Error("boom");
    };
    writeAgentFile(path, "qa.md", "qa", "tests code");   // would otherwise trigger a re-sync

    const result = await e.handle("project.status", { name: "alpha" }) as { spec: { name: string } };
    expect(result.spec.name).toBe("alpha");
    // the pre-throw team state is untouched — "qa" never got merged in
    expect(Object.keys(nativeTeam(e, "alpha")!.roles)).toEqual(["dev"]);
  });

  it("a syncProjectTeam throw never breaks project.create", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProjectDir();
    writeAgentFile(path, "dev.md", "dev", "writes code");

    (e as unknown as { syncProjectTeam(name: string): void }).syncProjectTeam = () => {
      throw new Error("boom");
    };

    const spec = await e.handle("project.create", { name: "alpha", path, autoConductor: false }) as { name: string; teams: string[] };
    expect(spec.name).toBe("alpha");
    expect(spec.teams).toEqual([]);
  });
});
