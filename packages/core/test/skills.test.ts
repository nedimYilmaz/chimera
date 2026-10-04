import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexSkills, readSkill, searchSkills } from "@chimera/core/skills";

// SKILL-DISCOVERY — a lean agent can still find and use a skill.
//
// Skills are the one capability lean context cannot simply defer. Foreign MCP tools stay reachable
// through mcp_store_tools and chimera's own deferred tools through chimera_tools, but the SDK's
// `skills` option is "a context filter, not a sandbox — unlisted skills are hidden from the model's
// listing AND REJECTED BY THE SKILL TOOL". So not listing a skill does not defer it, it refuses it.
//
// A skill is a SKILL.md whose text the Skill tool puts in front of the model, and reading a file is
// something the daemon can do without that allowlist's permission. What is pinned here is that the
// index is honest: it finds what exists, refuses what does not, and never substitutes.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A project whose .claude/skills holds the given skills. */
function project(skills: Array<{ name: string; description?: string; body?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  dirs.push(root);
  for (const s of skills) {
    const dir = join(root, ".claude", "skills", s.name);
    mkdirSync(dir, { recursive: true });
    const fm = s.description === undefined ? `name: ${s.name}` : `name: ${s.name}\ndescription: ${s.description}`;
    writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n\n${s.body ?? "do the thing"}\n`);
  }
  return root;
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

/** Scope the index to the temp project ONLY. Without pinning `home` these tests would also index
 *  the developer's own ~/.claude skills — a thousand of them — and rank against those. */
const scope = (cwd: string) => ({ cwd, home: join(cwd, "no-home") });

describe("the skill index", () => {
  it("discovers Codex project, user, system and plugin skills alongside Claude skills", () => {
    const root = project([{ name: "claude-review" }]);
    mkdirSync(join(root, ".git"));
    const home = join(root, "home");
    const codexHome = join(root, "custom-codex");
    const locations = [
      [join(root, ".agents", "skills", "project"), "codex-project"],
      [join(home, ".agents", "skills", "user"), "codex-user"],
      [join(codexHome, "skills", ".system", "built-in"), "codex-system"],
      [join(codexHome, "plugins", "cache", "plugin", "1", "skills", "review"), "codex-plugin"],
    ];
    for (const [dir, name] of locations) {
      mkdirSync(dir!, { recursive: true });
      writeFileSync(join(dir!, "SKILL.md"), `---\nname: "${name}"\ndescription: 'review code'\n---\nbody`);
    }
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(ids(indexSkills({ cwd: root, home, codexHome }))).toEqual(expect.arrayContaining(["claude-review", "codex-project", "codex-user", "codex-system", "codex-plugin"]));
    expect(readSkill("codex-project", { cwd: nested, home, codexHome })?.entry.description).toBe("review code");
  });

  it("does not duplicate the same skill linked from Claude and Codex roots", () => {
    const root = project([{ name: "shared" }]);
    mkdirSync(join(root, ".agents"));
    symlinkSync(join(root, ".claude", "skills"), join(root, ".agents", "skills"));
    expect(ids(indexSkills(scope(root)))).toEqual(["shared"]);
  });

  it("finds a project's own skills by what they do", () => {
    const cwd = project([
      { name: "pre-push-review", description: "Review a diff for security problems before pushing" },
      { name: "pdf-export", description: "Turn a report into a PDF" },
    ]);
    const hits = searchSkills("security review before push", scope(cwd));
    expect(ids(hits)[0]).toBe("pre-push-review");
  });

  it("weights the NAME above the description", () => {
    // A model searching by name is searching for a thing it already half-knows; a description match
    // is a guess. Ranking them equally buries the exact hit under near-misses.
    const cwd = project([
      { name: "unrelated", description: "mentions debugging debugging debugging debugging" },
      { name: "debugging", description: "something else entirely" },
    ]);
    expect(ids(searchSkills("debugging", scope(cwd)))[0]).toBe("debugging");
  });

  it("returns nothing rather than everything when nothing matches", () => {
    const cwd = project([{ name: "pdf-export", description: "Turn a report into a PDF" }]);
    expect(searchSkills("kubernetes ingress", scope(cwd))).toEqual([]);
  });

  it("reads a skill's full text — that IS the procedure", () => {
    const cwd = project([{ name: "review", description: "d", body: "## Steps\n1. read the diff" }]);
    const got = readSkill("review", scope(cwd));
    expect(got?.text).toContain("1. read the diff");
    expect(got?.entry.name).toBe("review");
  });

  it("resolves a skill by id, by bare name, and by a plugin-qualified name", () => {
    // A model hands back whatever it saw last — a search result id, the name from a prompt, or the
    // CLI's own "plugin:skill" spelling. All three should land on the same file.
    const cwd = project([{ name: "brainstorming", description: "d" }]);
    expect(readSkill("brainstorming", scope(cwd))?.entry.name).toBe("brainstorming");
    expect(readSkill("superpowers:brainstorming", scope(cwd))?.entry.name).toBe("brainstorming");
  });

  it("REFUSES an unknown skill instead of returning the nearest one", () => {
    // The dangerous failure. A near match would silently run a different procedure than the one
    // asked for, and nothing downstream could tell.
    const cwd = project([{ name: "review", description: "d" }]);
    expect(readSkill("reviewer", scope(cwd))).toBeNull();
    expect(readSkill("", scope(cwd))).toBeNull();
  });

  it("keeps both when two skills share a name, rather than dropping one", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-dup-"));
    dirs.push(root);
    for (const group of ["a", "b"]) {
      const dir = join(root, ".claude", "skills", group, "review");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: review\ndescription: from ${group}\n---\nbody\n`);
    }
    const all = indexSkills(scope(root)).filter((e) => e.name === "review");
    expect(all).toHaveLength(2);
    expect(new Set(all.map((e) => e.id)).size).toBe(2);
  });

  it("ignores a file with no name, and survives a directory that is not there", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-bad-"));
    dirs.push(root);
    const dir = join(root, ".claude", "skills", "nameless");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter at all\n");
    expect(indexSkills(scope(root)).filter((e) => e.path.startsWith(root))).toEqual([]);
    expect(() => indexSkills(scope(join(root, "does-not-exist")))).not.toThrow();
  });
});
