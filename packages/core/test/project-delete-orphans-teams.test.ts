import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ORPHANED-TEAMS-ON-DELETE: a project's teams and their bound queues outlive it, and nothing said
// so. Observed live: a deleted project's teams kept draining their queues, but no project claimed
// those queues any more — so resolveTaskOriginConductor's project branch could never fire, every
// task fell back to the pusher chain, and its workers rendered under an unrelated conductor. The
// work was correct; only its ownership was unattributable, and it read as a broken tree.

const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend([[{ awaitSend: true }]])]]);

const setup = async () => {
  const e = new Engine({ home: makeEngineHome(), backends: backends() });
  const path = mkdtempSync(join(tmpdir(), "chimera-proj-"));
  await e.handle("project.create", { name: "evetle", path, autoConductor: false });
  await e.handle("queue.create", { spec: { name: "evetle-main" } });
  await e.handle("team.create", { spec: { name: "evetle-build", queue: "evetle-main", roles: { be: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } } } });
  await e.handle("project.assignTeam", { project: "evetle", team: "evetle-build" });
  return e;
};

describe("project.delete names the teams it leaves behind", () => {
  it("reports each surviving team with the queue it still drains", async () => {
    const e = await setup();
    const res = await e.handle("project.delete", { name: "evetle" }) as {
      deleted: boolean; orphanedTeams?: Array<{ team: string; queue?: string }>;
    };
    expect(res.deleted).toBe(true);
    expect(res.orphanedTeams).toEqual([{ team: "evetle-build", queue: "evetle-main" }]);
  });

  it("does NOT delete them — a team may be shared, or repointed at another project", async () => {
    const e = await setup();
    await e.handle("project.delete", { name: "evetle" });
    const teams = await e.handle("team.list", {}) as Array<{ name: string; queue: string | null }>;
    expect(teams.find((t) => t.name === "evetle-build")?.queue).toBe("evetle-main");
  });

  it("the reported team can then be reassigned — the action the report exists to enable", async () => {
    const e = await setup();
    const path2 = mkdtempSync(join(tmpdir(), "chimera-proj-"));
    await e.handle("project.create", { name: "onur-buse-wedding", path: path2, autoConductor: false });
    await e.handle("project.delete", { name: "evetle" });

    await e.handle("project.assignTeam", { project: "onur-buse-wedding", team: "evetle-build" });
    const p = (await e.handle("project.list", {}) as Array<{ name: string; teams: string[] }>)
      .find((x) => x.name === "onur-buse-wedding")!;
    expect(p.teams).toEqual(["evetle-build"]);
  });

  it("says nothing when a project had no teams — no noise for the ordinary case", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const path = mkdtempSync(join(tmpdir(), "chimera-proj-"));
    await e.handle("project.create", { name: "solo", path, autoConductor: false });
    const res = await e.handle("project.delete", { name: "solo" }) as { orphanedTeams?: unknown };
    expect(res.orphanedTeams).toBeUndefined();
  });
});
