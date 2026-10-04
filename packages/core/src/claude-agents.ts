import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RoleSpecSchema, type RoleSpec } from "@chimera/protocol";

// PROJECT-NATIVE-TEAMS T2: parse a project's .claude/agents/*.md (Claude Code
// sub-agent format) into RoleSpecs a team_create can spawn directly. ROLES-UNIFY: the
// `name` set here is a placeholder (the un-qualified role key) — syncProjectTeam
// (engine.ts) is the one that knows the owning team, so it re-stamps the team-qualified
// `<team>.<key>` name before writing this into the role library (§3.2/§7 step 4).
//
// READ-ONLY toward .claude by the same hard rule as plugins.ts: this module
// never writes anything under the project's .claude directory. Every file is
// fail-soft — a missing dir, unreadable file, absent frontmatter, or broken
// YAML drops just that one file (logged) and never throws.

export type SettingSource = "user" | "project" | "local";

// A read-only tool name (Claude Code's own casing). Any `tools:` list drawn
// entirely from this set maps to "readOnly"; anything else (including an
// absent `tools:` key, which means "inherit everything") maps to "acceptEdits".
// RESIDUAL: RoleSpec's permissionProfile is a 3-way enum (readOnly /
// acceptEdits / full) — it cannot represent an exact per-tool allowlist like
// "Read, Grep, Bash(git *)". Sub-agents with a bespoke tool list are folded
// into the nearest coarse profile; the precise list is not recoverable here.
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob"]);

interface ParsedAgentFile {
  name?: string;
  description?: string;
  model?: string;
  tools?: string;
  body: string;
}

// Minimal frontmatter parser for the flat `key: value` YAML sub-agent files
// actually emit — no nesting, no multi-doc, no anchors. Returns null (never
// throws) when the file has no `---` delimited block or a line inside it
// doesn't parse as `key: value`, which the caller treats as "skip this file".
function parseFrontmatter(raw: string): ParsedAgentFile | null {
  if (!raw.startsWith("---")) return null;
  const firstNewline = raw.indexOf("\n");
  if (firstNewline === -1) return null;
  const closeIdx = raw.indexOf("\n---", firstNewline);
  if (closeIdx === -1) return null;
  const block = raw.slice(firstNewline + 1, closeIdx);
  const rest = raw.slice(closeIdx + 4);
  const body = rest.replace(/^\r?\n/, "");

  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) return null;   // a non "key: value" line inside the block ⇒ malformed
    const key = m[1]!;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return { name: fields.name, description: fields.description, model: fields.model, tools: fields.tools, body };
}

// Fold a sub-agent name into a CoordName-safe role key: mirrors
// deriveProjectName in projects.ts (every char outside [A-Za-z0-9_-] → "-",
// leading/trailing "-" stripped). Exported for engine.ts's syncProjectTeam
// (PROJECT-NATIVE-TEAMS T3), which folds the project-native team's own name.
export function foldRoleKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function permissionProfileFor(tools: string | undefined): "readOnly" | "acceptEdits" {
  if (!tools) return "acceptEdits";   // absent ⇒ inherits every tool, not read-only
  const list = tools.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  if (list.length === 0) return "acceptEdits";
  return list.every((t) => READ_ONLY_TOOLS.has(t)) ? "readOnly" : "acceptEdits";
}

export function scanClaudeAgents(
  projectPath: string,
  opts: { settingSources: SettingSource[] },
): Record<string, RoleSpec> {
  const dir = join(projectPath, ".claude", "agents");
  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => e.name)
      .sort();
  } catch {
    return {};   // no .claude/agents dir ⇒ no discovered roles, not an error
  }

  const out: Record<string, RoleSpec> = {};
  for (const fileName of files) {
    const path = join(dir, fileName);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      console.error(`[claude-agents] skipping unreadable ${path}: ${(err as Error).message}`);
      continue;
    }

    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      console.error(`[claude-agents] skipping ${path}: missing or malformed frontmatter`);
      continue;
    }

    const rawName = parsed.name?.trim() || fileName.replace(/\.md$/i, "");
    const roleKey = foldRoleKey(rawName);
    if (!roleKey) {
      console.error(`[claude-agents] skipping ${path}: no usable role name after folding "${rawName}"`);
      continue;
    }

    const description = parsed.description?.trim() ?? "";
    const body = parsed.body.trim();
    const instructions = description && body ? `${description}\n\n${body}` : description || body || undefined;

    out[roleKey] = RoleSpecSchema.parse({
      name: roleKey, // placeholder — syncProjectTeam re-stamps this to "<team>.<roleKey>"
      cwd: projectPath,
      provider: "claude",
      isolation: "worktree",
      model: parsed.model?.trim() || undefined,
      instructions,
      permissionProfile: permissionProfileFor(parsed.tools),
      inherit: { settingSources: opts.settingSources },
    });
  }
  return out;
}
