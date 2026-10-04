import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { buildCodexOptions, buildThreadOptions } from "@chimera/core/backends/codex";
import type { AgentBackend } from "@chimera/core/backend";
import { RECONFIGURABLE, buildCapabilityBlock } from "@chimera/core/supervisor";
import { CONDUCTOR_PLAYBOOK } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PROJECT-CONDUCTOR-DEFAULTS (operator request): a per-project conductor is born on high effort
// with a 500k compaction window, rather than inheriting the fleet/account defaults.
//
// Both are config-overridable and read ONLY at the fresh-spawn seam, exactly like
// conductorPermissionProfile beside them — so this asserts the same three things that key's
// contract rests on: the default lands, a config override wins, and the value is on the SPEC (the
// thing reattach preserves and agent_reconfigure edits), not merely passed to a backend.

// Both providers are registered because the account-pin tests below spawn a conductor on a
// codex account; a claude-only map would fail at the backend lookup instead of proving the pin.
const backends = () => new Map<string, AgentBackend>([
  ["claude", new FakeAgentBackend([[{ awaitSend: true }]], "claude")],
  ["codex", new FakeAgentBackend([[{ awaitSend: true }]], "codex")],
]);

async function spawnProjectConductor(cfg?: Record<string, unknown>) {
  const home = makeEngineHome();
  const e = new Engine({ home, backends: backends() });
  if (cfg) await e.handle("config.patch", { patch: cfg });
  await e.handle("project.create", { name: "alpha", path: home });
  const started = (await e.handle("project.conductor.start", { name: "alpha" })) as { agentId: string };
  return { engine: e, spec: e.supervisor.status(started.agentId).spec as Record<string, unknown> };
}

describe("a per-project conductor's spawn defaults", () => {
  it("is born on HIGH effort", async () => {
    // Its job is routing and verification — it is the agent whose bad call wastes a whole fleet's
    // run, unlike a worker whose mistake costs one task.
    const { spec } = await spawnProjectConductor();
    expect(spec["effort"]).toBe("high");
  });

  it("is born with a 500k compaction window", async () => {
    // A conductor accumulates the project's whole routing history, so it reaches its window far
    // sooner than a worker and each compaction costs it the delegation context it exists to hold.
    const { spec } = await spawnProjectConductor();
    expect(spec["compactionThreshold"]).toBe(500_000);
  });

  it("lets the config override both, rather than hardcoding them", async () => {
    // The whole reason these are config keys and not literals: an operator changes them without a
    // rebuild, the same way conductorPermissionProfile already works.
    const { spec } = await spawnProjectConductor({
      projectConductorEffort: "medium",
      projectConductorCompactionThreshold: 250_000,
    });
    expect(spec["effort"]).toBe("medium");
    expect(spec["compactionThreshold"]).toBe(250_000);
  });

  it("puts them on the SPEC, so a restart preserves them and agent_reconfigure can change them", async () => {
    // Not a detail: reattach.ts restores a conductor from its STORED spec rather than re-reading
    // config, so a value that only ever reached the backend would silently vanish on the next
    // daemon restart. Both fields being reconfigurable is what makes "a default, not a lock" true.
    const { spec } = await spawnProjectConductor();
    expect(Object.keys(spec)).toEqual(expect.arrayContaining(["effort", "compactionThreshold"]));
    expect(RECONFIGURABLE.has("effort")).toBe(true);
    expect(RECONFIGURABLE.has("compactionThreshold")).toBe(true);
  });
});

// PROJECT-CONDUCTOR-ACCOUNT: makeEngineHome() ships a single claude account, so a "pin the
// conductor to codex" test needs a home with a second, cross-provider account — otherwise a
// passing test would be indistinguishable from the ghost-account rejection asserted below.
function makeTwoProviderHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chimera-home-2p-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [
      { name: "main", provider: "claude", auth: { type: "subscription" } },
      { name: "cx", provider: "codex", auth: { type: "subscription", homeDir: mkdtempSync(join(tmpdir(), "chimera-codex-")) } },
    ],
    autoOrder: ["main"],
    wake: { holdAwakeDuringRuns: false, scheduleWake: false },
  }));
  return home;
}

async function engineWithProject(create: Record<string, unknown> = {}) {
  const home = makeTwoProviderHome();
  const engine = new Engine({ home, backends: backends() });
  await engine.handle("project.create", { name: "alpha", path: home, ...create });
  return { engine, home };
}

// project.create already spawns the project's conductor (autoConductor), so a test that changes
// a BIRTH-time pin has to kill that one first — otherwise conductor.start hands back the live
// record and the assertion reads the OLD spec.
async function restartConductor(engine: Engine): Promise<Record<string, unknown>> {
  await engine.handle("project.conductor.stop", { name: "alpha" }).catch(() => {});
  return startConductor(engine);
}

async function startConductor(engine: Engine): Promise<Record<string, unknown>> {
  const started = (await engine.handle("project.conductor.start", { name: "alpha" })) as { agentId: string };
  return engine.supervisor.status(started.agentId).spec as unknown as Record<string, unknown>;
}

describe("a per-project conductor's account/model pin", () => {
  it("is unpinned by default: account resolves through autoOrder and no model is forced", async () => {
    // "auto" is AgentSpecSchema's own default, and an ABSENT model is meaningful — launch() does
    // `spec.model ?? provider.defaultModel`, so writing an explicit undefined/null model key would
    // be a different contract than leaving the provider to choose.
    const { engine } = await engineWithProject();
    const spec = await startConductor(engine);
    expect(spec["account"]).toBe("auto");
    expect("model" in spec).toBe(false);
  });

  it("is born on the pinned account when the project was created with one", async () => {
    // The operator's actual blocker: no post-spawn route exists onto another provider
    // (setAccount and agent_reconfigure both refuse cross-provider), so birth is the only seam.
    const { engine } = await engineWithProject({ conductorAccount: "cx", permissionProfile: "acceptEdits" });
    const spec = await startConductor(engine);
    expect(spec["account"]).toBe("cx");
  });

  it("is born on the pinned model, which lands on the SPEC that reattach restores", async () => {
    const { engine } = await engineWithProject({ conductorAccount: "cx", conductorModel: "gpt-5-codex", permissionProfile: "acceptEdits" });
    const spec = await startConductor(engine);
    expect(spec["model"]).toBe("gpt-5-codex");
    expect(RECONFIGURABLE.has("account")).toBe(true);
    expect(RECONFIGURABLE.has("model")).toBe(true);
  });

  it("project.setConductorAccount pins an existing project, and null clears back to auto", async () => {
    const { engine } = await engineWithProject();
    await engine.handle("project.setConductorAccount", {
      project: "alpha", account: "cx", model: "gpt-5-codex", permissionProfile: "acceptEdits",
    });
    expect((await restartConductor(engine))["account"]).toBe("cx");

    await engine.handle("project.setConductorAccount", { project: "alpha", account: null, model: null });
    const cleared = await restartConductor(engine);
    expect(cleared["account"]).toBe("auto");
    expect("model" in cleared).toBe(false);
  });

  it("never moves a LIVE conductor, but reports that a restart is required", async () => {
    // The pin is a birth-time value on purpose. Silently returning the old spec would leave the
    // operator believing the switch took effect, which is why the RPC hands back restartRequired.
    const { engine } = await engineWithProject();
    const before = await startConductor(engine);
    const res = (await engine.handle("project.setConductorAccount", { project: "alpha", account: "cx", permissionProfile: "acceptEdits" })) as {
      restartRequired: boolean; conductor: { account: string } | null;
    };
    expect(res.restartRequired).toBe(true);
    expect(res.conductor?.account).toBe("main");
    expect(before["account"]).toBe("auto");
  });

  it("refuses a ghost account at create time AND at set time, not at the next spawn", async () => {
    // JobScheduler.validateTarget's precedent: a typo must fail where the operator typed it.
    // Deferring to spawn turns it into a conductor that silently never starts.
    const home = makeTwoProviderHome();
    const engine = new Engine({ home, backends: backends() });
    await expect(engine.handle("project.create", { name: "ghosty", path: home, conductorAccount: "nope" }))
      .rejects.toThrow(/nope/);
    await engine.handle("project.create", { name: "alpha", path: home });
    await expect(engine.handle("project.setConductorAccount", { project: "alpha", account: "nope" }))
      .rejects.toThrow(/nope/);
  });

  it.each(["main", "cx"])("creates and imports full-autonomy managers on %s", async (account) => {
    for (const method of ["project.create", "project.import"]) {
      const home = makeTwoProviderHome();
      const providers = backends();
      const engine = new Engine({ home, backends: providers });
      const project = await engine.handle(method, {
        name: "alpha", ...(method === "project.create" ? { path: home } : { source: home }),
        conductorAccount: account,
      }) as { conductorId: string };
      // Read the eager spawn directly: a second start could conceal a failed first launch.
      const spec = engine.supervisor.status(project.conductorId).spec;
      expect(spec).toMatchObject({
        conductor: true, persistent: true, permissionProfile: "full", autonomy: "full",
        orchestration: { allow: true, maxDepth: 2 }, on: { permissionRequest: "auto" },
        acknowledgeCodexFullAccessRisk: true,
      });
      const backend = providers.get(account === "cx" ? "codex" : "claude") as FakeAgentBackend;
      expect(backend.spawns).toHaveLength(1);
      expect(backend.spawns[0]).toMatchObject({ conductor: true, autonomy: "full", permissionProfile: "full" });
      if (account === "cx") {
        const resolved = backend.spawns[0]!;
        expect(buildThreadOptions(resolved, home)).toMatchObject({ sandboxMode: "danger-full-access", approvalPolicy: "never" });
        expect(buildCodexOptions(resolved).config).toMatchObject({ mcp_servers: {
          chimera: { env: { CHIMERA_CONDUCTOR: "1", CHIMERA_AUTONOMY: "full", CHIMERA_MAX_DEPTH: "2" } },
        } });
      }
    }
  });

  it("keeps full permissions when an existing project's account changes to Codex", async () => {
    const { engine } = await engineWithProject({ permissionProfile: "full" });
    await engine.handle("project.setConductorAccount", { project: "alpha", account: "cx" });
    expect(await restartConductor(engine)).toMatchObject({
      account: "cx", permissionProfile: "full", autonomy: "full", acknowledgeCodexFullAccessRisk: true,
    });
  });

  it("supports an unpinned full conductor when autoOrder resolves to Codex", async () => {
    const home = makeTwoProviderHome();
    const providers = backends();
    const engine = new Engine({ home, backends: providers });
    await engine.handle("config.patch", { patch: { autoOrder: ["cx"] } });
    const project = await engine.handle("project.create", { name: "alpha", path: home }) as { conductorId: string };
    expect(engine.supervisor.status(project.conductorId).spec).toMatchObject({ account: "auto", permissionProfile: "full", autonomy: "full" });
    expect((providers.get("codex") as FakeAgentBackend).spawns).toHaveLength(1);
  });

  it("preserves an explicitly restricted project while granting conductor autonomy", async () => {
    const { engine } = await engineWithProject({ conductorAccount: "cx", permissionProfile: "readOnly" });
    expect(await startConductor(engine)).toMatchObject({
      permissionProfile: "readOnly", autonomy: "full", conductor: true,
      orchestration: { allow: true }, acknowledgeCodexFullAccessRisk: false,
    });
  });

  it("parses a persisted projects.json row written before these keys existed", async () => {
    // nullable-with-a-default, not optional: an older row must reload byte-identically rather
    // than tripping the schema on a missing key.
    const { engine, home } = await engineWithProject();
    const file = join(home, "projects.json");
    const rows = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    for (const r of rows) { delete r["conductorAccount"]; delete r["conductorModel"]; }
    writeFileSync(file, JSON.stringify(rows));
    void engine;

    const reloaded = new Engine({ home, backends: backends() });
    const list = (await reloaded.handle("project.list", {})) as Array<Record<string, unknown>>;
    const alpha = list.find((p) => p["name"] === "alpha")!;
    expect(alpha["conductorAccount"]).toBe(null);
    expect(alpha["conductorModel"]).toBe(null);
    expect((await startConductor(reloaded))["account"]).toBe("auto");
  });
});

describe("what a project conductor is TOLD it can reach on demand", () => {
  // The operator's ask was "let them find these and load them on the fly", explicitly NOT
  // "preload them". Measured on this fleet, preloading is 734 SKILL.md files / ~54k tokens of
  // listing in every prompt, plus the foreign MCP catalogue the codebase already established as
  // its most expensive line. So the surface stays lazy and the INSTRUCTIONS carry the paths —
  // which is the half that was missing, and the reason the lazy paths went unused.

  it("names the on-demand MCP path, since foreign servers are not in its tool list", async () => {
    const { spec } = await spawnProjectConductor();
    const instructions = String(spec["instructions"] ?? "");
    expect(instructions).toContain("mcp_store_tools");
    expect(instructions).toContain("mcp_store_call");
  });

  it("says which surface is ALREADY loaded, so it does not go hunting for it", async () => {
    // loadProjectSettings defaults true, so the project's own .claude/ (CLAUDE.md, commands,
    // skills) is loaded natively. An agent told only "everything is lazy" would re-fetch what it
    // already has.
    const { spec } = await spawnProjectConductor();
    expect(String(spec["instructions"] ?? "")).toContain(".claude/");
  });

  it("keeps the shared playbook prefix in front of it", async () => {
    // PROMPT-CACHE-PREFIX: the on-demand text names no project, so it belongs to the cacheable
    // prefix every project conductor shares. Inserted before the playbook — or written with the
    // project name in it — it would diverge the prefix and re-bill the whole playbook per project.
    const { spec } = await spawnProjectConductor();
    const instructions = String(spec["instructions"] ?? "");
    expect(instructions.startsWith(CONDUCTOR_PLAYBOOK)).toBe(true);
    expect(instructions.indexOf("ON DEMAND")).toBeLessThan(instructions.indexOf('PROJECT "alpha"'));
    expect(instructions.slice(CONDUCTOR_PLAYBOOK.length, instructions.indexOf('PROJECT "alpha"'))).not.toContain("alpha");
  });
});

describe("the capability block never promises a Skill tool that will refuse", () => {
  // The SDK is explicit that an unlisted skill is "hidden from the model's listing AND REJECTED BY
  // THE SKILL TOOL" — not deferred. With leanAgentSkills empty (the out-of-the-box default) every
  // lean claude spawn gets `skills: []`, so the block's unconditional "Skill ... lazy-load[s]
  // skills on demand" described a path that refuses on arrival. Same defect the memory block
  // beside it already guards against.

  it("drops the Skill promise when skills are switched off, and points at what still works", () => {
    const off = buildCapabilityBlock({ skillsUsable: false });
    expect(off).not.toContain("Skill and ToolSearch lazy-load");
    expect(off).toContain("Skill tool is OFF");
    // Not merely a removed sentence: the files are still on disk and readable, so "load it on the
    // fly" stays true by a different route — which is what the operator actually asked for.
    expect(off).toContain("SKILL.md");
    expect(off).toContain("ToolSearch");
  });

  it("keeps the original wording when skills ARE usable", () => {
    expect(buildCapabilityBlock({ skillsUsable: true })).toContain("Skill and ToolSearch lazy-load");
  });

  it("defaults to the original block, so every existing caller stays byte-identical", () => {
    // Two stable cache-prefix variants, not a per-agent string. A default of "off" would silently
    // rewrite the prompt of every spawn that never opted in.
    expect(buildCapabilityBlock()).toBe(buildCapabilityBlock({ skillsUsable: true }));
  });
});
