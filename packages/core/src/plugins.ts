import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginCatalogEntry, PluginEntryKind } from "@chimera/protocol";

// WD Stage 2 (coverage B13): the GLOBAL plugins/skills/commands catalog + toggle
// registry behind plugins.list / plugins.toggle.
//
// READ-ONLY toward ~/.claude by hard rule: this class never writes anything under
// the Claude config dir — toggles live in $CHIMERA_HOME/plugins.json (a flat
// {"<kind>:<name>": boolean} map; absent = enabled). Catalog sources:
//   * skills   — ~/.claude/skills/<name>/SKILL.md directories
//   * plugins  — ~/.claude/plugins/installed_plugins.json (the marketplace install
//                manifest, v2 shape {plugins:{"name@marketplace":[{installPath}]}});
//                read only when trivially parseable, skipped otherwise per the
//                coverage note ("marketplace manifest if trivially readable")
//   * commands — PROJECT slash commands: .claude/commands/**/*.md under the
//                plugins.list {cwd} param; nested dirs namespace with ":" the way
//                the Claude CLI itself namespaces command files
//
// ENFORCEMENT (see supervisor.ts launch()): disabled entries are consumed at
// spawn resolution via disabledFor() — a NEW spawn omits them. What each kind's
// SDK lever is (and where one is missing) is documented there and in
// PLAN-TAURI.md's Stage-2 deferral ledger.

export class UnknownPluginIdError extends Error { code = "protocol" as const; name = "UnknownPluginIdError"; }

const KINDS = new Set<PluginEntryKind>(["skill", "plugin", "command"]);

export class PluginRegistry {
  private toggles = new Map<string, boolean>();
  private file: string;
  private claudeDir: string;

  constructor(dir: string, opts: { claudeDir?: string } = {}) {
    this.claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "plugins.json");
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
        for (const [id, v] of Object.entries(raw)) {
          if (typeof v === "boolean") this.toggles.set(id, v);
        }
      } catch (err) {
        // Fail fast like teams.json: a silently-dropped toggle file would RE-ENABLE
        // plugins the operator disabled — an enforcement hole, not a display glitch.
        throw new Error(
          `corrupt coordination state in ${this.file}: ${(err as Error).message} — fix or remove the file and restart chimerad`,
        );
      }
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;                          // write-to-temp-then-rename: no torn writes
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.toggles), null, 2));
    renameSync(tmp, this.file);
  }

  private enabled(id: string): boolean { return this.toggles.get(id) ?? true; }

  // Build the catalog. Every source is defensive: a missing/unreadable directory or
  // manifest contributes nothing (a fresh machine has none of them) — only the
  // TOGGLE file is allowed to fail loudly (constructor above).
  list(cwd?: string): PluginCatalogEntry[] {
    const out: PluginCatalogEntry[] = [];

    // skills: ~/.claude/skills/<name>/SKILL.md
    const skillsDir = join(this.claudeDir, "skills");
    for (const name of this.dirNames(skillsDir)) {
      if (!existsSync(join(skillsDir, name, "SKILL.md"))) continue;
      const id = `skill:${name}`;
      out.push({ id, kind: "skill", name, source: join(skillsDir, name), enabled: this.enabled(id) });
    }

    // plugins: the marketplace install manifest. Keys are "name@marketplace"; the
    // catalog name is the bare plugin name (what the SDK/UI call it), the source is
    // the newest install's installPath.
    try {
      const manifest = JSON.parse(readFileSync(join(this.claudeDir, "plugins", "installed_plugins.json"), "utf8")) as {
        plugins?: Record<string, Array<{ installPath?: string }>>;
      };
      for (const [key, installs] of Object.entries(manifest.plugins ?? {})) {
        const name = key.split("@")[0]!;
        if (!name) continue;
        const source = installs?.[0]?.installPath;
        if (typeof source !== "string" || source === "") continue;
        const id = `plugin:${name}`;
        out.push({ id, kind: "plugin", name, source, enabled: this.enabled(id) });
      }
    } catch { /* absent or non-trivially-readable manifest → no plugin rows */ }

    // project commands: .claude/commands/**/*.md relative to the caller's cwd.
    if (cwd) {
      const commandsDir = join(cwd, ".claude", "commands");
      for (const rel of this.mdFiles(commandsDir, "")) {
        const name = rel.replace(/\.md$/i, "").split("/").join(":");   // nested dirs namespace with ":"
        const id = `command:${name}`;
        out.push({ id, kind: "command", name, source: join(commandsDir, rel), enabled: this.enabled(id) });
      }
    }
    return out;
  }

  // Toggle persistence keyed on the catalog id. Any well-formed "<kind>:<name>" id
  // is accepted without a catalog scan — a toggle may be recorded for an entry that
  // is not currently listable (e.g. a project command whose repo isn't the current
  // cwd), and takes effect whenever the entry next appears.
  toggle(id: string, enabled: boolean): { id: string; enabled: boolean } {
    const colon = id.indexOf(":");
    const kind = colon > 0 ? id.slice(0, colon) : "";
    if (!KINDS.has(kind as PluginEntryKind) || id.length <= colon + 1)
      throw new UnknownPluginIdError(`invalid plugin id "${id}" — expected "<skill|plugin|command>:<name>"`);
    if (enabled) this.toggles.delete(id);                    // enabled is the default: keep the file minimal
    else this.toggles.set(id, false);
    this.save();
    return { id, enabled };
  }

  // The spawn-resolution view (supervisor launch()): disabled entry NAMES by kind.
  // Derived purely from the toggle map (no filesystem scan on the spawn path).
  // Commands are intentionally absent: there is no per-command SDK spawn lever —
  // see the PLAN-TAURI.md Stage-2 deferral.
  disabledFor(): { disabledSkills: string[]; disabledPlugins: string[] } {
    const disabledSkills: string[] = [];
    const disabledPlugins: string[] = [];
    for (const [id, enabled] of this.toggles) {
      if (enabled) continue;
      if (id.startsWith("skill:")) disabledSkills.push(id.slice("skill:".length));
      else if (id.startsWith("plugin:")) disabledPlugins.push(id.slice("plugin:".length));
    }
    return { disabledSkills, disabledPlugins };
  }

  private dirNames(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch { return []; }
  }

  private mdFiles(root: string, rel: string): string[] {
    const out: string[] = [];
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return out; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...this.mdFiles(root, childRel));
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(childRel);
    }
    return out;
  }
}
