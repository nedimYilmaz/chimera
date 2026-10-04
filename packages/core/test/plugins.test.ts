import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRegistry, UnknownPluginIdError } from "@chimera/core/plugins";

// WD Stage 2 (coverage B13): the global plugins/skills/commands catalog + the
// plugins.json toggle registry. The catalog reads a FAKE ~/.claude built per test
// (the registry is READ-ONLY toward it by hard rule — toggles live in
// $CHIMERA_HOME/plugins.json only).

function makeClaudeDir(opts: { skills?: string[]; plugins?: Record<string, string> } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "chimera-claude-"));
  for (const name of opts.skills ?? []) {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), `# ${name}`);
  }
  if (opts.plugins) {
    mkdirSync(join(dir, "plugins"), { recursive: true });
    const plugins: Record<string, Array<{ installPath: string }>> = {};
    for (const [key, installPath] of Object.entries(opts.plugins)) plugins[key] = [{ installPath }];
    writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
  }
  return dir;
}

function makeHome(): string { return mkdtempSync(join(tmpdir(), "chimera-plughome-")); }

describe("PluginRegistry catalog", () => {
  it("lists skills (dirs with SKILL.md), installed plugins (manifest), all enabled by default", () => {
    const claudeDir = makeClaudeDir({
      skills: ["pdf", "docx"],
      plugins: { "superpowers@claude-plugins-official": "/x/cache/superpowers/6.1.1" },
    });
    const reg = new PluginRegistry(makeHome(), { claudeDir });
    const entries = reg.list();
    expect(entries).toEqual([
      { id: "skill:docx", kind: "skill", name: "docx", source: join(claudeDir, "skills", "docx"), enabled: true },
      { id: "skill:pdf", kind: "skill", name: "pdf", source: join(claudeDir, "skills", "pdf"), enabled: true },
      { id: "plugin:superpowers", kind: "plugin", name: "superpowers", source: "/x/cache/superpowers/6.1.1", enabled: true },
    ]);
  });

  it("a skills dir entry WITHOUT SKILL.md is not a skill", () => {
    const claudeDir = makeClaudeDir({ skills: ["real"] });
    mkdirSync(join(claudeDir, "skills", "just-a-dir"), { recursive: true });
    const reg = new PluginRegistry(makeHome(), { claudeDir });
    expect(reg.list().map((e) => e.name)).toEqual(["real"]);
  });

  it("project commands come from {cwd}/.claude/commands/**/*.md, nested dirs namespaced with ':'", () => {
    const cwd = mkdtempSync(join(tmpdir(), "chimera-projcwd-"));
    mkdirSync(join(cwd, ".claude", "commands", "ops"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "commands", "deploy.md"), "# deploy");
    writeFileSync(join(cwd, ".claude", "commands", "ops", "rollback.md"), "# rollback");
    writeFileSync(join(cwd, ".claude", "commands", "notes.txt"), "not a command");
    const reg = new PluginRegistry(makeHome(), { claudeDir: makeClaudeDir() });
    const commands = reg.list(cwd).filter((e) => e.kind === "command");
    expect(commands.map((e) => ({ id: e.id, name: e.name }))).toEqual([
      { id: "command:deploy", name: "deploy" },
      { id: "command:ops:rollback", name: "ops:rollback" },
    ]);
  });

  it("a fresh machine (no skills dir, no manifest, no cwd) yields an empty catalog — never throws", () => {
    const reg = new PluginRegistry(makeHome(), { claudeDir: mkdtempSync(join(tmpdir(), "chimera-empty-")) });
    expect(reg.list()).toEqual([]);
  });

  it("a malformed manifest contributes no plugin rows (trivially-readable clause) but skills still list", () => {
    const claudeDir = makeClaudeDir({ skills: ["pdf"] });
    mkdirSync(join(claudeDir, "plugins"), { recursive: true });
    writeFileSync(join(claudeDir, "plugins", "installed_plugins.json"), "{broken");
    const reg = new PluginRegistry(makeHome(), { claudeDir });
    expect(reg.list().map((e) => e.id)).toEqual(["skill:pdf"]);
  });
});

describe("PluginRegistry toggles", () => {
  it("toggle(false) flips enabled in the catalog and persists across a reload", () => {
    const home = makeHome();
    const claudeDir = makeClaudeDir({ skills: ["pdf"] });
    const reg = new PluginRegistry(home, { claudeDir });
    expect(reg.toggle("skill:pdf", false)).toEqual({ id: "skill:pdf", enabled: false });
    expect(reg.list().find((e) => e.id === "skill:pdf")?.enabled).toBe(false);
    // reload from the same home → the toggle survived (plugins.json)
    const reloaded = new PluginRegistry(home, { claudeDir });
    expect(reloaded.list().find((e) => e.id === "skill:pdf")?.enabled).toBe(false);
  });

  it("re-enabling removes the entry from the file (enabled is the default — file stays minimal)", () => {
    const home = makeHome();
    const reg = new PluginRegistry(home, { claudeDir: makeClaudeDir({ skills: ["pdf"] }) });
    reg.toggle("skill:pdf", false);
    reg.toggle("skill:pdf", true);
    expect(JSON.parse(readFileSync(join(home, "plugins.json"), "utf8"))).toEqual({});
    expect(reg.list().find((e) => e.id === "skill:pdf")?.enabled).toBe(true);
  });

  it("a toggle for a not-currently-listable id is accepted (takes effect whenever the entry appears)", () => {
    const reg = new PluginRegistry(makeHome(), { claudeDir: makeClaudeDir() });
    expect(reg.toggle("command:deploy", false)).toEqual({ id: "command:deploy", enabled: false });
  });

  it("rejects a malformed id with {code:'protocol'}", () => {
    const reg = new PluginRegistry(makeHome(), { claudeDir: makeClaudeDir() });
    for (const bad of ["pdf", "gizmo:pdf", "skill:", ":pdf"])
      expect(() => reg.toggle(bad, false), bad).toThrow(UnknownPluginIdError);
  });

  it("disabledFor() exposes disabled names by kind for the spawn seam (commands deliberately absent — no SDK lever)", () => {
    const reg = new PluginRegistry(makeHome(), { claudeDir: makeClaudeDir() });
    reg.toggle("skill:pdf", false);
    reg.toggle("plugin:superpowers", false);
    reg.toggle("command:deploy", false);
    expect(reg.disabledFor()).toEqual({ disabledSkills: ["pdf"], disabledPlugins: ["superpowers"] });
  });

  it("fails fast on a corrupt plugins.json (a silently re-enabled plugin is an enforcement hole)", () => {
    const home = makeHome();
    writeFileSync(join(home, "plugins.json"), "{nope");
    expect(() => new PluginRegistry(home, { claudeDir: makeClaudeDir() })).toThrow(/corrupt coordination state in .*plugins\.json/);
  });
});
