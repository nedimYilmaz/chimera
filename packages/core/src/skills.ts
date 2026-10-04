import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// SKILL-DISCOVERY — skills an agent can find and load at the moment it needs one, instead of
// carrying all of them in every prompt.
//
// The problem this solves is specific. Skills are not like the other things an agent discovers:
// foreign MCP tools are reachable on demand through mcp_store_tools, and chimera's own deferred
// tools through chimera_tools, but the SDK's `skills` option is "a context filter, not a sandbox —
// unlisted skills are hidden from the model's listing AND REJECTED BY THE SKILL TOOL". So making
// the prompt lean by not listing them does not defer them, it refuses them.
//
// Measured, that mattered: 348 skills rode in every prompt, re-read on every model call, and
// exactly 5 were ever invoked across ~47k calls.
//
// A skill is a SKILL.md file with `name` and `description` frontmatter, and the Skill tool's whole
// job is to put its text in front of the model. Reading that file is something chimera can do
// itself, so the allowlist is bypassed rather than fought: search the index, read the one you want.
//
// Deliberately NOT modelled on the CLI's own plugin naming. That lives in an internal cache layout
// which is free to change; chimera indexes files it can see and mints its own ids from the
// frontmatter, so nothing here breaks when that layout moves.

/** A skill as the index knows it — enough to decide whether to read it, and nothing more. */
export type SkillEntry = { id: string; name: string; description: string; path: string; source: string };

const MAX_SKILL_BYTES = 64 * 1024;
/** Deep enough for `<root>/<group>/<skill>/SKILL.md` plus a couple of levels of plugin nesting,
 *  shallow enough that a stray symlink into a large tree cannot turn this into a full disk walk. */
const MAX_DEPTH = 8;
const INDEX_TTL_MS = 60_000;

function frontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of text.slice(3, end).split("\n")) {
    // Only the two keys that matter, and only the first occurrence: a description running onto a
    // second line is truncated rather than mis-parsed, which is the right trade for an index whose
    // job is to be searchable, not to round-trip the file.
    const m = /^(name|description):\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1] as "name" | "description";
    if (out[key] === undefined) {
      const value = m[2]!;
      out[key] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
    }
  }
  return out;
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || out.length > 5000) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e.startsWith(".") || e === "node_modules") continue;
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, depth + 1, out);
    else if (e === "SKILL.md") out.push(full);
  }
}

/** How to scope the index: the agent's project (its own skills, the ones most likely wanted) and
 *  the home whose user/plugin skills to include. `home` is a real parameter, not a test hook — a
 *  daemon can legitimately run under a different HOME than the one it indexes. */
export type SkillScope = { cwd?: string | undefined; home?: string | undefined; codexHome?: string | undefined };

function roots(scope: SkillScope): Array<{ dir: string; source: string }> {
  const home = scope.home ?? homedir();
  const cwd = scope.cwd;
  const codexHome = scope.codexHome ?? (scope.home === undefined ? process.env.CODEX_HOME : undefined) ?? join(home, ".codex");
  const rs = [
    { dir: join(home, ".agents", "skills"), source: "user" },
    { dir: join(codexHome, "skills"), source: "user" },
    { dir: join(codexHome, "skills", ".system"), source: "system" },
    { dir: join(codexHome, "plugins", "cache"), source: "plugin" },
    { dir: join(home, ".claude", "skills"), source: "user" },
    { dir: join(home, ".claude", "plugins", "cache"), source: "plugin" },
  ];
  if (cwd) {
    const projectRoots = [{ dir: join(cwd, ".claude", "skills"), source: "project" }];
    // Native Codex discovers .agents/skills from cwd through the git root.
    // A worktree's .git is a file, so existence (not isDirectory) is intentional.
    let current = cwd;
    do {
      projectRoots.push({ dir: join(current, ".agents", "skills"), source: "project" });
      if (existsSync(join(current, ".git"))) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    } while (true);
    rs.unshift(...projectRoots);
  }
  return rs.filter((r) => existsSync(r.dir));
}

let cache: { at: number; key: string; entries: SkillEntry[] } | null = null;

/** Every skill on this machine, by name and description.
 *
 *  Cached briefly: an agent that searches, reads and searches again should not re-walk a thousand
 *  files, and skills do not change mid-turn. */
export function indexSkills(scope: SkillScope = {}): SkillEntry[] {
  const key = `${scope.cwd ?? ""}\u0000${scope.home ?? ""}\u0000${scope.codexHome ?? (scope.home === undefined ? process.env.CODEX_HOME ?? "" : "")}`;
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < INDEX_TTL_MS) return cache.entries;

  const entries: SkillEntry[] = [];
  const seen = new Map<string, number>();
  const seenPaths = new Set<string>();
  for (const { dir, source } of roots(scope)) {
    const files: string[] = [];
    walk(dir, 0, files);
    for (const path of files) {
      let head: string;
      try {
        const realPath = realpathSync(path);
        if (seenPaths.has(realPath)) continue;
        seenPaths.add(realPath);
        head = readFileSync(path, "utf8").slice(0, 4096);
      } catch { continue; }
      const fm = frontmatter(head);
      if (!fm.name) continue;
      // Two plugins may ship a skill of the same name. Suffix rather than drop: the second one is
      // still findable, and its path disambiguates it.
      const n = (seen.get(fm.name) ?? 0) + 1;
      seen.set(fm.name, n);
      entries.push({
        id: n === 1 ? fm.name : `${fm.name}#${n}`,
        name: fm.name,
        description: fm.description ?? "",
        path,
        source,
      });
    }
  }
  cache = { at: now, key, entries };
  return entries;
}

/** Rank skills against a natural-language query.
 *
 *  Plain token overlap, weighted toward the name. No embeddings on purpose: the corpus is ~1000
 *  one-line descriptions written to be matched by keyword, and a model that gets ten candidates
 *  back can pick the right one itself — which is cheaper and far more predictable than being
 *  clever here. */
export function searchSkills(query: string, scope: SkillScope = {}, limit = 10): SkillEntry[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const all = indexSkills(scope);
  if (terms.length === 0) return all.slice(0, limit);
  const scored = all.map((e) => {
    const name = e.name.toLowerCase();
    const desc = e.description.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (name.includes(t)) score += 4;
      if (desc.includes(t)) score += 1;
    }
    return { e, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.e);
}

/** The skill's own text — what the Skill tool would have put in front of the model.
 *
 *  Accepts an id, a bare name or a path, because a model that just read a search result may hand
 *  back any of the three. Null when nothing matches, so the caller reports a miss rather than
 *  silently loading the wrong skill. */
export function readSkill(ref: string, scope: SkillScope = {}): { entry: SkillEntry; text: string } | null {
  const all = indexSkills(scope);
  const entry = all.find((e) => e.id === ref)
    ?? all.find((e) => e.name === ref)
    ?? all.find((e) => e.path === ref)
    // A qualified "plugin:skill" from the CLI's own vocabulary — take the part after the colon so
    // a name an operator copied out of a prompt still resolves.
    ?? (ref.includes(":") ? all.find((e) => e.name === ref.slice(ref.lastIndexOf(":") + 1)) : undefined);
  if (!entry) return null;
  let text: string;
  try { text = readFileSync(entry.path, "utf8"); } catch { return null; }
  return { entry, text: text.length > MAX_SKILL_BYTES ? text.slice(0, MAX_SKILL_BYTES) : text };
}
