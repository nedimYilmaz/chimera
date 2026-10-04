import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpStoreImportable } from "@chimera/protocol";

// MCP-STORE P3: find LOCAL STDIO MCP servers already configured for claude/codex on this
// machine so an operator can copy one into the store instead of retyping command/args/env.
//
// SOURCES (read-only, same "never touch ~/.claude" discipline as plugins.ts). Every one of these
// is a place claude or codex will happily run a server FROM, so a place this scan does not read is
// a server the operator can see in claude and not here — indistinguishable, from the store's list,
// from one that cannot be imported at all:
//   * ~/.claude.json TOP-LEVEL `mcpServers` — USER scope, what `claude mcp add --scope user`
//     writes and what claude's /mcp screen calls "User MCPs".
//   * ~/.claude.json `projects[<cwd>].mcpServers` — per-project servers approved via
//     `claude mcp add` / a project-level config. type stdio (the default, `command` present)
//     is importable; type http/sse (a `url`, no `command`) is a REMOTE connector.
//   * ~/.claude/plugins/installed_plugins.json (already read by PluginRegistry) → each installed
//     plugin's manifest, dotted or undotted (both are shipped in practice), same stdio/http split.
//   * ~/.codex/config.toml `[mcp_servers.<name>]` tables — best-effort single-line TOML, matching
//     the shape `codex mcp add` writes: a local `command`/`args`/`env`, or a remote `url`. No TOML
//     dependency in this repo; multi-line arrays/tables are simply not recognized (documented,
//     not faked).
//
// Results are de-duped ONCE, in scan(), on what would actually be imported — the same server
// really is configured in two scopes routinely, and two servers really do share a name while
// pointing somewhere different.
//
// HONESTY REQUIREMENT (research finding, verified via `claude mcp list` on this machine):
// claude.ai-MANAGED connectors (Slack/Gmail/Drive/Stripe/... — scope "claude.ai config",
// always an http/sse URL) are NOT bridgeable: their auth lives in the claude.ai session, not
// in any local credential this daemon could read. A real claude.ai connector never even
// appears in ~/.claude.json's per-project map (it lives in the separate "claude.ai config"
// scope `claude mcp list` showed) — but a project-level http/sse entry that HAPPENS to point
// at one of those well-known hosts still gets flagged not-importable below, just in case.
// MCP-REMOTE-IMPORT slice 2: every OTHER remote (http/sse) row IS importable — the store's
// http transport (mcpstore.ts) can connect to it directly, with auth injected at connect
// time from the keychain once `mcpstore.setAuth` seeds a secret.
//
// chimera's OWN MCP entry (packages/mcp/bin/chimera-mcp.js) is excluded everywhere below —
// importing it would be a circular, pointless store entry.

export type FsSeam = { exists: (path: string) => boolean; readFile: (path: string) => string };

const realFs: FsSeam = { exists: existsSync, readFile: (p) => readFileSync(p, "utf8") };

const REMOTE_NOT_IMPORTABLE_REASON = "not importable (remote http/sse MCP connector — no local command to run)";
const CLAUDE_AI_NOT_IMPORTABLE_REASON = "not importable (claude.ai-managed auth — the connector's credentials live in the claude.ai session, not on this machine)";

function isChimeraOwnServer(name: string, command?: string, args?: string[]): boolean {
  if (name === "chimera") return true;
  return (command === process.execPath || command === "node") && (args ?? []).some((a) => a.includes("chimera-mcp"));
}

type RawServerEntry = { type?: string; command?: string; args?: unknown; env?: unknown; url?: string; headers?: unknown };

// `requiresAuth: true` on every remote row -- whether or not it turns out to need a header --
// is a deliberately conservative default (the UI's cue to offer mcpstore.setAuth before/after
// import); a remote server with genuinely no auth still connects fine with no keychain entry
// set, since connect-time injection (mcpstore.ts) only fires when the ADDED entry carries an
// explicit `auth` field.
function toImportable(source: "claude" | "codex", name: string, raw: RawServerEntry): McpStoreImportable | null {
  if (isChimeraOwnServer(name, raw.command, Array.isArray(raw.args) ? (raw.args as string[]) : undefined)) return null;
  const isRemote = raw.type === "http" || raw.type === "sse" || (typeof raw.url === "string" && raw.url.length > 0 && !raw.command);
  if (isRemote) {
    if (typeof raw.url !== "string" || raw.url.length === 0) {
      return { source, name, notImportableReason: REMOTE_NOT_IMPORTABLE_REASON };
    }
    const headers = raw.headers && typeof raw.headers === "object" ? Object.fromEntries(
      Object.entries(raw.headers as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"),
    ) : {};
    // claude.ai-managed connectors stay a DISTINCT "known url, unreachable session auth"
    // state: same type/url/headers/requiresAuth shape as an ordinary remote, but they ALSO
    // keep notImportableReason since there is no portable secret a plain import can carry over.
    const claudeAiManaged = raw.url.includes("claude.ai") || raw.url.includes("mcp.slack.com") || raw.url.includes("googleapis.com");
    return {
      source, name, type: "http", url: raw.url, headers, requiresAuth: true,
      ...(claudeAiManaged ? { notImportableReason: CLAUDE_AI_NOT_IMPORTABLE_REASON } : {}),
    };
  }
  if (!raw.command) {
    return { source, name, notImportableReason: REMOTE_NOT_IMPORTABLE_REASON };
  }
  const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [];
  const env = raw.env && typeof raw.env === "object" ? Object.fromEntries(
    Object.entries(raw.env as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"),
  ) : {};
  return { source, name, command: raw.command, args, env };
}

function scanClaudeJson(fs: FsSeam, claudeJsonPath: string): McpStoreImportable[] {
  if (!fs.exists(claudeJsonPath)) return [];
  let parsed: {
    mcpServers?: Record<string, RawServerEntry>;
    projects?: Record<string, { mcpServers?: Record<string, RawServerEntry> }>;
  };
  try {
    parsed = JSON.parse(fs.readFile(claudeJsonPath));
  } catch {
    return [];   // best-effort scan — an unreadable/corrupt file just contributes nothing
  }
  // Collected, not de-duped: scan() applies ONE de-dupe rule over every source. Keeping a second
  // key here is what let a name-plus-command key drop one of two same-named REMOTES (both have no
  // command, so both hashed to the same slot) before the real rule ever saw them.
  const out: McpStoreImportable[] = [];
  const take = (name: string, raw: RawServerEntry): void => {
    const importable = toImportable("claude", name, raw);
    if (importable) out.push(importable);
  };
  // USER SCOPE — the TOP-LEVEL `mcpServers`, what `claude mcp add --scope user` writes and what
  // claude's own /mcp screen lists as "User MCPs". Scanning only the per-project map below missed
  // every one of them: on the machine this was found on, five servers were visible in claude and
  // absent here, while `gateway` showed up anyway because it ALSO happened to be configured for a
  // project. Partial success is exactly what hid the gap.
  for (const [name, raw] of Object.entries(parsed.mcpServers ?? {})) take(name, raw);
  // PROJECT SCOPE — `claude mcp add` without --scope, or a project-level config.
  for (const project of Object.values(parsed.projects ?? {})) {
    for (const [name, raw] of Object.entries(project.mcpServers ?? {})) take(name, raw);
  }
  return out;
}

function scanClaudePlugins(fs: FsSeam, claudeDir: string): McpStoreImportable[] {
  const manifestPath = join(claudeDir, "plugins", "installed_plugins.json");
  if (!fs.exists(manifestPath)) return [];
  let manifest: { plugins?: Record<string, Array<{ installPath?: string }>> };
  try {
    manifest = JSON.parse(fs.readFile(manifestPath));
  } catch {
    return [];
  }
  const out: McpStoreImportable[] = [];   // de-duped once, in scan()
  for (const installs of Object.values(manifest.plugins ?? {})) {
    const installPath = installs?.[0]?.installPath;
    if (typeof installPath !== "string" || installPath === "") continue;
    // Both spellings. The documented plugin layout is the dotfile, but shipped plugins also use
    // the undotted name (mongodb's does), and a plugin whose MCP server is simply invisible gives
    // no signal that anything was missed.
    const mcpJsonPath = [join(installPath, ".mcp.json"), join(installPath, "mcp.json")]
      .find((candidate) => fs.exists(candidate));
    if (mcpJsonPath === undefined) continue;
    let mcpJson: { mcpServers?: Record<string, RawServerEntry> };
    try {
      mcpJson = JSON.parse(fs.readFile(mcpJsonPath));
    } catch {
      continue;
    }
    for (const [name, raw] of Object.entries(mcpJson.mcpServers ?? {})) {
      const importable = toImportable("claude", name, raw);
      if (importable) out.push(importable);
    }
  }
  return out;
}

// Minimal single-line-value TOML reader scoped to `[mcp_servers.<name>]` tables — exactly
// the shape `codex mcp add` writes (command = "...", args = ["...", ...], env = {K = "V"}).
// Any other table ends the current block; multi-line arrays/tables are not recognized.
function parseCodexMcpServers(text: string): McpStoreImportable[] {
  const headerRe = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/;
  const stringsRe = /"((?:[^"\\]|\\.)*)"/g;
  const envPairRe = /([A-Za-z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  const out: McpStoreImportable[] = [];
  let current: { name: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string } | null = null;
  const flush = () => {
    // A codex table is EITHER a local command or a remote `url` — the claude side has always
    // handled both, and requiring `command` here silently dropped every remote codex server
    // (`[mcp_servers.x]` + `url = "..."`, which is what `codex mcp add` writes for one). The
    // asymmetry was the bug: toImportable below already knows how to describe a remote.
    if (current?.command || current?.url) {
      const importable = toImportable("codex", current.name, {
        ...(current.command !== undefined ? { command: current.command, args: current.args, env: current.env } : {}),
        ...(current.url !== undefined ? { url: current.url } : {}),
      });
      if (importable) out.push(importable);
    }
    current = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = headerRe.exec(line);
    if (header) { flush(); current = { name: header[1]! }; continue; }
    if (line.startsWith("[")) { flush(); continue; }
    if (!current) continue;
    if (line.startsWith("command")) {
      const m = /^command\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line);
      if (m) current.command = m[1];
    } else if (line.startsWith("url")) {
      const m = /^url\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line);
      if (m) current.url = m[1];
    } else if (line.startsWith("args")) {
      const m = /^args\s*=\s*\[(.*)\]/.exec(line);
      if (m) current.args = [...m[1]!.matchAll(stringsRe)].map((mm) => mm[1]!);
    } else if (line.startsWith("env")) {
      const m = /^env\s*=\s*\{(.*)\}/.exec(line);
      if (m) current.env = Object.fromEntries([...m[1]!.matchAll(envPairRe)].map((mm) => [mm[1]!, mm[2]!]));
    }
  }
  flush();
  return out;
}

function scanCodex(fs: FsSeam, codexConfigPath: string): McpStoreImportable[] {
  if (!fs.exists(codexConfigPath)) return [];
  try {
    return parseCodexMcpServers(fs.readFile(codexConfigPath));
  } catch {
    return [];
  }
}

export class McpImportScanner {
  private fs: FsSeam;
  private claudeJsonPath: string;
  private claudeDir: string;
  private codexConfigPath: string;

  constructor(opts: { fs?: FsSeam; claudeJsonPath?: string; claudeDir?: string; codexConfigPath?: string } = {}) {
    this.fs = opts.fs ?? realFs;
    this.claudeJsonPath = opts.claudeJsonPath ?? join(homedir(), ".claude.json");
    this.claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
    this.codexConfigPath = opts.codexConfigPath ?? join(homedir(), ".codex", "config.toml");
  }

  // async signature: every current source is sync fs, but a future source (e.g. shelling
  // to `claude mcp list`) may need it — callers already await this.
  async scan(): Promise<McpStoreImportable[]> {
    // De-duped ACROSS sources, not just within each one. The same server is routinely configured
    // twice — a plugin ships it and the operator also added it at user scope — and before user
    // scope was scanned at all that overlap could not happen, so each source de-duping itself was
    // enough. It is not any more.
    //
    // Keyed on what would actually be imported (the command, or the url for a remote) so two
    // entries that merely SHARE A NAME while pointing somewhere different both survive: collapsing
    // those would silently hide one of them, the same class of bug as the missing user scope.
    // `source` stays in the key because it is shown to the operator and is not a duplicate detail.
    const seen = new Map<string, McpStoreImportable>();
    for (const row of [
      ...scanClaudeJson(this.fs, this.claudeJsonPath),
      ...scanClaudePlugins(this.fs, this.claudeDir),
      ...scanCodex(this.fs, this.codexConfigPath),
    ]) {
      const key = `${row.source} ${row.name} ${row.command ?? row.url ?? ""} ${(row.args ?? []).join(" ")}`;
      if (!seen.has(key)) seen.set(key, row);
    }
    return [...seen.values()];
  }
}

// INJECTION-DESCRIPTION-SCAN: a small, HIGH-PRECISION pattern set for flagging an MCP tool
// description that reads as prompt-injection/C2 rather than an ordinary tool description --
// warn-only (see mcpstore.ts's call site; never blocks a connection or a tool call). Text a
// server advertises here lands in every connected agent's system prompt before any tool is
// ever called, which is why it's worth scanning at all despite being a static string, not a
// live tool result.
//
// PATTERN DISCIPLINE (lesson from Hermes' own post-mortem, which shipped and then reverted a
// "praxis" pattern for being a common word / legitimate agent name): anchor on C2-specific
// vocabulary or UNAMBIGUOUS attack behavior, never on bossy phrasing. "You must" / "you are
// obligated to" appear constantly in legitimate CLAUDE.md/AGENTS.md-style tool descriptions and
// would swamp this with false positives — deliberately absent from the list below. Prefer a
// handful of high-precision patterns over broad coverage.
const INJECTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "ignore-prior-instructions", re: /\b(ignore|disregard)\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)\b/i },
  { name: "reveal-system-prompt", re: /\breveal\s+(your\s+|the\s+)?(system\s+prompt|hidden\s+instructions?)\b/i },
  { name: "exfiltrate-credentials", re: /\b(send|post|exfiltrate|upload)\s+(the\s+|your\s+|this\s+)?(api[\s-]?key|credentials?|secret|token|password)s?\s+to\b/i },
  { name: "hide-from-user", re: /\bdo\s+not\s+(tell|inform|mention\s+(this\s+)?to)\s+(the\s+)?user\b/i },
  { name: "jailbreak-mode", re: /\byou\s+are\s+now\s+(in\s+)?(DAN|developer\s+mode|jailbreak(?:ed)?\s+mode)\b/i },
  // Zero-width/invisible Unicode formatting characters are a genuine, unambiguous obfuscation
  // technique (hiding text from a human reviewer while an LLM still reads it) -- essentially
  // never appears in a legitimate tool description, so this is high-precision by construction
  // rather than by vocabulary choice.
  { name: "invisible-unicode", re: /[​‌‍⁠﻿]/ },
];

export function scanForInjectionPatterns(text: string): string[] {
  if (text === "") return [];
  return INJECTION_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

// mcpstore.import: turn an arbitrary importable name into a valid McpStoreNameSchema value
// (lowercase letters/digits/-, starting alnum) — importable names come from claude/codex's
// own namespace (e.g. "ui5-mcp-server", already-kebab) but are not guaranteed to match ours.
export function sanitizeMcpStoreName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  return sanitized.length > 0 ? sanitized.slice(0, 64) : "imported-server";
}
