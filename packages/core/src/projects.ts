import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";
import { execFile } from "node:child_process";
import { ProjectSpecSchema, type ProjectSpec, type WorktreeSetupHook } from "@chimera/protocol";
import type { EventLog } from "./events.js";

// WD Stage 2 (coverage B12): the project registry — a named set of working
// directories (imported git clones or registered local paths) that sessions and
// teams are grouped under. Persisted at $CHIMERA_HOME/projects.json following the
// teams.json discipline exactly: parse-on-load, fail-fast on corruption,
// write-to-temp-then-rename on save.

export class UnknownProjectError extends Error { code = "protocol" as const; name = "UnknownProjectError"; }
// PROJECT-PATH-UNIQUE: two spellings of one directory must compare equal — a trailing slash, a
// relative segment, or a symlinked parent are all the same folder to git and to every agent that
// runs there. realpath is best-effort: a path that does not exist yet (a clone target being
// registered ahead of the clone) still compares by its resolved lexical form rather than throwing.
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const abs = resolvePath(p);
    try { return realpathSync(abs); } catch { return abs; }
  };
  return norm(a) === norm(b);
}

export class DuplicateProjectError extends Error { code = "protocol" as const; name = "DuplicateProjectError"; }
export class ProjectPathError extends Error { code = "protocol" as const; name = "ProjectPathError"; }
// "conflict" is the coverage-mandated refusal code for archive-while-sessions-run (B12).
export class ProjectConflictError extends Error { code = "conflict" as const; name = "ProjectConflictError"; }
export class GitImportError extends Error { code = "git" as const; name = "GitImportError"; }

// Path-prefix WITH boundary check (coverage B12): `/a/b` must contain `/a/b/x`
// and `/a/b` itself, but never `/a/bc` — a naive startsWith would. Trailing
// slashes on either side are normalized away so `/a/b/` and `/a/b` compare equal.
export function isPathUnder(child: string, parent: string): boolean {
  const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const c = strip(child);
  const p = strip(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

// A git-clonable source vs a local path to register. file:// MUST be recognized
// as a git URL (the import test suite clones file:// repos); scp-style
// "git@host:owner/repo" has no scheme so it gets its own alternative.
export function isGitSource(source: string): boolean {
  return /^(https?|git|ssh|file):\/\//.test(source) || /^git@[^/]+:/.test(source);
}

// Derive a CoordName-safe project name from a git URL / local path: last path
// segment, ".git" suffix stripped, every character outside [A-Za-z0-9_-] folded
// to "-" (CoordName rejects dots — "repo.name" becomes "repo-name"). Throws when
// nothing usable remains so the caller is told to pass an explicit name.
export function deriveProjectName(source: string): string {
  const seg = source.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  const name = seg.replace(/\.git$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new ProjectPathError(`cannot derive a project name from "${source}" — pass an explicit name`);
  return name;
}

// Async git clone (project.import's side effect). execFile — never a shell — with
// the task-mandated 120s ceiling; on ANY failure the caller gets git's own stderr
// (the most actionable text git produces) wrapped in a {code:"git"} rpc error.
export function gitClone(source: string, dest: string, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", ["clone", "--", source, dest], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (!err) return resolve();
      // GIT-STDOUT-DIAGNOSTIC: some git failures write their actual diagnostic to stdout
      // rather than stderr (e.g. hook output) — mirrors checkpoints.ts's GitCommandError,
      // which already falls back through stdout before the generic error message. Without
      // this, those failures surfaced only as node's content-free "Command failed: git
      // clone ..." message with the real diagnostic silently dropped.
      const detail = (stderr ?? "").trim() || (stdout ?? "").trim() || err.message;
      reject(new GitImportError(`git clone failed: ${detail}`));
    });
  });
}

// PROJECT-DEFAULT-DIR: the ONE base-dir resolution shared by project.import's
// clone target AND project.create's no-path default — config.projectImportDir
// when set, else $CHIMERA_HOME/projects.
export function resolveProjectBaseDir(importDir: string | null | undefined, home: string): string {
  return importDir ?? join(home, "projects");
}

// git-init + an empty seed commit for a freshly-minted blank project directory
// (PROJECT-DEFAULT-DIR): gives checkpoints/worktrees a real repo + a HEAD to work
// from immediately, instead of an untracked, uncommitted directory. Identity is
// passed per-command (never read from machine config), same as checkpoints.ts's
// commit-tree calls, so this never depends on a global git user.name/user.email.
export function gitInitSeed(dest: string, timeoutMs = 30_000): Promise<void> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "chimera", GIT_AUTHOR_EMAIL: "chimera@localhost",
    GIT_COMMITTER_NAME: "chimera", GIT_COMMITTER_EMAIL: "chimera@localhost",
  };
  const run = (args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      execFile("git", args, { cwd: dest, env, timeout: timeoutMs }, (err, stdout, stderr) => {
        if (!err) return resolve();
        // GIT-STDOUT-DIAGNOSTIC: see gitClone's identical fallback above.
        const detail = (stderr ?? "").trim() || (stdout ?? "").trim() || err.message;
        reject(new GitImportError(`git ${args[0]} failed: ${detail}`));
      });
    });
  return run(["init", "-q"]).then(() => run(["commit", "-q", "--allow-empty", "-m", "Initial commit (chimera project)"]));
}

export class ProjectStore {
  private projects = new Map<string, ProjectSpec>();
  private file: string;

  constructor(dir: string, private events: EventLog) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "projects.json");
    if (existsSync(this.file)) {
      try {
        for (const p of JSON.parse(readFileSync(this.file, "utf8")) as unknown[]) {
          const spec = ProjectSpecSchema.parse(p);
          this.projects.set(spec.name, spec);
        }
      } catch (err) {
        // Defined corrupt-file behavior (mirrors TeamManager): fail fast, name the
        // file, say how to recover — silently dropping registered projects is worse
        // than a loud crash.
        throw new Error(
          `corrupt coordination state in ${this.file}: ${(err as Error).message} — fix or remove the file and restart chimerad`,
        );
      }
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;                          // write-to-temp-then-rename: no torn writes on power loss
    writeFileSync(tmp, JSON.stringify([...this.projects.values()], null, 2));
    renameSync(tmp, this.file);
  }

  has(name: string): boolean { return this.projects.has(name); }

  // Register a project. `path` must be an ABSOLUTE existing directory — validated
  // here (not in the protocol schema, which stays fs-free). `createdAt`/`archived`
  // are stamped by the store, never caller-supplied.
  create(input: {
    name: string; path: string; origin?: string | null; teams?: string[]; queue?: string | null; autoConductor?: boolean;
    permissionProfile?: "readOnly" | "acceptEdits" | "full" | null;
    conductorAccount?: string | null; conductorModel?: string | null;
  }): ProjectSpec {
    if (!isAbsolute(input.path)) throw new ProjectPathError(`project path must be absolute: "${input.path}"`);
    let isDir = false;
    try { isDir = statSync(input.path).isDirectory(); } catch { /* missing → the throw below */ }
    if (!isDir) throw new ProjectPathError(`project path is not an existing directory: "${input.path}"`);
    const spec = ProjectSpecSchema.parse({
      name: input.name, path: input.path,
      origin: input.origin ?? null,
      teams: [...new Set(input.teams ?? [])],                // dedupe at the door, mirroring assignTeam
      queue: input.queue ?? null,
      createdAt: Date.now(),
      ...(input.autoConductor !== undefined ? { autoConductor: input.autoConductor } : {}),
      ...(input.permissionProfile !== undefined ? { permissionProfile: input.permissionProfile } : {}),
      // PROJECT-CONDUCTOR-ACCOUNT: the account NAME was already validated against the registry by
      // the engine (this store has none); spread-conditional so an omitted field keeps the
      // schema's own null default, same convention as permissionProfile above.
      ...(input.conductorAccount !== undefined ? { conductorAccount: input.conductorAccount } : {}),
      ...(input.conductorModel !== undefined ? { conductorModel: input.conductorModel } : {}),
    });
    if (this.projects.has(spec.name)) throw new DuplicateProjectError(`project "${spec.name}" already exists`);
    // PROJECT-PATH-UNIQUE: one directory, one project. Registering the same folder twice under
    // two names looks harmless but quietly forks the project's identity: each registration grows
    // its OWN conductor, both conductors' cwd resolves to the same directory, and the UI — which
    // names a conductor after its resolved project — then shows two identically-named rows and
    // disambiguates them with a "-2" suffix. That is what a real fleet actually hit (an
    // "onur-buse-wedding" and an "evetle" pointing at one repo), and it reads as a duplicated
    // agent rather than as the duplicated PROJECT it really is. Refuse at the door instead.
    const existingAtPath = [...this.projects.values()].find((p) => samePath(p.path, spec.path));
    if (existingAtPath)
      throw new DuplicateProjectError(
        `project "${existingAtPath.name}" is already registered at ${existingAtPath.path} — one directory can only be one project (rename or delete "${existingAtPath.name}" if you meant to replace it)`,
      );
    this.projects.set(spec.name, spec);
    this.save();
    this.events.append({
      agentId: `project:${spec.name}`, kind: "status",
      data: { project: spec.name, state: "created", path: spec.path, origin: spec.origin },
    });
    return spec;
  }

  get(name: string): ProjectSpec {
    const p = this.projects.get(name);
    if (!p) throw new UnknownProjectError(`unknown project "${name}"`);
    return p;
  }

  list(): ProjectSpec[] { return [...this.projects.values()]; }

  // Idempotent by design: assigning an already-assigned team returns the spec
  // unchanged (dedupe, coverage B12). Team EXISTENCE is validated by the engine
  // (which owns the TeamManager) before this is called.
  assignTeam(project: string, team: string): ProjectSpec {
    const spec = this.get(project);
    if (spec.teams.includes(team)) return spec;
    const next = { ...spec, teams: [...spec.teams, team] };
    this.projects.set(next.name, next);
    this.save();
    this.events.append({
      agentId: `project:${next.name}`, kind: "status",
      data: { project: next.name, state: "team-assigned", team },
    });
    return next;
  }

  // PLAN-PROJECT-CONDUCTOR-ROUTING P1-T2: persist the live/last-spawned conductor
  // agentId (or clear it back to null on stop/archive). Idempotent — setting the
  // same value is a no-op (no wasted save/event), mirroring assignTeam's dedupe.
  setConductorId(name: string, conductorId: string | null): ProjectSpec {
    const spec = this.get(name);
    if (spec.conductorId === conductorId) return spec;
    const next = { ...spec, conductorId };
    this.projects.set(next.name, next);
    this.save();
    return next;
  }

  // PROJECT-NATIVE-TEAMS T7: persist the loadProjectSettings toggle (read fresh
  // by syncProjectTeam and spawnProjectConductor — see engine.ts — so this only
  // takes effect on the NEXT sync/spawn, never retroactively on live sessions).
  // Idempotent, mirroring setConductorId.
  setLoadProjectSettings(name: string, value: boolean): ProjectSpec {
    const spec = this.get(name);
    if (spec.loadProjectSettings === value) return spec;
    const next = { ...spec, loadProjectSettings: value };
    this.projects.set(next.name, next);
    this.save();
    return next;
  }

  // PROJECT-CONDUCTOR-ACCOUNT: persist the conductor's account/model pin. Read fresh by
  // spawnProjectConductor, so it takes effect on the NEXT fresh conductor spawn only — never
  // retroactively on the live one (which would need a cross-provider reconfigure the supervisor
  // correctly refuses). Idempotent, mirroring setLoadProjectSettings. The engine validates the
  // account against the registry before calling; null clears the pin back to the global default.
  // The permissionProfile travels with the account pin because it is read at the same single
  // seam (spawnProjectConductor) and a codex pin is unusable without lowering it — see the
  // engine's assertConductorPinSpawnable, which is the only validator of both.
  setConductorAccount(
    name: string, account: string | null, model: string | null,
    permissionProfile: "readOnly" | "acceptEdits" | "full" | null,
  ): ProjectSpec {
    const spec = this.get(name);
    if (spec.conductorAccount === account && spec.conductorModel === model
      && spec.permissionProfile === permissionProfile) return spec;
    const next = { ...spec, conductorAccount: account, conductorModel: model, permissionProfile };
    this.projects.set(next.name, next);
    this.save();
    this.events.append({
      agentId: `project:${next.name}`, kind: "status",
      data: { project: next.name, state: "conductor-account-set", account, model, permissionProfile },
    });
    return next;
  }

  // F26: persist the fail-closed worktree setup hook (read fresh by
  // AgentSupervisor.runWorktreeSetupHook via engine.ts's projectSetupHook seam — see
  // supervisor.ts). Set ONLY by the operator-facing project.setSetupHook RPC, never by an
  // AgentSpec and never exposed as an MCP tool (mcp-parity's exclusion list) — an agent must
  // never be able to grant itself daemon-privileged execution at its own next spawn. The status
  // event carries `enabled` only, mirroring assignTeam's shape — the command string never
  // leaves this store into the event log (it is redacted at the audit-ledger call site instead,
  // and only there because the audit ledger already discloses commands for other actions).
  setSetupHook(name: string, hook: WorktreeSetupHook | null): ProjectSpec {
    const spec = this.get(name);
    if (JSON.stringify(spec.worktreeSetup) === JSON.stringify(hook)) return spec;      // idempotent
    const next = { ...spec, worktreeSetup: hook };
    this.projects.set(next.name, next);
    this.save();
    this.events.append({
      agentId: `project:${next.name}`, kind: "status",
      data: { project: next.name, state: "setup-hook-set", enabled: hook?.enabled ?? false },
    });
    return next;
  }

  // Flip archived. The LIVE-SESSION refusal lives in the engine (which owns the
  // supervisor and can see running agents); the store itself only persists state.
  archive(name: string): ProjectSpec {
    const spec = this.get(name);
    if (spec.archived) return spec;                          // idempotent
    const next = { ...spec, archived: true };
    this.projects.set(next.name, next);
    this.save();
    this.events.append({
      agentId: `project:${next.name}`, kind: "status",
      data: { project: next.name, state: "archived" },
    });
    return next;
  }

  // PROJECT-DEFAULT-DIR-AND-DELETE: the inverse of archive — restores a project
  // that archive had one-way-trapped. No live-session guard needed (unlike
  // archive/delete): restoring a project never yanks a directory out from under
  // anything.
  unarchive(name: string): ProjectSpec {
    const spec = this.get(name);
    if (!spec.archived) return spec;                          // idempotent
    const next = { ...spec, archived: false };
    this.projects.set(next.name, next);
    this.save();
    this.events.append({
      agentId: `project:${next.name}`, kind: "status",
      data: { project: next.name, state: "unarchived" },
    });
    return next;
  }

  // PROJECT-DEFAULT-DIR-AND-DELETE: registration-only removal (the on-disk dir
  // is untouched — the engine handles the opt-in `deleteFiles` fs side effect
  // AFTER this succeeds, mirroring project.import's clone-after-validate
  // ordering). The LIVE-SESSION refusal, like archive's, lives in the engine.
  // Frees `name` for a future create/import of the same name.
  delete(name: string): void {
    this.get(name);                                           // UnknownProjectError for a ghost name
    this.projects.delete(name);
    this.save();
    this.events.append({
      agentId: `project:${name}`, kind: "status",
      data: { project: name, state: "deleted" },
    });
  }
}
