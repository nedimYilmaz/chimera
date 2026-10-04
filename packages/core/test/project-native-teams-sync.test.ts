import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TeamSpec } from "@chimera/protocol";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// PROJECT-NATIVE-TEAMS T3: engine.ts's private syncProjectTeam(name) — materialize/
// merge/re-sync a project's .claude/agents/*.md (T2's scanClaudeAgents) into its
// project-native team (T1's TeamSpec.projectNative/discoveredRoles provenance).
// syncProjectTeam has no RPC yet (T4 wires the lifecycle calls) so these tests reach
// it directly via `(e as any).syncProjectTeam(name)`, mirroring how other private-method
// engine internals get exercised before their RPC wiring lands.

function engineOn(home: string): Engine {
  return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
}

function makeProjectDir(): string {
  return mkdtempSync(join(tmpdir(), "chimera-projnative-"));
}

function writeAgentFile(projectPath: string, fileName: string, name: string, description: string): void {
  const agentsDir = join(projectPath, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, fileName), ["---", `name: ${name}`, `description: ${description}`, "---", "Body."].join("\n"));
}

async function sync(e: Engine, name: string): Promise<void> {
  (e as unknown as { syncProjectTeam(name: string): void }).syncProjectTeam(name);
}

function nativeTeam(e: Engine, project: string): TeamSpec | undefined {
  return (e as unknown as { teams: { list(): TeamSpec[] } }).teams.list().find((t) => t.projectNative === project);
}

describe("syncProjectTeam", () => {
  it("materializes a project-native team with discovered roles and assigns it", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProjectDir();
    writeAgentFile(path, "dev.md", "dev", "writes code");
    writeAgentFile(path, "qa.md", "qa", "tests code");
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });

    await sync(e, "alpha");

    const team = nativeTeam(e, "alpha");
    expect(team).toBeDefined();
    expect(Object.keys(team!.roles).sort()).toEqual(["dev", "qa"]);
    expect(team!.discoveredRoles.sort()).toEqual(["dev", "qa"]);
    expect(team!.projectNative).toBe("alpha");

    const spec = (await e.handle("project.list", {})) as Array<{ name: string; teams: string[] }>;
    expect(spec.find((p) => p.name === "alpha")!.teams).toEqual([team!.name]);
  });

  it("no .claude/agents and no existing team ⇒ no-op (no team materialized)", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProjectDir();
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });

    await sync(e, "alpha");

    expect(nativeTeam(e, "alpha")).toBeUndefined();
    const spec = (await e.handle("project.list", {})) as Array<{ name: string; teams: string[] }>;
    expect(spec.find((p) => p.name === "alpha")!.teams).toEqual([]);
  });

  it("preserves a chimera-added role across re-sync", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProjectDir();
    writeAgentFile(path, "dev.md", "dev", "writes code");
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });
    await sync(e, "alpha");
    const team = nativeTeam(e, "alpha")!;

    await e.handle("team.update", {
      name: team.name,
      patch: { roles: { ...team.roles, lead: { role: "blank", overrides: { cwd: path } } } },
    });

    await sync(e, "alpha");

    const after = nativeTeam(e, "alpha")!;
    expect(Object.keys(after.roles).sort()).toEqual(["dev", "lead"]);
    expect(after.discoveredRoles).toEqual(["dev"]);   // "lead" never counted as discovered
  });

  it("drops a discovered role whose backing file is deleted, keeps the chimera role", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProjectDir();
    writeAgentFile(path, "dev.md", "dev", "writes code");
    writeAgentFile(path, "qa.md", "qa", "tests code");
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });
    await sync(e, "alpha");
    const team = nativeTeam(e, "alpha")!;
    await e.handle("team.update", { name: team.name, patch: { roles: { ...team.roles, lead: { role: "blank", overrides: { cwd: path } } } } });

    rmSync(join(path, ".claude", "agents", "qa.md"));
    await sync(e, "alpha");

    const after = nativeTeam(e, "alpha")!;
    expect(Object.keys(after.roles).sort()).toEqual(["dev", "lead"]);
    expect(after.discoveredRoles).toEqual(["dev"]);
  });

  it("a name collision keeps the chimera-added role and skips the discovered one", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProjectDir();
    writeAgentFile(path, "dev.md", "dev", "writes code");
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });
    await sync(e, "alpha");
    const team = nativeTeam(e, "alpha")!;

    // chimera adds a role named "qa" BEFORE "qa.md" ever gets discovered
    await e.handle("team.update", { name: team.name, patch: { roles: { ...team.roles, qa: { role: "blank", overrides: { cwd: path, model: "chimera-custom" } } } } });
    writeAgentFile(path, "qa.md", "qa", "tests code");

    await sync(e, "alpha");

    const after = nativeTeam(e, "alpha")!;
    expect(after.roles.qa!.overrides!["model"]).toBe("chimera-custom");   // chimera's role wins, not the discovered one
    expect(after.discoveredRoles).toEqual(["dev"]);          // "qa" never added to discoveredRoles
  });

  it("re-running with nothing changed is a no-op (idempotent)", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProjectDir();
    writeAgentFile(path, "dev.md", "dev", "writes code");
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });
    await sync(e, "alpha");
    const before = nativeTeam(e, "alpha")!;

    await sync(e, "alpha");

    const after = nativeTeam(e, "alpha")!;
    expect(after).toEqual(before);
    // still exactly one project-native team for "alpha" — no duplicate materialize
    const all = (e as unknown as { teams: { list(): TeamSpec[] } }).teams.list().filter((t) => t.projectNative === "alpha");
    expect(all).toHaveLength(1);
  });
});
