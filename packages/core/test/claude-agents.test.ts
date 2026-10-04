import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanClaudeAgents } from "@chimera/core/claude-agents";

// PROJECT-NATIVE-TEAMS T2: parses .claude/agents/*.md (Claude Code sub-agent
// format) into RoleTemplates. READ-ONLY toward .claude, fail-soft per file —
// mirrors plugins.test.ts's fake-directory-per-test style.

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chimera-claudeagents-"));
  const agentsDir = join(dir, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(agentsDir, name), content);
  }
  return dir;
}

describe("scanClaudeAgents", () => {
  it("returns {} when the project has no .claude/agents dir — never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-noagents-"));
    expect(scanClaudeAgents(dir, { settingSources: [] })).toEqual({});
  });

  it("parses a full frontmatter file (edit tools) into a RoleTemplate", () => {
    const project = makeProject({
      "reviewer.md": [
        "---",
        "name: Code Reviewer",
        "description: Reviews pull requests for bugs",
        "model: claude-sonnet-5",
        "tools: Read, Edit, Bash",
        "---",
        "",
        "You are a meticulous code reviewer. Flag correctness issues first.",
      ].join("\n"),
    });

    const roles = scanClaudeAgents(project, { settingSources: ["project", "user"] });
    expect(Object.keys(roles)).toEqual(["Code-Reviewer"]);
    const role = roles["Code-Reviewer"]!;
    expect(role.provider).toBe("claude");
    expect(role.cwd).toBe(project);
    expect(role.isolation).toBe("worktree");
    expect(role.model).toBe("claude-sonnet-5");
    expect(role.permissionProfile).toBe("acceptEdits");
    expect(role.inherit.settingSources).toEqual(["project", "user"]);
    expect(role.instructions).toContain("Reviews pull requests for bugs");
    expect(role.instructions).toContain("meticulous code reviewer");
    expect(role.orchestration).toEqual({ allow: true, maxDepth: 2 });
  });

  it("a read-only tools list maps to permissionProfile readOnly", () => {
    const project = makeProject({
      "auditor.md": [
        "---",
        "name: auditor",
        "description: Read-only audit pass",
        "tools: Read, Grep, Glob",
        "---",
        "Look but don't touch.",
      ].join("\n"),
    });

    const roles = scanClaudeAgents(project, { settingSources: [] });
    expect(roles.auditor!.permissionProfile).toBe("readOnly");
  });

  it("no tools field ⇒ inherits everything ⇒ acceptEdits, not readOnly", () => {
    const project = makeProject({
      "generalist.md": ["---", "name: generalist", "description: no tools key at all", "---", "Body."].join("\n"),
    });
    const roles = scanClaudeAgents(project, { settingSources: [] });
    expect(roles.generalist!.permissionProfile).toBe("acceptEdits");
  });

  it("falls back to the filename when frontmatter has no name key", () => {
    const project = makeProject({
      "fallback-name.md": ["---", "description: no name key", "---", "Body."].join("\n"),
    });
    const roles = scanClaudeAgents(project, { settingSources: [] });
    expect(Object.keys(roles)).toEqual(["fallback-name"]);
  });

  it("skips a file with no frontmatter block at all", () => {
    const project = makeProject({
      "plain.md": "# just a markdown file\n\nno frontmatter here.",
    });
    const roles = scanClaudeAgents(project, { settingSources: [] });
    expect(roles).toEqual({});
  });

  it("skips a file with malformed YAML frontmatter, keeps valid siblings", () => {
    const project = makeProject({
      "good.md": ["---", "name: good", "description: fine", "---", "Body."].join("\n"),
      "bad.md": ["---", "name: bad", "  this is not: key: value: yaml [[", "---", "Body."].join("\n"),
    });
    const roles = scanClaudeAgents(project, { settingSources: [] });
    expect(Object.keys(roles)).toEqual(["good"]);
  });

  it("folds a name with spaces/dots into a CoordName-safe role key", () => {
    const project = makeProject({
      "x.md": ["---", "name: My.Cool Agent!!", "---", "Body."].join("\n"),
    });
    const roles = scanClaudeAgents(project, { settingSources: [] });
    expect(Object.keys(roles)).toEqual(["My-Cool-Agent"]);
  });

  it("never writes anything under the project's .claude directory", () => {
    const project = makeProject({
      "a.md": ["---", "name: a", "---", "Body."].join("\n"),
    });
    const before = JSON.stringify(readdirSync(join(project, ".claude", "agents")));
    scanClaudeAgents(project, { settingSources: [] });
    const after = JSON.stringify(readdirSync(join(project, ".claude", "agents")));
    expect(after).toBe(before);
  });
});
