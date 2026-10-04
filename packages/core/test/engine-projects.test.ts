import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSpec } from "@chimera/protocol";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { AgentRecord } from "@chimera/core/supervisor";
import { makeEngineHome } from "./helpers.js";
import { reattachConductors } from "@chimera/core/reattach";

// WD Stage 2 (coverage B12): the project.* RPC family end to end on a real Engine —
// create/import (incl. a REAL `git clone` of a file:// repo into
// $CHIMERA_HOME/projects/<name>), list with live-session counts, status with the
// path-boundary session match, assignTeam validation/dedupe, and the
// archive-refusal {code:"conflict"} while sessions run.

// CORE-SUITE-BASELINE: real `git init`/`git clone` under this machine's concurrent-agent
// load can exceed vitest's 5000ms default; widened per existing precedent (supervisor-crash-loop.test.ts).
vi.setConfig({ testTimeout: 60_000 });

type Listed = ProjectSpec & { sessions: number };
type Status = {
  spec: ProjectSpec; sessions: AgentRecord[]; teams: Array<{ name: string; running: number }>;
  conductor: { agentId: string; state: string } | null;
};

function engineOn(home: string, scenarios: FakeStep[][] = []): Engine {
  return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]) });
}

function makeDir(): string { return mkdtempSync(join(tmpdir(), "chimera-projdir-")); }

// A real, commit-bearing git repo to clone over file:// (config-independent:
// identity is passed per command, never read from the machine).
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "chimera-gitsrc-"));
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, "README.md"), "# demo");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init", "--no-gpg-sign"]);
  return dir;
}

// keeps an agent "running" until killed: awaitSend parks the fake's script
const RUNNING: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }, { end: { resultText: "x" } }];

describe("project.create / list / status", () => {
  it("create registers a project (validating the path exists) and list carries a 0 session count", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeDir();
    // autoConductor:false — this test is about the create/list shape, not the
    // PROJECT-EAGER-CONDUCTOR spawn-on-create side effect (see the dedicated
    // describe block below).
    const spec = (await e.handle("project.create", { name: "alpha", path, autoConductor: false })) as ProjectSpec;
    expect(spec).toMatchObject({ name: "alpha", path, origin: null, archived: false });
    const listed = (await e.handle("project.list", {})) as Listed[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "alpha", sessions: 0 });
  });

  it("create rejects a missing path and validates referenced teams/queues BEFORE persisting", async () => {
    const e = engineOn(makeEngineHome());
    await expect(e.handle("project.create", { name: "p", path: "/missing/dir-xyz" })).rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("project.create", { name: "p", path: makeDir(), teams: ["ghost"] })).rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("project.create", { name: "p", path: makeDir(), queue: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    expect(await e.handle("project.list", {})).toEqual([]);   // nothing persisted by the failed attempts
  });

  it("list counts LIVE sessions under the path — with the /a/b-vs-/a/bc boundary check", async () => {
    const home = makeEngineHome();
    const e = engineOn(home, [RUNNING, RUNNING, RUNNING]);
    const path = makeDir();
    // autoConductor:false — isolates this from the PROJECT-EAGER-CONDUCTOR
    // spawn-on-create side effect, which would otherwise add its own session.
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });
    // one under the path root, one under a subdir, one in a name-prefix SIBLING
    await e.handle("agent.spawn", { spec: { prompt: "a", cwd: path, isolation: "none" } });
    await e.handle("agent.spawn", { spec: { prompt: "b", cwd: join(path, "sub"), isolation: "none" } });
    await e.handle("agent.spawn", { spec: { prompt: "c", cwd: `${path}-extra`, isolation: "none" } });
    const listed = (await e.handle("project.list", {})) as Listed[];
    expect(listed[0]!.sessions).toBe(2);                      // the sibling never matches
  });

  it("status returns spec + matching session records + team.status-style running counts", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const path = makeDir();
    // autoConductor:false — this test is about the sessions/teams shape, not the
    // P1-T2 conductor side effect (see the dedicated describe block below).
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: path } } } } });
    await e.handle("project.assignTeam", { project: "alpha", team: "crew" });
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "a", cwd: path, isolation: "none" } })) as AgentRecord;
    const st = (await e.handle("project.status", { name: "alpha" })) as Status;
    expect(st.spec.name).toBe("alpha");
    expect(st.sessions.map((a) => a.agentId)).toEqual([rec.agentId]);
    expect(st.teams).toEqual([{ name: "crew", running: 0 }]); // assigned but nothing scheduled through it yet
  });

  it("status on an unknown project is a protocol error", async () => {
    await expect(engineOn(makeEngineHome()).handle("project.status", { name: "ghost" })).rejects.toMatchObject({ code: "protocol" });
  });
});

// PROJECT-DEFAULT-DIR: project.create's `path` is now OPTIONAL — omitted mints a
// fresh blank project under resolveProjectBaseDir(config.projectImportDir, home),
// git-init'd with a seed commit so checkpoints/worktrees work immediately.
describe("project.create — PROJECT-DEFAULT-DIR (no path)", () => {
  it("mints a blank project under config.projectImportDir/<name>, git-init'd with a seed commit", async () => {
    const home = makeEngineHome();
    const e = engineOn(home);
    const importDir = mkdtempSync(join(tmpdir(), "chimera-blank-importdir-"));
    await e.handle("config.patch", { patch: { projectImportDir: importDir } });
    const spec = (await e.handle("project.create", { name: "blank" })) as ProjectSpec;
    expect(spec).toMatchObject({ name: "blank", path: join(importDir, "blank"), origin: null });
    expect(existsSync(join(importDir, "blank", ".git"))).toBe(true);
    const log = execFileSync("git", ["-C", spec.path, "log", "--oneline"]).toString().trim();
    expect(log.split("\n")).toHaveLength(1);                   // exactly the seed commit
  });

  it("falls back to $CHIMERA_HOME/projects/<name> when projectImportDir is unset", async () => {
    const home = makeEngineHome();
    const spec = (await engineOn(home).handle("project.create", { name: "blank" })) as ProjectSpec;
    expect(spec.path).toBe(join(home, "projects", "blank"));
    expect(existsSync(join(spec.path, ".git"))).toBe(true);
  });

  it("rejects a no-path create when the resolved dir already exists and is non-empty", async () => {
    const home = makeEngineHome();
    const target = join(home, "projects", "taken");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keep.txt"), "x");
    await expect(engineOn(home).handle("project.create", { name: "taken" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("still rejects a duplicate name BEFORE touching the filesystem", async () => {
    const e = engineOn(makeEngineHome());
    await e.handle("project.create", { name: "dup" });
    await expect(e.handle("project.create", { name: "dup" })).rejects.toMatchObject({ code: "protocol" });
  });

  // PROJECT-CREATE-GITINIT-OPTION: gitInit:false on the no-path create leaves a
  // plain empty directory — no .git, no seed commit.
  it("gitInit:false yields a plain directory with no .git and no seed commit", async () => {
    const home = makeEngineHome();
    const spec = (await engineOn(home).handle("project.create", { name: "plain", gitInit: false })) as ProjectSpec;
    expect(existsSync(spec.path)).toBe(true);
    expect(existsSync(join(spec.path, ".git"))).toBe(false);
  });

  it("gitInit:true behaves exactly like the (default) omitted case", async () => {
    const home = makeEngineHome();
    const spec = (await engineOn(home).handle("project.create", { name: "explicit-true", gitInit: true })) as ProjectSpec;
    expect(existsSync(join(spec.path, ".git"))).toBe(true);
  });

  it("gitInit is ignored when an explicit path is given (existing dir, unaffected)", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeDir();
    const spec = (await e.handle("project.create", { name: "existing", path, gitInit: false })) as ProjectSpec;
    expect(spec.path).toBe(path);
    expect(existsSync(join(path, ".git"))).toBe(false);          // makeDir() never git-inits either way
  });

  // PROJECT-DEFAULT-DIR-LEFTOVER: a registration-only project.delete (no
  // deleteFiles) leaves the minted, git-seeded dir on disk. A later no-path
  // create of the SAME name resolves to that exact dir — it must be adopted
  // rather than rejected, since nothing but the seed commit is in it.
  it("adopts a leftover git-seed-only dir from a previously deleted same-name pathless project", async () => {
    const home = makeEngineHome();
    const e = engineOn(home);
    const first = (await e.handle("project.create", { name: "ghost", autoConductor: false })) as ProjectSpec;
    await e.handle("project.delete", { name: "ghost" });
    expect(existsSync(join(first.path, ".git"))).toBe(true);      // left behind, registration-only

    const second = (await e.handle("project.create", { name: "ghost", autoConductor: false })) as ProjectSpec;
    expect(second.path).toBe(first.path);
    expect(existsSync(join(second.path, ".git"))).toBe(true);
    const log = execFileSync("git", ["-C", second.path, "log", "--oneline"]).toString().trim();
    expect(log.split("\n")).toHaveLength(1);                      // not re-seeded with a second commit
  });

  it("still rejects a leftover dir that has more than just the git seed", async () => {
    const home = makeEngineHome();
    const e = engineOn(home);
    const first = (await e.handle("project.create", { name: "ghost", autoConductor: false })) as ProjectSpec;
    await e.handle("project.delete", { name: "ghost" });
    writeFileSync(join(first.path, "keep.txt"), "x");             // something beyond the bare seed

    await expect(e.handle("project.create", { name: "ghost", autoConductor: false })).rejects.toMatchObject({ code: "protocol" });
  });
});

describe("project.import", () => {
  it("clones a file:// git URL into $CHIMERA_HOME/projects/<name> and registers it with origin", async () => {
    const home = makeEngineHome();
    const e = engineOn(home);
    const src = makeGitRepo();
    const source = `file://${src}`;
    const spec = (await e.handle("project.import", { source, name: "demo" })) as ProjectSpec;
    expect(spec).toMatchObject({ name: "demo", path: join(home, "projects", "demo"), origin: source });
    expect(existsSync(join(home, "projects", "demo", "README.md"))).toBe(true);
    expect(existsSync(join(home, "projects", "demo", ".git"))).toBe(true);
    // and it shows up in project.list
    const listed = (await e.handle("project.list", {})) as Listed[];
    expect(listed.map((p) => p.name)).toEqual(["demo"]);
  });

  it("derives the name from the URL when omitted", async () => {
    const home = makeEngineHome();
    const src = makeGitRepo();
    const spec = (await engineOn(home).handle("project.import", { source: `file://${src}` })) as ProjectSpec;
    // mkdtemp basename ("chimera-gitsrc-XXXXXX") is already CoordName-safe
    expect(spec.name).toBe(src.split("/").pop());
  });

  it("a failed clone surfaces git's stderr as a {code:'git'} rpc error and registers nothing", async () => {
    const e = engineOn(makeEngineHome());
    const err = await e.handle("project.import", { source: "file:///nonexistent/repo-xyz", name: "broken" })
      .then(() => null, (x: unknown) => x as { code: string; message: string });
    expect(err).not.toBeNull();
    expect(err!.code).toBe("git");
    expect(err!.message).toMatch(/git clone failed/);
    expect(err!.message.length).toBeGreaterThan("git clone failed: ".length);   // carries git's own stderr text
    expect(await e.handle("project.list", {})).toEqual([]);
  }, 15_000);

  it("a duplicate name is refused BEFORE the clone side effect (no stray checkout)", async () => {
    const home = makeEngineHome();
    const e = engineOn(home);
    await e.handle("project.create", { name: "demo", path: makeDir() });
    await expect(e.handle("project.import", { source: `file://${makeGitRepo()}`, name: "demo" }))
      .rejects.toMatchObject({ code: "protocol" });
    expect(existsSync(join(home, "projects", "demo"))).toBe(false);
  });

  it("a local existing dir registers in place (origin null); team assignment is validated first and applied", async () => {
    const e = engineOn(makeEngineHome());
    const dir = makeDir();
    await expect(e.handle("project.import", { source: dir, team: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: dir } } } } });
    const spec = (await e.handle("project.import", { source: dir, name: "local-reg", team: "crew" })) as ProjectSpec;
    expect(spec).toMatchObject({ name: "local-reg", path: dir, origin: null, teams: ["crew"] });
  });

  it("a source that is neither a git URL nor an existing dir is a protocol error", async () => {
    await expect(engineOn(makeEngineHome()).handle("project.import", { source: "/no/such/dir-xyz", name: "x" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  // WD2 review MAJOR (path traversal): an explicit name like "../../tmp/x" used
  // to reach join(home, "projects", name) and git-clone OUTSIDE CHIMERA_HOME
  // before ProjectSpecSchema ever saw the name. The params-layer ProjectName
  // regex must reject it BEFORE any filesystem side effect.
  it("import rejects a traversal-shaped name BEFORE cloning (nothing written anywhere)", async () => {
    const home = makeEngineHome();
    const e = engineOn(home);
    const src = makeGitRepo();
    const escape = join(tmpdir(), `chimera-escape-${process.pid}`);
    await expect(
      e.handle("project.import", { source: `file://${src}`, name: `../../../..${escape}` }),
    ).rejects.toMatchObject({ code: "protocol" });
    expect(existsSync(escape)).toBe(false);                       // the clone never ran
    expect(existsSync(join(home, "projects"))).toBe(false);       // nothing inside home either
    expect(await e.handle("project.list", {})).toEqual([]);
    // same guard on the create path (defense in depth at the params layer)
    await expect(e.handle("project.create", { name: "../evil", path: makeDir() }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  // IMPORT-DIR: config.projectImportDir overrides the $CHIMERA_HOME/projects clone base.
  describe("configurable clone base (IMPORT-DIR)", () => {
    it("clones under config.projectImportDir/<name> when set, and creates the dir if missing", async () => {
      const home = makeEngineHome();
      const e = engineOn(home);
      const importDir = join(mkdtempSync(join(tmpdir(), "chimera-importdir-")), "nested", "base");
      expect(existsSync(importDir)).toBe(false);
      await e.handle("config.patch", { patch: { projectImportDir: importDir } });
      const src = makeGitRepo();
      const spec = (await e.handle("project.import", { source: `file://${src}`, name: "demo" })) as ProjectSpec;
      expect(spec).toMatchObject({ name: "demo", path: join(importDir, "demo") });
      expect(existsSync(join(importDir, "demo", "README.md"))).toBe(true);
      expect(existsSync(join(home, "projects", "demo"))).toBe(false);   // not the old default location
    });

    it("falls back to $CHIMERA_HOME/projects when projectImportDir is unset (back-compat)", async () => {
      const home = makeEngineHome();
      const e = engineOn(home);
      const src = makeGitRepo();
      const spec = (await e.handle("project.import", { source: `file://${src}`, name: "demo" })) as ProjectSpec;
      expect(spec).toMatchObject({ name: "demo", path: join(home, "projects", "demo") });
    });

    it("a local-path (non-git) import is unaffected by projectImportDir", async () => {
      const home = makeEngineHome();
      const e = engineOn(home);
      const importDir = mkdtempSync(join(tmpdir(), "chimera-importdir-"));
      await e.handle("config.patch", { patch: { projectImportDir: importDir } });
      const dir = makeDir();
      const spec = (await e.handle("project.import", { source: dir, name: "local-reg" })) as ProjectSpec;
      expect(spec).toMatchObject({ name: "local-reg", path: dir, origin: null });
    });
  });
});

describe("project.assignTeam / project.archive", () => {
  it("assignTeam validates the team exists and dedupes", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path });
    await expect(e.handle("project.assignTeam", { project: "alpha", team: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: path } } } } });
    expect(((await e.handle("project.assignTeam", { project: "alpha", team: "crew" })) as ProjectSpec).teams).toEqual(["crew"]);
    expect(((await e.handle("project.assignTeam", { project: "alpha", team: "crew" })) as ProjectSpec).teams).toEqual(["crew"]);
  });

  it("archive REFUSES with {code:'conflict'} while a live agent's cwd is under the path, then succeeds after kill", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path });
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "a", cwd: join(path, "sub"), isolation: "none" } })) as AgentRecord;
    await expect(e.handle("project.archive", { name: "alpha" })).rejects.toMatchObject({ code: "conflict" });
    await e.handle("agent.kill", { agentId: rec.agentId });
    expect(((await e.handle("project.archive", { name: "alpha" })) as ProjectSpec).archived).toBe(true);
  });

  it("setLoadProjectSettings (PROJTEAM-T7) persists the toggle via the RPC", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path });
    expect(((await e.handle("project.setLoadProjectSettings", { project: "alpha", value: false })) as ProjectSpec).loadProjectSettings).toBe(false);
    const status = (await e.handle("project.status", { name: "alpha" })) as { spec: ProjectSpec };
    expect(status.spec.loadProjectSettings).toBe(false);
    expect(((await e.handle("project.setLoadProjectSettings", { project: "alpha", value: true })) as ProjectSpec).loadProjectSettings).toBe(true);
  });

  it("setSetupHook (F26) persists the hook via the RPC, rejects a timeoutSec over the 900s ceiling, and clears back to null", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path });

    const hook = { command: "npm install", enabled: true, timeoutSec: 120 };
    const set = (await e.handle("project.setSetupHook", { project: "alpha", hook })) as ProjectSpec;
    expect(set.worktreeSetup).toEqual(hook);
    const status = (await e.handle("project.status", { name: "alpha" })) as { spec: ProjectSpec };
    expect(status.spec.worktreeSetup).toEqual(hook);

    await expect(
      e.handle("project.setSetupHook", { project: "alpha", hook: { ...hook, timeoutSec: 901 } }),
    ).rejects.toThrow();

    expect(
      ((await e.handle("project.setSetupHook", { project: "alpha", hook: null })) as ProjectSpec).worktreeSetup,
    ).toBeNull();
  });

  it("a live agent in a name-prefix SIBLING dir does NOT block archive (boundary check)", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const base = makeDir();
    const path = join(base, "proj");
    mkdirSync(path);
    await e.handle("project.create", { name: "alpha", path });
    await e.handle("agent.spawn", { spec: { prompt: "a", cwd: join(base, "proj-sibling"), isolation: "none" } });
    expect(((await e.handle("project.archive", { name: "alpha" })) as ProjectSpec).archived).toBe(true);
  });

  it("projects persist across an engine restart on the same home (projects.json)", async () => {
    const home = makeEngineHome();
    const path = makeDir();
    await engineOn(home).handle("project.create", { name: "alpha", path });
    const listed = (await engineOn(home).handle("project.list", {})) as Listed[];
    expect(listed[0]).toMatchObject({ name: "alpha", path });
  });
});

// PROJECT-DEFAULT-DIR-AND-DELETE: archive was a one-way name-trap — project.delete
// frees the name (registration-only unless deleteFiles:true) and project.unarchive
// restores an archived project. Both mirror archive's own guard/ordering exactly.
describe("project.delete / project.unarchive", () => {
  it("unarchive restores an archived project", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });
    await e.handle("project.archive", { name: "alpha" });
    expect(((await e.handle("project.list", {})) as Listed[])[0]!.archived).toBe(true);
    const restored = (await e.handle("project.unarchive", { name: "alpha" })) as ProjectSpec;
    expect(restored.archived).toBe(false);
  });

  it("unarchive is idempotent on an already-active project", async () => {
    const e = engineOn(makeEngineHome());
    await e.handle("project.create", { name: "alpha", path: makeDir(), autoConductor: false });
    const spec = (await e.handle("project.unarchive", { name: "alpha" })) as ProjectSpec;
    expect(spec.archived).toBe(false);
  });

  it("delete frees the name — a second create with the same name then succeeds", async () => {
    const e = engineOn(makeEngineHome());
    await e.handle("project.create", { name: "alpha", path: makeDir(), autoConductor: false });
    expect(await e.handle("project.delete", { name: "alpha" })).toEqual({ deleted: true });
    expect(await e.handle("project.list", {})).toEqual([]);
    const path2 = makeDir();
    const spec2 = (await e.handle("project.create", { name: "alpha", path: path2, autoConductor: false })) as ProjectSpec;
    expect(spec2).toMatchObject({ name: "alpha", path: path2 });
  });

  it("delete REFUSES with {code:'conflict'} while a live agent's cwd is under the path, then succeeds after kill", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "a", cwd: join(path, "sub"), isolation: "none" } })) as AgentRecord;
    await expect(e.handle("project.delete", { name: "alpha" })).rejects.toMatchObject({ code: "conflict" });
    await e.handle("agent.kill", { agentId: rec.agentId });
    expect(await e.handle("project.delete", { name: "alpha" })).toEqual({ deleted: true });
  });

  it("delete is registration-only by default (directory survives); deleteFiles:true removes it", async () => {
    const path1 = makeDir();
    const e1 = engineOn(makeEngineHome());
    await e1.handle("project.create", { name: "alpha", path: path1, autoConductor: false });
    await e1.handle("project.delete", { name: "alpha" });
    expect(existsSync(path1)).toBe(true);

    const path2 = makeDir();
    const e2 = engineOn(makeEngineHome());
    await e2.handle("project.create", { name: "alpha", path: path2, autoConductor: false });
    await e2.handle("project.delete", { name: "alpha", deleteFiles: true });
    expect(existsSync(path2)).toBe(false);
  });

  it("delete on an unknown project is a protocol error", async () => {
    await expect(engineOn(makeEngineHome()).handle("project.delete", { name: "ghost" })).rejects.toMatchObject({ code: "protocol" });
  });

  // PROJECT-DEFAULT-DIR-LEFTOVER: registration-only delete of an auto-minted
  // (no-path create) project flags the leftover dir so a caller knows a future
  // pathless create of the same name will find it still sitting there.
  it("registration-only delete of a pathless project reports leftoverPath", async () => {
    const e = engineOn(makeEngineHome());
    const spec = (await e.handle("project.create", { name: "ghost", autoConductor: false })) as ProjectSpec;
    expect(await e.handle("project.delete", { name: "ghost" })).toEqual({ deleted: true, leftoverPath: spec.path });
  });

  it("deleteFiles:true on a pathless project removes the dir and omits leftoverPath", async () => {
    const e = engineOn(makeEngineHome());
    const spec = (await e.handle("project.create", { name: "ghost", autoConductor: false })) as ProjectSpec;
    expect(await e.handle("project.delete", { name: "ghost", deleteFiles: true })).toEqual({ deleted: true });
    expect(existsSync(spec.path)).toBe(false);
  });
});

// PLAN-PROJECT-CONDUCTOR-ROUTING P1-T2: ensureProjectConductor (D1 lazy-declared
// auto-conductor) — lazy trigger via project.status, idempotency/TOCTOU, explicit
// start/stop, archive teardown, and reattach across a simulated restart.
describe("project conductor: lazy ensureProjectConductor (P1-T2)", () => {
  it("project.status LAZILY spawns exactly one conductor with the right spec and persists conductorId; a second focus reuses it", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path });

    const st1 = (await e.handle("project.status", { name: "alpha" })) as Status;
    expect(st1.conductor).not.toBeNull();
    expect(st1.conductor!.state).toBe("running");
    expect(st1.spec.conductorId).toBe(st1.conductor!.agentId);
    const conductorId = st1.conductor!.agentId;

    const rec = e.supervisor.status(conductorId);
    expect(rec.spec.cwd).toBe(path);
    expect(rec.spec.isolation).toBe("none");
    expect((rec.spec as { conductor?: boolean }).conductor).toBe(true);
    expect((rec.spec as { orchestration?: { allow?: boolean } }).orchestration?.allow).toBe(true);
    // CONDUCTOR-FULL-ACCESS Part A: a project conductor is born "full" by default too (same
    // rationale as the main conductor — it works in the REAL project repo and needs Bash / MCP).
    expect(rec.spec.permissionProfile).toBe("full");

    // second focus: idempotent — the SAME conductor is returned, nothing new spawns
    const st2 = (await e.handle("project.status", { name: "alpha" })) as Status;
    expect(st2.conductor!.agentId).toBe(conductorId);
    expect(e.supervisor.list().filter((a) => (a.spec as { conductor?: boolean }).conductor === true)).toHaveLength(1);
  });

  it("two concurrent project.status focuses race-free: only ONE conductor spawns (TOCTOU guard, mirrors commands.agents.ts:869)", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path });

    const [st1, st2] = await Promise.all([
      e.handle("project.status", { name: "alpha" }) as Promise<Status>,
      e.handle("project.status", { name: "alpha" }) as Promise<Status>,
    ]);
    expect(st1.conductor!.agentId).toBe(st2.conductor!.agentId);
    expect(e.supervisor.list().filter((a) => (a.spec as { conductor?: boolean }).conductor === true)).toHaveLength(1);
  });

  it("autoConductor:false disables the lazy project.status trigger entirely", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });
    const st = (await e.handle("project.status", { name: "alpha" })) as Status;
    expect(st.conductor).toBeNull();
    expect(st.spec.conductorId).toBeNull();
    expect(e.supervisor.list()).toHaveLength(0);
  });

  it("project.conductor.start explicitly ensures a conductor (idempotent) without going through project.status", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });
    const rec1 = (await e.handle("project.conductor.start", { name: "alpha" })) as AgentRecord;
    expect(rec1.state).toBe("running");
    const rec2 = (await e.handle("project.conductor.start", { name: "alpha" })) as AgentRecord;
    expect(rec2.agentId).toBe(rec1.agentId);
    expect(e.supervisor.list().filter((a) => (a.spec as { conductor?: boolean }).conductor === true)).toHaveLength(1);
  });

  it("project.conductor.stop kills a live conductor and clears conductorId", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path });
    const st = (await e.handle("project.status", { name: "alpha" })) as Status;
    const conductorId = st.conductor!.agentId;

    const stopped = (await e.handle("project.conductor.stop", { name: "alpha" })) as ProjectSpec;
    expect(stopped.conductorId).toBeNull();
    expect(e.supervisor.status(conductorId).state).toBe("killed");

    // stopping again (already-clear conductorId) is a no-op, not an error
    await expect(e.handle("project.conductor.stop", { name: "alpha" })).resolves.toMatchObject({ conductorId: null });
  });

  it("project.archive tears down its OWN live conductor first (never blocked by the conductor's own cwd occupancy) and clears conductorId", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path });
    const st = (await e.handle("project.status", { name: "alpha" })) as Status;
    const conductorId = st.conductor!.agentId;

    const archived = (await e.handle("project.archive", { name: "alpha" })) as ProjectSpec;
    expect(archived.archived).toBe(true);
    expect(archived.conductorId).toBeNull();
    expect(e.supervisor.status(conductorId).state).toBe("killed");
  });

  it("archive STILL REFUSES if an unrelated live agent is under the path — conductor teardown doesn't mask other live work", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING, RUNNING]);
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path });
    await e.handle("project.status", { name: "alpha" });   // spawns the conductor
    const other = (await e.handle("agent.spawn", { spec: { prompt: "a", cwd: join(path, "sub"), isolation: "none" } })) as AgentRecord;

    await expect(e.handle("project.archive", { name: "alpha" })).rejects.toMatchObject({ code: "conflict" });
    await e.handle("agent.kill", { agentId: other.agentId });
    expect(((await e.handle("project.archive", { name: "alpha" })) as ProjectSpec).archived).toBe(true);
  });

  it("a restart resurrects the project's conductor under its ORIGINAL agentId; the persisted conductorId still resolves to it (no duplicate spawn)", async () => {
    const home = makeEngineHome();
    const e1 = engineOn(home, [RUNNING]);
    const path = makeDir();
    await e1.handle("project.create", { name: "alpha", path });
    const st1 = (await e1.handle("project.status", { name: "alpha" })) as Status;
    const conductorId = st1.conductor!.agentId;

    // Simulate a daemon restart: a fresh Engine on the SAME home (projects.json —
    // and its persisted conductorId — reloads from disk) fed the prior supervisor
    // snapshot via reattachConductors, the same boot-glue reattachFromState uses.
    const priorAgents = e1.supervisor.list();
    const e2 = engineOn(home, [[{ awaitSend: true }]]);
    reattachConductors(e2, priorAgents);
    await new Promise((r) => setTimeout(r, 20));   // let the fire-and-forget re-spawn settle

    // LAZY-REATTACH: the project conductor comes back PAUSED with its session held rather than
    // being re-spawned at boot. It still counts as live for ownership, which is what this test
    // guards — project.status resolves the SAME agentId and no second conductor appears.
    expect(e2.supervisor.status(conductorId).state).toBe("paused");

    const st2 = (await e2.handle("project.status", { name: "alpha" })) as Status;
    expect(st2.spec.conductorId).toBe(conductorId);
    expect(st2.conductor).toEqual({ agentId: conductorId, state: "paused" });
    // still exactly one conductor — the lazy trigger did NOT spawn a second one
    expect(e2.supervisor.list().filter((a) => (a.spec as { conductor?: boolean }).conductor === true)).toHaveLength(1);
  });

  // PROJTEAM-T5: spawnProjectConductor sets inherit.settingSources from
  // spec.loadProjectSettings — ON loads the project's .claude/ + global skills,
  // OFF keeps the prior isolated ([]) behavior.
  it("loadProjectSettings ON (the default): the conductor spawns with settingSources [\"project\",\"user\"]", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path });
    const st = (await e.handle("project.status", { name: "alpha" })) as Status;
    const rec = e.supervisor.status(st.conductor!.agentId);
    expect((rec.spec as { inherit: { settingSources: string[] } }).inherit.settingSources).toEqual(["project", "user"]);
  });

  it("loadProjectSettings OFF: the conductor spawns isolated (settingSources [])", async () => {
    const home = makeEngineHome();
    const path = makeDir();
    // no RPC surface yet to flip loadProjectSettings post-create — seed projects.json
    // directly with a full ProjectSpec (ProjectStore parses it on construction).
    writeFileSync(join(home, "projects.json"), JSON.stringify([{
      name: "alpha", path, origin: null, teams: [], queue: null, createdAt: 1,
      archived: false, autoConductor: true, conductorId: null, loadProjectSettings: false,
    }]));
    const e = engineOn(home, [RUNNING]);
    const st = (await e.handle("project.status", { name: "alpha" })) as Status;
    const rec = e.supervisor.status(st.conductor!.agentId);
    expect((rec.spec as { inherit: { settingSources: string[] } }).inherit.settingSources).toEqual([]);
  });
});

// PROJECT-EAGER-CONDUCTOR: ensureProjectConductor used to be reachable ONLY via
// the project.status "UI focus" trigger — a project created/imported via the API
// (or the new blank-create flow) and never focused showed no conductor in the
// Agents tab. create/import now trigger the same best-effort spawn eagerly.
describe("project conductor: eager spawn on create/import (PROJECT-EAGER-CONDUCTOR)", () => {
  it("project.create with autoConductor (the default) spawns the conductor immediately — no project.status focus needed", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const path = makeDir();
    const spec = (await e.handle("project.create", { name: "alpha", path })) as ProjectSpec;
    expect(spec.conductorId).not.toBeNull();
    const rec = e.supervisor.status(spec.conductorId!);
    expect(rec.state).toBe("running");
    expect(rec.spec.cwd).toBe(path);
    expect((rec.spec as { conductor?: boolean }).conductor).toBe(true);
  });

  it("autoConductor:false spawns no conductor on create", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeDir();
    const spec = (await e.handle("project.create", { name: "alpha", path, autoConductor: false })) as ProjectSpec;
    expect(spec.conductorId).toBeNull();
    expect(e.supervisor.list()).toHaveLength(0);
  });

  it("a conductor spawn failure never fails project.create — conductorId stays null, create still returns", async () => {
    // no "claude" backend registered ⇒ supervisor.spawn throws UnknownAgentError,
    // exercising the same try/catch discipline as project.status's lazy trigger.
    const e = new Engine({ home: makeEngineHome(), backends: new Map() });
    const path = makeDir();
    const spec = (await e.handle("project.create", { name: "alpha", path })) as ProjectSpec;
    expect(spec.conductorId).toBeNull();
    expect(e.supervisor.list()).toHaveLength(0);
  });

  it("project.import with autoConductor spawns the conductor immediately too", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const src = makeGitRepo();
    const spec = (await e.handle("project.import", { source: `file://${src}`, name: "demo" })) as ProjectSpec;
    expect(spec.conductorId).not.toBeNull();
    expect(e.supervisor.status(spec.conductorId!).state).toBe("running");
  });

  it("a subsequent project.status is idempotent — reuses the create-spawned conductor, no double spawn", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const path = makeDir();
    const created = (await e.handle("project.create", { name: "alpha", path })) as ProjectSpec;
    const st = (await e.handle("project.status", { name: "alpha" })) as Status;
    expect(st.conductor!.agentId).toBe(created.conductorId);
    expect(e.supervisor.list().filter((a) => (a.spec as { conductor?: boolean }).conductor === true)).toHaveLength(1);
  });

  // HEALTH-CONDUCTOR-DUPLICATE: a conductor that crash-loops into the circuit breaker
  // ("failed", per DEFAULT_CRASH_LOOP_POLICY/reportUnresponsive) leaves conductorId still
  // pointing at the dead record — the next lazy trigger spawns a REPLACEMENT. That
  // replacement must continue the prior SDK session (resume: sessionId), not start blank,
  // or the conductor silently loses all its prior context/history.
  it("a replacement conductor spawned after the prior one failed resumes its SDK session instead of starting blank", async () => {
    const e = new Engine({
      home: makeEngineHome(),
      backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([
        [{ emit: { kind: "agent_started", data: { sessionId: "s-123" } } }, { fail: { message: "process exited" } }],
        RUNNING,
      ])]]),
      crashLoopPolicy: { maxRestarts: 0, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const path = makeDir();
    const created = (await e.handle("project.create", { name: "alpha", path })) as ProjectSpec;
    const firstConductorId = created.conductorId!;
    await new Promise((r) => setTimeout(r, 10));   // let the crash settle into "failed"
    expect(e.supervisor.status(firstConductorId).state).toBe("failed");
    expect(e.supervisor.status(firstConductorId).circuitOpen).toBe(true);

    const st = (await e.handle("project.status", { name: "alpha" })) as Status;
    const secondConductorId = st.conductor!.agentId;
    expect(secondConductorId).not.toBe(firstConductorId);
    expect(e.supervisor.status(secondConductorId).spec.resume).toBe("s-123");
  });
});

// PROJECT-CREATE-PERMISSION-PROFILE: a per-project override of config.conductorPermissionProfile,
// chosen at project.create/import time and applied to that project's conductor spawns.
describe("project.permissionProfile (PROJECT-CREATE-PERMISSION-PROFILE)", () => {
  it("BACKWARD-COMPAT: an existing projects.json row without permissionProfile still parses and behaves exactly as before — global config fallback", async () => {
    const home = makeEngineHome();
    const path = makeDir();
    // Seed a pre-feature row — no permissionProfile key at all, mirrors a real
    // on-disk projects.json written before this field existed.
    writeFileSync(join(home, "projects.json"), JSON.stringify([{
      name: "alpha", path, origin: null, teams: [], queue: null, createdAt: 1,
      archived: false, autoConductor: true, conductorId: null, loadProjectSettings: true,
    }]));
    const e = engineOn(home, [RUNNING]);
    const listed = (await e.handle("project.list", {})) as Array<ProjectSpec & { sessions: number }>;
    expect(listed[0]!.permissionProfile).toBeNull();           // parses byte-identically (schema default)
    await e.handle("config.patch", { patch: { conductorPermissionProfile: "acceptEdits" } });
    const st = (await e.handle("project.status", { name: "alpha" })) as Status;
    // no per-project override ⇒ falls back to global config, exactly like before this field existed
    expect(e.supervisor.status(st.conductor!.agentId).spec.permissionProfile).toBe("acceptEdits");
  });

  it("an explicit project.create permissionProfile:'full' wins over global config, and the conductor comes up genuinely prompt-free (on.permissionRequest:'auto')", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    await e.handle("config.patch", { patch: { conductorPermissionProfile: "readOnly" } });
    const path = makeDir();
    const spec = (await e.handle("project.create", { name: "full-proj", path, permissionProfile: "full" })) as ProjectSpec;
    expect(spec.permissionProfile).toBe("full");
    const rec = e.supervisor.status(spec.conductorId!);
    expect(rec.spec.permissionProfile).toBe("full");
    expect((rec.spec as { on: { permissionRequest: string } }).on.permissionRequest).toBe("auto");
  });

  it("a second project created with no permissionProfile chosen still follows global config (readOnly)", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    await e.handle("config.patch", { patch: { conductorPermissionProfile: "readOnly" } });
    const path = makeDir();
    const spec = (await e.handle("project.create", { name: "plain-proj", path })) as ProjectSpec;
    expect(spec.permissionProfile).toBeNull();
    const rec = e.supervisor.status(spec.conductorId!);
    expect(rec.spec.permissionProfile).toBe("readOnly");
  });

  it("project.import also accepts and persists permissionProfile, applied to its eager conductor spawn", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    await e.handle("config.patch", { patch: { conductorPermissionProfile: "readOnly" } });
    const src = makeGitRepo();
    const spec = (await e.handle("project.import", { source: `file://${src}`, name: "demo", permissionProfile: "full" })) as ProjectSpec;
    expect(spec.permissionProfile).toBe("full");
    const rec = e.supervisor.status(spec.conductorId!);
    expect(rec.spec.permissionProfile).toBe("full");
    expect((rec.spec as { on: { permissionRequest: string } }).on.permissionRequest).toBe("auto");
  });
});
