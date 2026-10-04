import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ToolPolicySchema, type ToolPolicy, type ToolPolicyMode } from "@chimera/protocol";
import type { ExecFn } from "./credentials.js";

// WD Stage 2 (coverage B14): host tool discovery + the toolPolicy store + the Bash
// argv/env parsing the supervisor's decidePermission gate consumes. Three pieces,
// one file (per the workstream brief: "core hosttools.ts").
//
// SECURITY INVARIANTS (coverage B14, non-negotiable):
//   * READ-ONLY probes only — exactly the version probes and the four auth
//     ENUMERATION commands listed below. Nothing here ever runs an auth/refresh/
//     login command, and nothing ever reads or carries a credential VALUE — the
//     enumerations yield NAMES (contexts/profiles/accounts) only.
//   * Every probe is execFile (never a shell), bounded by a 3s timeout, and a
//     missing tool simply skips — a probe failure can never throw out of the scan.

export class InvalidPolicyError extends Error { code = "protocol" as const; name = "InvalidPolicyError"; }

// The curated probe set — PATH lookup happens implicitly via execFile (an ENOENT
// is a failed probe → tool absent). Fixed list by design: the scanner must never
// execute an arbitrary/caller-named binary.
export const CURATED_HOST_TOOLS = [
  "kubectl", "aws", "gcloud", "gh", "docker", "terraform",
  "node", "pnpm", "npm", "git", "cargo", "python3",
] as const;
export type CuratedHostTool = (typeof CURATED_HOST_TOOLS)[number];

// Per-tool version invocation: `--version` except where the tool only speaks a
// `version` subcommand (kubectl needs --client so the probe never dials a cluster).
const VERSION_ARGS: Partial<Record<CuratedHostTool, string[]>> = {
  kubectl: ["version", "--client"],
  terraform: ["version"],
};

// The four read-only auth enumerations — EXACTLY these, per the brief; never any
// other subcommand. gcloud's --format keeps output to bare account names.
const PROFILE_ARGS: Partial<Record<CuratedHostTool, string[]>> = {
  kubectl: ["config", "get-contexts", "-o", "name"],
  aws: ["configure", "list-profiles"],
  gcloud: ["auth", "list", "--format=value(account)"],
  gh: ["auth", "status"],
};

export type HostToolInfo = { tool: string; version: string; profiles: string[] };

// Local exec with the scan's own 3s bound (credentials.ts's realExec is 15s — too
// generous for a parallel 12-tool sweep) and stderr FOLDED INTO stdout: `gh auth
// status` historically printed to stderr, and several tools print versions there.
// Same ExecFn shape as the rest of the repo so tests inject a mock identically.
const scanExec: ExecFn = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3_000 }, (err, stdout, stderr) =>
      resolve({ stdout: `${stdout ?? ""}${stderr ?? ""}`, code: err ? 1 : 0 }));
  });

// First version-looking token of the first non-empty line ("v22.1.0" → "22.1.0",
// "Terraform v1.9.4" → "1.9.4"); falls back to that line (bounded) when no dotted
// number exists, so an unusual banner still yields SOMETHING displayable.
export function parseVersion(stdout: string): string {
  const line = stdout.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  const m = line.match(/\d+(?:\.\d+)+[^\s,;)"']*/);
  return (m ? m[0] : line).slice(0, 60);
}

// Profile/context NAME extraction per tool. Line-per-name tools just split;
// gh needs parsing: current output is "✓ Logged in to github.com account NAME
// (keyring)", older gh said "Logged in to github.com as NAME (oauth_token)" —
// match both. Only names ever leave this function.
export function parseProfiles(tool: string, stdout: string): string[] {
  if (tool === "gh") {
    const names = new Set<string>();
    for (const m of stdout.matchAll(/(?:\baccount|\bas)\s+([^\s(]+)/g)) names.add(m[1]!);
    return [...names];
  }
  return stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

// The discovery scanner. CACHING CONTRACT (documented design decision per the
// brief): the scan is LAZY — it runs on the first tools() call and is reused until
// 15 minutes have passed, at which point the NEXT tools() call re-probes. There is
// deliberately no background timer: the UI calls host.tools on connect (its
// "on-connect refresh") and keeps polling, so staleness-gated lazy refresh gives
// the same 15-minute cadence without a daemon-side interval to manage. cached()
// exposes the last completed scan WITHOUT triggering one — peer.status uses it so
// a remote peer can never cause local process execution.
export class HostToolsScanner {
  private exec: ExecFn;
  private now: () => number;
  private staleMs: number;
  private cache: { scannedAt: number; tools: HostToolInfo[] } | null = null;
  private inflight: Promise<HostToolInfo[]> | null = null;

  constructor(opts: { exec?: ExecFn; now?: () => number; staleMs?: number } = {}) {
    this.exec = opts.exec ?? scanExec;
    this.now = opts.now ?? Date.now;
    this.staleMs = opts.staleMs ?? 15 * 60_000;
  }

  cached(): HostToolInfo[] | null { return this.cache?.tools ?? null; }

  async tools(): Promise<HostToolInfo[]> {
    if (this.cache && this.now() - this.cache.scannedAt < this.staleMs) return this.cache.tools;
    // Concurrent callers during a scan share one probe sweep (never a probe storm).
    this.inflight ??= this.scan().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async scan(): Promise<HostToolInfo[]> {
    const probed = await Promise.all(CURATED_HOST_TOOLS.map(async (tool): Promise<HostToolInfo | null> => {
      const { stdout, code } = await this.exec(tool, VERSION_ARGS[tool] ?? ["--version"]);
      if (code !== 0) return null;                           // missing tool (or broken install) → skip
      const version = parseVersion(stdout);
      if (version === "") return null;                       // no output at all — treat as absent
      let profiles: string[] = [];
      const profileArgs = PROFILE_ARGS[tool];
      if (profileArgs) {
        // guarded: a failing enumeration (not logged in, no config) yields [] — never an error
        const res = await this.exec(tool, profileArgs);
        if (res.code === 0) profiles = parseProfiles(tool, res.stdout);
      }
      return { tool, version, profiles };
    }));
    const tools = probed.filter((t): t is HostToolInfo => t !== null);
    this.cache = { scannedAt: this.now(), tools };
    return tools;
  }
}

// ---------- toolPolicy store ----------
// Effective policy = config.json's OPTIONAL `toolPolicy` field overlaid by
// $CHIMERA_HOME/toolpolicy.json (host.setPolicy's persistence target). config.json
// is user-owned by this codebase's convention — loadConfig only ever READS it, and
// nothing daemon-side may start writing it — so mutations land in the overlay.
// PRECEDENCE (documented contract): profile-specific beats wildcard ("*");
// within the same specificity, the overlay beats config. Unlisted tool/profile →
// "allow" (policy is opt-in; coverage B14's "allow → untouched").
export class ToolPolicyStore {
  private overlay: ToolPolicy = {};
  private file: string;

  constructor(dir: string, private config: ToolPolicy = {}) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "toolpolicy.json");
    if (existsSync(this.file)) {
      try {
        this.overlay = ToolPolicySchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
      } catch (err) {
        // Fail fast (teams.json discipline): silently dropping a deny rule on a
        // corrupt overlay would be a SECURITY hole, not a display glitch.
        throw new Error(
          `corrupt coordination state in ${this.file}: ${(err as Error).message} — fix or remove the file and restart chimerad`,
        );
      }
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;                          // write-to-temp-then-rename: no torn writes
    writeFileSync(tmp, JSON.stringify(this.overlay, null, 2));
    renameSync(tmp, this.file);
  }

  // The enforcement lookup (supervisor decidePermission). `profile` null means the
  // command carried no detectable context/profile — only the wildcard applies.
  modeFor(tool: string, profile: string | null): ToolPolicyMode {
    const o = this.overlay[tool];
    const c = this.config[tool];
    if (profile !== null) {
      const specific = o?.[profile] ?? c?.[profile];
      if (specific) return specific;
    }
    return o?.["*"] ?? c?.["*"] ?? "allow";
  }

  // GATED-BUT-ALLOWED-INVISIBLE: is this tool's access actually CONDITIONAL — does at least one
  // configured row (either layer, any profile) resolve to something other than "allow"? That is
  // the real test for "would normally be asked about, but was auto-allowed THIS time" (the
  // owner's own framing). Deliberately NOT "does any row exist at all": a first cut used that
  // weaker test and was WRONG — sanity-checked against this machine's real ~4200-event
  // capability_decision archive, `gh: {"*": "allow"}` (a blanket, never-gated gh policy,
  // configured only for audit visibility) accounted for 285 of 421 "gated" hits, drowning the
  // 136 genuinely interesting kubectl ones. A tool whose ENTIRE configured policy is uniformly
  // "allow" never gates anything — it behaves identically to being unconfigured from the
  // "would this specific call have gone differently under a different profile/context" angle,
  // so it must be excluded exactly like true argv-parsing noise (`head`/`wc`). kubectl's real
  // policy (`"*": deny, eks-qa: allow, ...`) DOES have a non-allow row, so an eks-qa call
  // correctly flags: that context specifically dodged the wildcard deny every OTHER context hits.
  hasExplicitPolicy(tool: string): boolean {
    const rows = { ...this.config[tool], ...this.overlay[tool] };
    return Object.values(rows).some((mode) => mode !== "allow");
  }

  // MCP-FOREIGN-POLICY: the foreign-MCP-tool lookup (CapabilityBroker.decideMcpTool). Unlike
  // modeFor above it DISTINGUISHES "no policy set" (null) from an explicit "allow", because
  // foreign MCP defaults to ASK, not allow — the caller needs the unset case to be observable.
  // Convention (documented contract, mirrored in protocol's ToolPolicyModeSchema comment): a
  // policy key is EITHER the exact tool name "mcp__<server>__<tool>" OR the server key
  // "mcp__<server>"; the exact tool name always wins over the server key, and within each key
  // the overlay wins over config (same overlay-beats-config precedence modeFor uses). Only the
  // "*" wildcard row is consulted — an MCP call carries no CLI profile dimension.
  modeForMcpMaybe(tool: string, serverKey: string): ToolPolicyMode | null {
    return this.rawWildcard(tool) ?? this.rawWildcard(serverKey);
  }

  private rawWildcard(key: string): ToolPolicyMode | null {
    return this.overlay[key]?.["*"] ?? this.config[key]?.["*"] ?? null;
  }

  set(tool: string, profile: string, mode: ToolPolicyMode): void {
    this.overlay = { ...this.overlay, [tool]: { ...this.overlay[tool], [profile]: mode } };
    this.save();
  }

  // D7 (hot-reload, coverage C9/C10): refresh the config-layer policy when the effective
  // config's `toolPolicy` changes. The $CHIMERA_HOME/toolpolicy.json OVERLAY (host.setPolicy
  // writes) is untouched and keeps winning per key — this only swaps the lower-precedence
  // config layer. The supervisor's decidePermission reads modeFor fresh per decision, so the
  // change applies immediately (the "toolPolicy → immediate" diff-apply rule).
  setConfig(config: ToolPolicy): void {
    this.config = config;
  }

  // Display view (host.tools rows): the merged per-profile map, overlay winning
  // per key. {} means "no policy configured" → effective allow everywhere.
  policyFor(tool: string): Record<string, ToolPolicyMode> {
    return { ...this.config[tool], ...this.overlay[tool] };
  }
}

// ---------- Bash argv/env parsing (the decidePermission gate's input) ----------
// Best-effort by declared contract: a quote-aware tokenizer splits the command
// into pipeline/sequence segments (unquoted && || ; | & and newlines); each
// segment's leading VAR=value assignments are collected, the first real token's
// basename is the candidate tool, and the profile/context is detected per tool:
//   kubectl → --context X | --context=X   (KUBECONFIG names a FILE, not a context;
//             resolving it would mean reading files inside the permission gate —
//             deliberately not done, so a KUBECONFIG-only command matches the
//             wildcard entry rather than a profile-specific one)
//   aws     → --profile X|=X, else a leading AWS_PROFILE=X env assignment
//   gcloud  → --account X|=X, else --project X|=X  (auth list enumerates accounts,
//             so --account is the primary profile dimension)
//   gh      → --hostname X|=X
// EVERY segment contributes a target, so `cd /x && kubectl --context prod apply`
// still surfaces kubectl. Shell constructs beyond this (subshells, backticks,
// glued `a&&b` without spaces) stay best-effort — deny rules are a guardrail on
// the honest path, not a sandbox (noted in PLAN-TAURI.md).
export type BashPolicyTarget = { tool: string; profile: string | null };

const SEGMENT_SEPARATORS = new Set(["&&", "||", ";", "|", "&", "\n"]);

// HEREDOC-BODY-IS-DATA: a heredoc body is stdin CONTENT, never commands. Without this the
// tokenizer treated every newline inside `cat > f <<'EOF' ... EOF` as a segment separator, so a
// single 63 KB script written by an agent exploded into ~800 phantom segments — each one an
// argv[0] taken from a line of Python/prose ("319,719 build-min across 6 projects...") that then
// became its own capability_decision event AND its own audit record carrying the FULL command.
// That amplification is what grew the audit ledger to 631 MB. Skipping the body also stops false
// destructive-Bash checkpoints on text that merely CONTAINS `rm -rf` inside a here-document.
type PendingHeredoc = { delim: string; stripTabs: boolean };

// Deliberately conservative: only a plain word (optionally quoted) counts as a delimiter, so
// `$((1<<3))` stays arithmetic instead of swallowing the rest of the script as a "body" — a
// false positive here would HIDE real commands from the policy gate, the one failure mode worse
// than the noise this fixes.
const HEREDOC_DELIM_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function parseHeredocOp(command: string, i: number): (PendingHeredoc & { next: number }) | null {
  if (command[i] !== "<" || command[i + 1] !== "<") return null;
  if (command[i + 2] === "<") return null;   // `<<<` is a herestring (single line), not a heredoc
  let j = i + 2;
  let stripTabs = false;
  if (command[j] === "-") { stripTabs = true; j++; }
  while (command[j] === " " || command[j] === "\t") j++;
  let delim = "";
  let quote: string | null = null;
  for (; j < command.length; j++) {
    const c = command[j]!;
    if (quote) {
      if (c === quote) quote = null;
      else delim += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "\\" && j + 1 < command.length) { delim += command[++j]!; continue; }
    if (/[\s;&|<>()]/.test(c)) break;
    delim += c;
  }
  if (quote !== null) return null;                   // unterminated quote — not a delimiter we can trust
  if (!HEREDOC_DELIM_RE.test(delim)) return null;
  return { delim, stripTabs, next: j };
}

// Consumes the body starting at `pos` (first char of the line after the heredoc was opened).
// Returns the index of the newline ending the terminator line, or command.length when the body
// is unterminated — an unterminated heredoc means the rest of the command IS body, which is
// both what bash does and the fail-safe reading (treat unknown text as data, not as commands).
function skipHeredocBody(command: string, pos: number, { delim, stripTabs }: PendingHeredoc): number {
  while (pos < command.length) {
    let end = command.indexOf("\n", pos);
    if (end === -1) end = command.length;
    const line = command.slice(pos, end);
    if ((stripTabs ? line.replace(/^\t+/, "") : line) === delim) return end;
    if (end === command.length) break;
    pos = end + 1;
  }
  return command.length;
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  const pending: PendingHeredoc[] = [];
  const flush = () => { if (cur !== "") { tokens.push(cur); cur = ""; } };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i]!;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "<" && command[i + 1] === "<" && parseHeredocOp(command, i)) {
      // The operator itself stays ONE token (`<<EOF`, quotes stripped — byte-identical to what
      // the pre-heredoc tokenizer produced for it); only the body is skipped, at the newline.
      const h = parseHeredocOp(command, i)!;
      flush();
      tokens.push(`<<${h.delim}`);
      pending.push({ delim: h.delim, stripTabs: h.stripTabs });
      i = h.next - 1;
    } else if (ch === "\\" && i + 1 < command.length) {
      cur += command[++i]!;
    } else if (ch === "\n" || ch === ";") {
      flush(); tokens.push(ch === "\n" ? "\n" : ";");
      if (ch === "\n" && pending.length > 0) {
        // Bodies follow in the order their operators appeared on the line (`cat <<A <<B`).
        let pos = i + 1;
        for (const h of pending) pos = skipHeredocBody(command, pos, h) + 1;
        pending.length = 0;
        i = Math.min(pos, command.length) - 1;
      }
    } else if (ch === "&" || ch === "|") {
      flush();
      if (command[i + 1] === ch) { tokens.push(ch + ch); i++; }
      else tokens.push(ch);
    } else if (/\s/.test(ch)) {
      flush();
    } else {
      cur += ch;
    }
  }
  flush();
  return tokens;
}

function detectProfile(tool: string, args: string[], env: Record<string, string>): string | null {
  const flagsByTool: Record<string, string[]> = {
    kubectl: ["--context"],
    aws: ["--profile"],
    gcloud: ["--account", "--project"],
    gh: ["--hostname"],
  };
  for (const flag of flagsByTool[tool] ?? []) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === flag && typeof args[i + 1] === "string") return args[i + 1]!;
      if (a.startsWith(`${flag}=`) && a.length > flag.length + 1) return a.slice(flag.length + 1);
    }
  }
  if (tool === "aws" && env["AWS_PROFILE"]) return env["AWS_PROFILE"]!;
  return null;
}

// Shared segment splitter: one {env, argv} pair per pipeline/sequence segment (leading
// VAR=value assignments split off the front, argv[0] is the raw head token — basename
// resolution is each caller's job). Backs BOTH parseBashTargets (host-tool profile
// detection) and detectDestructiveBash (F20 D16) — "the SAME argv parse as D4's
// host-tools enforcement" per the design doc, one tokenizer/segmenter, two consumers.
type BashSegment = { env: Record<string, string>; argv: string[] };

function splitBashSegments(command: string): BashSegment[] {
  const segments: BashSegment[] = [];
  const tokens = tokenize(command);
  let segment: string[] = [];
  const closeSegment = () => {
    if (segment.length === 0) return;
    const env: Record<string, string> = {};
    let i = 0;
    for (; i < segment.length; i++) {
      const m = segment[i]!.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) break;
      env[m[1]!] = m[2]!;
    }
    if (i < segment.length) segments.push({ env, argv: segment.slice(i) });
    segment = [];
  };
  for (const t of tokens) {
    if (SEGMENT_SEPARATORS.has(t)) closeSegment();
    else segment.push(t);
  }
  closeSegment();
  return segments;
}

export function parseBashTargets(command: string): BashPolicyTarget[] {
  const targets: BashPolicyTarget[] = [];
  for (const { env, argv } of splitBashSegments(command)) {
    const tool = argv[0]!.split("/").pop()!;                   // path-invoked tools (/usr/local/bin/kubectl) still match
    if (tool !== "") targets.push({ tool, profile: detectProfile(tool, argv.slice(1), env) });
  }
  return targets;
}

// ---------- destructive Bash pattern detection (F20 D16, coverage §C18) ----------
// Triggers an auto-checkpoint BEFORE a segment that could blow away working-tree state
// runs. Biased toward over-triggering (a spurious checkpoint is cheap plumbing; a missed
// one is a lost safety net) — every segment in the pipeline/sequence is checked, same as
// parseBashTargets, so `cd /x && rm -rf build` still matches on its second segment.
//   rm    → -r/-R (or --recursive) AND -f (or --force) both present (short flags may be
//           clustered: "-rf", "-fr", "-Rf", ...) — bare `rm file` is NOT destructive enough
//           to warrant a checkpoint on every call.
//   git   → `reset --hard` (any position) or `clean` with a force flag (clean.requireForce
//           means a force-less `git clean` is a no-op anyway).
//   mv    → always — detecting "over a TRACKED file" needs a working-tree/index lookup this
//           argv-only gate deliberately doesn't do (mirrors parseBashTargets' own "best
//           effort, not a sandbox" contract); every mv triggers instead.
const RM_CLUSTER_RF = /^-[A-Za-z]*[rR][A-Za-z]*f[A-Za-z]*$|^-[A-Za-z]*f[A-Za-z]*[rR][A-Za-z]*$/;

function isDestructiveSegment(argv: string[]): boolean {
  const tool = argv[0]!.split("/").pop()!;
  const rest = argv.slice(1);
  if (tool === "rm") {
    const hasR = rest.some((a) => a === "-r" || a === "-R" || a === "--recursive" || RM_CLUSTER_RF.test(a));
    const hasF = rest.some((a) => a === "-f" || a === "--force" || RM_CLUSTER_RF.test(a));
    return hasR && hasF;
  }
  if (tool === "git") {
    if (rest[0] === "reset" && rest.includes("--hard")) return true;
    if (rest[0] === "clean" && rest.some((a) => a === "--force" || /^-[A-Za-z]*f/.test(a))) return true;
    return false;
  }
  return tool === "mv";
}

export function detectDestructiveBash(command: string): boolean {
  return splitBashSegments(command).some(({ argv }) => argv.length > 0 && isDestructiveSegment(argv));
}

// ---------- landing-class Bash classifier (BLOCKED-LANDING-NEEDS-A-DATA-FLAG) ----------
// The sanctioned land-on-main flow is `git -C <mainRepo> merge/worktree remove/branch -D`
// (see findMainNodeModulesWrite's doc above). When a permission request for one of these
// commands is denied or times out unanswered, that fact used to live ONLY in the agent's own
// prose terminal report — a downstream sweep had to read and correctly interpret another
// LLM's free text to notice a human refusal, and twice it didn't (see supervisor.ts's
// AgentRecord.landingPermissionDenied doc for the incident). This classifier turns "was this
// a landing action" into a plain boolean the caller (decidePermission) can stamp as DATA
// regardless of `-C <mainRepo>` targeting — merge/worktree-remove/branch-delete are landing
// actions wherever they're invoked from, and false positives here only cost an extra boolean
// on an unrelated deny, never a behavior change.
export function isLandingBash(command: string): boolean {
  return splitBashSegments(command).some(({ argv }) => {
    if ((argv[0]?.split("/").pop() ?? "") !== "git") return false;
    const rest: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "-C") { i++; continue; }   // skip `-C <path>` — not the subcommand
      rest.push(argv[i]!);
    }
    const positional = rest.filter((a) => !a.startsWith("-"));
    const sub = positional[0];
    if (sub === "merge") return true;
    if (sub === "worktree") return positional[1] === "remove";
    if (sub === "branch") return rest.some((a) => a === "-D" || a === "-d" || a === "--delete");
    return false;
  });
}

// ---------- host-tool-policy denial observability (DENIED-TOOL-CALL-INVISIBLE) ----------
// A policy_denied event already carries `profile` (parseBashTargets' detectProfile), but
// `profile: null` is ambiguous: it means EITHER "the command carried no --context/--profile
// flag at all" (legitimate — the wildcard row is meant to apply) OR "a flag was present but
// its value is an unexpanded shell variable" (e.g. `--context $ctx` — detectProfile is a plain
// tokenizer with no shell-variable expansion, by design, so the LITERAL string "$ctx" comes out
// as the profile and then fails to match any named row, falling through to the wildcard exactly
// like a genuinely context-less command would). An operator or agent seeing "denied, profile:
// null" cannot tell these apart, and per the incident that motivated this file they need to:
// one is "eks-qa isn't on the allow list", the other is "the classifier couldn't resolve the
// context in the first place". This is a pure classification helper — it never changes which
// policy row applies or the resulting decision, only what gets SAID about it.
export function looksUnresolvedProfile(profile: string | null): boolean {
  return profile !== null && profile.includes("$");
}

// The agent-facing denial message (decidePermission's toolPolicyGate/mcpPolicyGate deny
// branches return this STRING instead of bare `false`). Before this, a Bash/MCP deny reached
// the agent as `false` -> claude.ts's decideToolUse falls back to the generic "denied by
// chimera permission policy", which names neither the tool nor the profile nor whether this is
// a stable policy decision (don't retry) vs a transient one. This is deliberately data the
// agent can quote verbatim in its own terminal report — "kubectl:eks-qa denied by host tool
// policy" beats a generic refusal, and downstream (a conductor, a sweep) no longer has to
// interpret prose to learn WHAT was denied.
export function hostToolDenialMessage(tool: string, profile: string | null): string {
  const unresolved = looksUnresolvedProfile(profile);
  const where = profile === null
    ? "no specific context/profile was detected in the command (the wildcard policy row applied)"
    : unresolved
      ? `the detected profile/context "${profile}" looks like an UNRESOLVED shell variable (chimera's policy parser never expands shell variables) — pass the literal context/profile value instead of an env var reference`
      : `context/profile "${profile}" is not permitted for this agent`;
  return `Denied by host-tool policy: ${tool} — ${where}. This is a policy decision, not a transient error: ` +
    `do not retry the same command. Report this exact denial (tool "${tool}", profile ${profile === null ? "null" : `"${profile}"`}) and stop.`;
}

// mcpPolicyGate's deny-branch counterpart — a foreign MCP call has no CLI profile dimension
// (MCP-FOREIGN-POLICY), so there's nothing to disambiguate; still names the tool explicitly
// rather than falling back to the generic message.
export function mcpToolDenialMessage(tool: string): string {
  return `Denied by host-tool policy: MCP tool "${tool}" is not permitted for this agent. ` +
    `This is a policy decision, not a transient error: do not retry. Report this exact denial and stop.`;
}

// ---------- cloud mutation gate (ad-hoc sessions design §3) ----------
// Session agents run with permissionProfile "full" so that read-only cloud investigation
// (`kubectl get`, `aws describe-*`) never stalls on an approval card — that friction would
// defeat the whole point of an ad-hoc session. But "full" also auto-allows
// `aws ec2 terminate-instances`. The operator's standing rule is "read-only CLIs without
// asking, state changes need explicit per-action confirmation"; that rule lived only in
// prose, and this project has repeated evidence that a rule in a prompt is a request while
// a rule in code is a guarantee. This classifier is that guarantee.
//
// Verb position differs per tool, so each is handled explicitly rather than guessed:
//   aws     `aws [global opts] <service> <operation> [params]`  verb = operation up to
//                                            its first "-" (describe-instances -> describe),
//                                            except a "batch-*" operation where "batch" is a
//                                            modifier, not a verb — batch-get-item/batch-list-*
//                                            are reads, batch-write-item/batch-delete-item are
//                                            mutations, so the SECOND segment disambiguates.
//   kubectl `kubectl [global opts] <verb> <resource>`  verb = first positional
//   gh      `gh [global opts] <group> <verb>`           verb = second positional
//   gcloud  `gcloud [global/group opts] <group...> <verb> [params]`  verb = last positional
// PLAIN-POSITIONAL-ONLY (READONLY-CLOUD-FLAG-VALUES): global options can appear anywhere —
// before, between, or after the service/group/verb tokens — and several take a separate
// value token (`aws --profile prod s3 ls`, `gcloud compute instances list --project foo`).
// Treating every flag's value as a stray positional (the pre-fix behavior) shifts the
// index-based lookups above onto the flag's VALUE instead of the real verb, producing a
// false mutation for an ordinary read. Each tool below gets a curated allowlist of its
// common value-taking flags; `--flag=value` is always one token (no separate value to skip)
// and needs no lookup. A flag NOT on the curated list is assumed to take no separate value —
// if that assumption is wrong the flag's value becomes a stray positional and shifts the
// verb lookup, but (per the fail-closed contract below) an unrecognised resulting token is
// never in CLOUD_READ_VERBS, so the outcome is still "ask", never a false allow.
// An UNRECOGNISED verb on a cloud tool returns a mutation (i.e. prompts). That is
// deliberate: the read allowlist is finite and knowable, the mutation surface is not, so
// the unknown case must fail toward asking rather than toward silently running.
const CLOUD_TOOLS = new Set(["aws", "kubectl", "gcloud", "gh"]);

const CLOUD_READ_VERBS = new Set([
  "describe", "get", "list", "ls", "logs", "log", "show", "read", "search", "view",
  "status", "top", "explain", "version", "help", "diff", "history", "cat", "head",
  "wait", "check", "validate", "print", "config",
  // aws operation-name verbs that don't fit the describe/get/list mould but are still
  // pure reads: scan/query (DynamoDB), select (S3 Select — filters and returns data,
  // writes nothing), filter (CloudWatch Logs filter-log-events), lookup (CloudTrail
  // lookup-events), receive (SQS receive-message), simulate/test/preview/estimate (IAM
  // policy simulator, various dry-run-shaped read APIs).
  "scan", "query", "select", "filter", "lookup", "receive",
  "simulate", "test", "preview", "estimate",
]);

// Curated common value-taking flags per tool — see PLAIN-POSITIONAL-ONLY above for why an
// incomplete list still fails closed rather than false-allowing.
const AWS_VALUE_FLAGS = new Set([
  "--profile", "--region", "--output", "--endpoint-url", "--query",
  "--color", "--ca-bundle", "--cli-connect-timeout", "--cli-read-timeout",
  "--cli-binary-format", "--page-size",
]);
const KUBECTL_VALUE_FLAGS = new Set([
  "--context", "--namespace", "-n", "--kubeconfig", "--cluster", "--user",
  "--server", "--token", "-o", "--output", "--selector", "-l", "--field-selector",
  "--container", "-c", "--since-time", "--tail", "--request-timeout", "--as", "--sort-by",
]);
const GCLOUD_VALUE_FLAGS = new Set([
  "--project", "--account", "--configuration", "--flags-file", "--flatten", "--format",
  "--trace-token", "--verbosity", "--billing-project", "--zone", "--region",
  "--impersonate-service-account", "--filter", "--limit", "--sort-by",
]);
const GH_VALUE_FLAGS = new Set(["--hostname", "--repo", "-R"]);

// Strips flag tokens AND, for flags known to consume a separate value, the value token
// right after them — leaving only true positionals. `--flag=value` is one token already,
// so it's dropped whole regardless of `valueFlags` membership.
function stripFlagsAndValues(rest: string[], valueFlags: Set<string>): string[] {
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("-")) {
      if (!a.includes("=") && valueFlags.has(a)) i++;   // skip the separate value token too
      continue;
    }
    positional.push(a);
  }
  return positional;
}

function cloudVerb(tool: string, rest: string[]): string | null {
  if (tool === "aws") {
    const positional = stripFlagsAndValues(rest, AWS_VALUE_FLAGS);
    const operation = positional[1];
    if (!operation) return null;
    const segments = operation.split("-");
    // "batch-*" is a modifier, not a verb of its own (see the block comment above).
    if (segments[0] === "batch" && segments.length > 1) return segments[1]!;
    return segments[0] ?? null;
  }
  if (tool === "kubectl") return stripFlagsAndValues(rest, KUBECTL_VALUE_FLAGS)[0] ?? null;
  if (tool === "gh") return stripFlagsAndValues(rest, GH_VALUE_FLAGS)[1] ?? null;
  if (tool === "gcloud") {
    const positional = stripFlagsAndValues(rest, GCLOUD_VALUE_FLAGS);
    return positional[positional.length - 1] ?? null;
  }
  return null;
}

export type CloudMutation = { tool: string; verb: string };

// Returns the offending {tool, verb}, or null when no segment mutates cloud state.
export function classifyCloudMutation(command: string): CloudMutation | null {
  for (const { argv } of splitBashSegments(command)) {
    if (argv.length === 0) continue;
    const tool = argv[0]!.split("/").pop()!;
    if (!CLOUD_TOOLS.has(tool)) continue;
    const rest = argv.slice(1);
    // `--dry-run` in any form makes the call a read regardless of verb.
    if (rest.some((a) => a === "--dry-run" || a.startsWith("--dry-run="))) continue;
    const verb = cloudVerb(tool, rest);
    if (verb === null) continue;                  // bare `aws`, `kubectl` — nothing to run
    if (CLOUD_READ_VERBS.has(verb)) continue;
    return { tool, verb };
  }
  return null;
}

// ---------- read-only Bash command classifier (READONLY-BASH-NO-PROMPT) ----------
// Every non-"full" Bash call prompts today because autoDecision decides on TOOL NAME
// alone (supervisor.ts) — Bash can mutate, so it's absent from READ_TOOLS, which makes
// `grep -rn foo src/` and `rm -rf /` indistinguishable at the decision point. This
// closes that gap for the provably-read-only slice WITHOUT touching the decision
// surface itself: autoDecision consults isReadOnlyBash(command) only for Bash, only to
// ADD auto-allows, never to remove one it already granted.
//
// FAIL-CLOSED BY DESIGN (mirrors classifyCloudMutation's own stated discipline):
//   * READ_ONLY_BASH_TOOLS is an ALLOWLIST of tools that are read-only regardless of
//     arguments — never a denylist of known-dangerous ones. Any tool not on it,
//     including a perfectly harmless one we simply haven't curated, fails closed to
//     "prompt". No scripting/exec-capable tool is ever listed (sed/awk/perl/find/
//     xargs/python/node/...) — several can write or shell out via their OWN argument
//     language in ways this argv-only classifier cannot see into.
//   * Command substitution ($(...), backticks) is refused outright, ANYWHERE in the
//     command — not just as argv[0] — because a substitution executes as a hidden side
//     effect of shell parsing before the "outer" command ever runs, and this tokenizer
//     cannot see inside it. That is exactly the documented unknown-case-must-fail-
//     toward-asking rule.
//   * Redirection (`>`, `>>`, `<`, `tee`, ...) is a write even when the leading command
//     reads: any token containing '<' or '>' anywhere in a segment (glued or spaced)
//     fails the segment closed, and `tee` is simply never in the allowlist.
//   * Every pipeline/sequence segment is evaluated via the SAME splitBashSegments used
//     by classifyCloudMutation/detectDestructiveBash — `grep foo && rm -rf /` fails on
//     its second segment; `echo x | tee f` fails on its second (tee is unlisted).
//   * git and the four cloud CLIs need per-verb (not per-tool) judgment — git via a
//     fixed allowlist of unambiguously-read subcommands (deliberately excluding ones
//     with a mutating variant, e.g. `branch`/`remote`/`tag`/`stash`/`config`), the cloud
//     CLIs by reusing CLOUD_TOOLS/CLOUD_READ_VERBS/cloudVerb — the SAME verb knowledge
//     classifyCloudMutation already uses, so the two classifiers cannot drift apart.
//
// No config knob: a toggle would only ever need to widen this (there's nothing "off"
// about a pure allowlist), and the classifier is conservative enough to be safe
// always-on — an extra knob would just be one more place to misconfigure toward "ask
// less than intended".
const READ_ONLY_BASH_TOOLS = new Set([
  "grep", "egrep", "fgrep", "rg", "ag",                              // text search
  "ls", "cat", "head", "tail", "wc", "file", "stat", "diff", "tree", // file inspection
  "pwd", "echo", "printf", "which", "env", "whoami", "hostname", "date", "uname", // env inspection
]);

// Subcommands that are read-only NO MATTER the flags/further args — deliberately
// excludes anything with a mutating variant (`branch` can -D, `remote` can add,
// `config` can set, `tag`/`stash` can create) rather than trying to flag-sniff each.
const GIT_READ_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "describe", "blame", "shortlog",
  "reflog", "rev-parse", "ls-files", "ls-remote", "ls-tree", "cat-file",
]);

// A redirection token, glued ("a>b") or spaced ("a", ">", "b") — tokenize() only
// splits on whitespace/quotes/&|;, never on bare '<'/'>', so both shapes surface as
// ordinary argv tokens. Matching on mere CONTAINMENT (not full-token equality) is
// deliberately broad: it also fails closed on a token like `grep '>' file` (quotes are
// stripped by the tokenizer, so the literal ">" argument is indistinguishable from a
// redirect at this layer) — an acceptable false-closed edge, never a false-open one.
function hasRedirectToken(argv: string[]): boolean {
  return argv.some((a) => a.includes("<") || a.includes(">"));
}

export function isReadOnlyBash(command: string): boolean {
  // Command substitution executes as a side effect of shell parsing, ANYWHERE in the
  // string, invisible to this tokenizer — fail closed unconditionally rather than try
  // to bound where it could appear.
  if (command.includes("$(") || command.includes("`")) return false;
  const segments = splitBashSegments(command);
  if (segments.length === 0) return false;    // nothing recognizable — fail closed
  for (const { argv } of segments) {
    if (argv.length === 0) return false;
    if (hasRedirectToken(argv)) return false;
    const tool = argv[0]!.split("/").pop()!;
    const rest = argv.slice(1);
    if (CLOUD_TOOLS.has(tool)) {
      const verb = cloudVerb(tool, rest);
      if (verb === null || !CLOUD_READ_VERBS.has(verb)) return false;
      continue;
    }
    if (tool === "git") {
      const sub = rest.find((a) => !a.startsWith("-"));
      if (sub === undefined || !GIT_READ_SUBCOMMANDS.has(sub)) return false;
      continue;
    }
    if (!READ_ONLY_BASH_TOOLS.has(tool)) return false;
  }
  return true;
}

// ---------- worktree-must-not-corrupt-main guard (engine-improve: WORKTREE-MAIN-GUARD) ----------
// Real failure, observed TWICE in one night: a worktree-isolated agent hand-rolls the
// node_modules symlink setup CLAUDE.md documents (root node_modules symlink + intra-repo
// @chimera/* relinking) and, by mistake, repoints the MAIN checkout's
// packages/*/node_modules/@chimera/* symlinks at its OWN worktree instead of relinking its
// worktree's own copies. `tsc -b` in main then silently compiles another worktree's files
// under main's identity — a phantom "main is broken" typecheck failure that cost real
// investigation time and produced a false report. CLAUDE.md warns against this in prose;
// the warning was ignored anyway (same instruction, two different agents, one night). This
// makes the write itself impossible instead of merely discouraged: any Bash segment whose
// tool can retarget or remove a filesystem entry (ln/cp/mv/rsync/rm/unlink/ditto), whose
// DESTINATION argument (source arguments are only READ — e.g. `ln -s <main's node_modules>
// ./node_modules`, this repo's own sanctioned worktree-setup step, reads main and writes
// only inside the worktree, and must stay allowed) resolves to any `node_modules` path
// component under mainRepo but OUTSIDE the agent's own worktree, is refused for a
// worktree-isolated agent. Resolution is against the agent's ACTUAL Bash cwd (its
// worktree), so both absolute paths and `../../../node_modules`-style relative escapes
// are caught identically. `rm`/`unlink` have no "source" — every argument they take IS a
// destination — so those two check ALL non-flag arguments, not just the last. Scoped to
// node_modules specifically (not "any write under mainRepo") so the sanctioned
// land-on-main flow (`git -C <mainRepo> merge/worktree remove/branch -D`) is untouched —
// those are `git` subcommands, never a member of the tool sets below.
const DEST_ARG_TOOLS = new Set(["ln", "cp", "mv", "rsync", "ditto"]);
const ALL_ARG_TOOLS = new Set(["rm", "unlink"]);

// Returns the offending resolved path, or null when the command never WRITES into a
// node_modules path under mainRepo outside execCwd. Caller (supervisor.decidePermission)
// is responsible for only invoking this for isolation:"worktree" agents — for
// isolation:"none" execCwd === mainRepo, which would make the worktree-exclusion below
// swallow every check, so this function does not special-case that itself; it trusts the
// caller's gate.
export function findMainNodeModulesWrite(command: string, execCwd: string, mainRepo: string): string | null {
  const mainRoot = resolve(mainRepo);
  const mainRootPrefix = mainRoot + sep;
  const wtRoot = resolve(execCwd);
  const wtRootPrefix = wtRoot + sep;
  const guardedTarget = (raw: string): string | null => {
    const resolved = resolve(execCwd, raw);
    if (resolved === wtRoot || resolved.startsWith(wtRootPrefix)) return null;   // the agent's own tree — always fine
    if (resolved !== mainRoot && !resolved.startsWith(mainRootPrefix)) return null; // not under main at all
    return resolved.split(sep).includes("node_modules") ? resolved : null;
  };
  for (const { argv } of splitBashSegments(command)) {
    const tool = argv[0]?.split("/").pop() ?? "";
    const args = argv.slice(1).filter((a) => !a.startsWith("-"));
    if (ALL_ARG_TOOLS.has(tool)) {
      for (const raw of args) {
        const hit = guardedTarget(raw);
        if (hit) return hit;
      }
    } else if (DEST_ARG_TOOLS.has(tool) && args.length > 0) {
      const hit = guardedTarget(args[args.length - 1]!);
      if (hit) return hit;
    }
  }
  return null;
}

// ---------- worktree-must-not-corrupt-main guard, generalized to the Edit-family tools
// (WORKTREE-AGENT-WRITES-REACH-MAIN) ----------
// findMainNodeModulesWrite above only ever sees a Bash argv — it cannot see an Edit/Write/
// MultiEdit/NotebookEdit tool call, since those are native SDK tools that write straight to
// disk, no shell involved. Real incident: a worktree-isolated agent's own Edit-tool writes,
// intended for its worktree's packages/core/src/supervisor.ts, ended up ALSO (duplicated)
// on that same relative path inside the MAIN checkout — landed uncommitted, then a janitor
// committed the dirty main straight through (267ba64, salvaged by hand as a3ad755). The
// leading mechanism, never disproved: the agent addressed the file by an absolute path
// rooted at the main repo rather than its own worktree. Whatever the exact trigger, the fix
// is the same shape as the node_modules guard — make the WRITE itself impossible rather
// than trust path discipline. Scoped to the four tools that can create/overwrite file
// content (mirrors supervisor.ts's own EDIT_TOOLS set for acceptEdits); Read/Glob/Grep
// never reach this since they cannot mutate.
const EDIT_TOOL_PATH_FIELD: Record<string, string> = {
  Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path",
};

// Resolves symlinks on the REAL path, not the literal string (a symlinked ancestor must not
// let a write slip past the check) — but tolerates a target that doesn't exist yet (Write
// creates new files; Edit's target always exists, by SDK contract, but we don't rely on
// that). Walks up to the nearest existing ancestor, realpath's THAT, then rejoins whatever
// path segments don't exist yet. Falls back to the plain lexical path if even the walked-up
// ancestor can't be realpath'd (e.g. it vanished mid-check) — best-effort, never throws.
// EXPORTED for F22: supervisor.launch() must record the lease's worktreeDir in the SAME spelling
// the two write-target detectors below produce, or a symlinked ancestor (macOS /tmp, a symlinked
// checkout) makes the stored dir and the detected target disagree and evaluateWrite's
// "is this path really THIS lease's" comparison silently allows every foreign write.
export function realishPath(raw: string): string {
  let current = raw;
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;   // reached filesystem root without finding anything real
    suffix.unshift(basename(current));
    current = parent;
  }
  try {
    current = realpathSync(current);
  } catch {
    /* best-effort, see doc comment above */
  }
  return suffix.length > 0 ? join(current, ...suffix) : current;
}

// Returns the offending resolved path, or null when this call never writes into mainRepo
// outside execCwd (including: not an Edit-family tool, field missing/blank, or the target
// is the agent's own worktree, or is outside mainRepo entirely — e.g. /tmp scratch files).
// Caller (supervisor.decidePermission) is responsible for only invoking this for
// isolation:"worktree" agents, exactly like findMainNodeModulesWrite above.
export function findMainSourceWrite(toolName: string, input: unknown, execCwd: string, mainRepo: string): string | null {
  const resolved = editToolTargetPath(toolName, input, execCwd);
  if (resolved === null) return null;
  const wtRoot = realishPath(resolve(execCwd));
  if (resolved === wtRoot || resolved.startsWith(wtRoot + sep)) return null;   // the agent's own tree — always fine
  const mainRoot = realishPath(resolve(mainRepo));
  if (resolved !== mainRoot && !resolved.startsWith(mainRoot + sep)) return null;   // not under main at all
  return resolved;
}

// ---------- F22 write-target detection (shared by the main-repo guards above and the
// single-writer worktree lease) ----------
// The Edit-family half, lifted verbatim out of findMainSourceWrite: "which absolute path would
// this tool call write to", with NO opinion about whether that is allowed. findMainSourceWrite
// asks about mainRepo, the worktree-lease gate asks about someone else's worktree — same
// question, two policies, so the resolution (including realishPath's symlink normalization) must
// live in exactly one place or the two guards will drift apart on a path spelling.
export function editToolTargetPath(toolName: string, input: unknown, execCwd: string): string | null {
  const field = EDIT_TOOL_PATH_FIELD[toolName];
  if (!field) return null;
  const raw = (input as Record<string, unknown> | undefined)?.[field];
  if (typeof raw !== "string" || raw === "") return null;
  return realishPath(resolve(execCwd, raw));
}

// git subcommands that do not write another agent's WORKING TREE. Anything not on this list is
// treated as a WRITE — fail-closed, because a new/unknown/aliased subcommand that silently
// counted as a read is precisely the hole this feature exists to close.
// DELIBERATELY SEPARATE from GIT_READ_SUBCOMMANDS above, which answers a stricter question
// ("may this run without asking a human?") and so excludes anything with a mutating variant.
// This list is the F22 plan's. Merging the two sets would either make the ask-gate laxer or make
// this gate deny `git grep`.
const GIT_LEASE_READ_SUBCOMMANDS = new Set([
  "status", "log", "show", "diff", "rev-parse", "ls-files", "ls-tree", "ls-remote", "cat-file",
  "merge-base", "describe", "blame", "shortlog", "grep", "count-objects", "symbolic-ref",
]);

// `config` is the one subcommand whose read/write nature lives in its FLAGS, not its name: only
// these spellings read, while `git -C <victim> config user.name x` (and --unset/--add/--replace-all
// /--edit) writes <victim>/.git/config — a real foreign write the gate used to wave through because
// `config` sat in the read list wholesale (QA of F22). Fail-closed on any other spelling; the price
// is that `git -C x config --global k v` is named a write of x, which costs a handoff, not a hole.
const GIT_CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"]);

// git's own global options that consume the FOLLOWING token, so the subcommand scan does not
// mistake their value for the subcommand (`git -c user.name=x commit` must find "commit").
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

// `>`, `>>`, `1>`, `2>`, `&>` and their glued forms. `2>&1` is excluded by the caller (an `&N`
// operand is an fd dup, not a file). NOTE the tokenizer treats `&` as its own token AND as a
// segment separator, so `cmd &> f` arrives here as a segment whose FIRST token is `>` (or `>f`) —
// which is why this scan looks at every token of a segment, never just argv[1..].
const REDIRECT_RE = /^(?:&|\d+)?(>{1,2})(.*)$/;

// Every filesystem path this Bash command would WRITE to, resolved absolute (symlinks normalized
// via realishPath, same as the Edit-family half). Order-preserving and deduped.
//
// EXPLICITLY NOT COVERED — said out loud because a guardrail whose limits are undocumented gets
// mistaken for a sandbox. This is a guardrail on the honest path, exactly like parseBashTargets:
//   - interpreters: `python -c "open(p,'w')"`, `node -e`, `perl -pi -e`, `awk > file`
//   - a heredoc that WRITES a script and a later segment that executes it
//   - `find . -exec rm {} +`, `xargs rm`, and anything else that builds argv at runtime
//   - wrapper scripts (`./deploy.sh`, `make install`) — argv[0] is opaque here
//   - command substitution `$(...)`, backticks, subshells `( ... )`, `eval`
//   - `dd of=`, `install`, `truncate`, `patch`, `tar -x`, editors, and every other tool not
//     named in the tables above
// Widening this into a shell interpreter is a NON-GOAL: the honest-path cases below are what a
// cooperating agent actually types, and the lease gate is a coordination guard, not a jail.
export function bashWriteTargets(command: string, execCwd: string): string[] {
  const out: string[] = [];
  let cwd = resolve(execCwd);
  const add = (raw: string, base = cwd) => {
    if (raw === "") return;
    const p = realishPath(resolve(base, raw));
    if (!out.includes(p)) out.push(p);
  };
  for (const { argv } of splitBashSegments(command)) {
    // Pull redirections out FIRST so their operands can never be mistaken for a tool argument
    // (`cp a b >log` must target "b" and "log", not a file literally named ">log").
    const rest: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const tok = argv[i]!;
      const m = REDIRECT_RE.exec(tok);
      if (!m) { rest.push(tok); continue; }
      const glued = m[2]!;
      if (glued !== "") { if (!glued.startsWith("&")) add(glued); continue; }
      const operand = argv[i + 1];
      if (operand !== undefined && !SEGMENT_SEPARATORS.has(operand)) {
        i++;
        if (!operand.startsWith("&")) add(operand);
      }
    }
    const tool = rest[0]?.split("/").pop() ?? "";
    const args = rest.slice(1);
    const plain = args.filter((a) => !a.startsWith("-"));
    if (tool === "cd") {
      // Rebinds the cwd for every LATER segment, which is the only reason this walks segments in
      // order: `cd ../other && git commit -am x` writes into ../other, not into execCwd. A bare
      // `cd` (to $HOME) is left alone — $HOME is never a worktree.
      if (plain.length > 0) cwd = resolve(cwd, plain[0]!);
      continue;
    }
    if (tool === "git") {
      let dir: string | null = null;
      let workTree: string | null = null;
      let sub: string | null = null;
      let subIdx = -1;
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        // --work-tree is tracked SEPARATELY from -C/--git-dir and always wins: git writes into the
        // work tree, while --git-dir only relocates the repo metadata. Folding all three into one
        // last-wins slot let `git --work-tree=<victim> --git-dir=<mine>/.git checkout .` aim the
        // detector at the harmless .git path and slip past the lease gate (QA of 4d32b1e6).
        if (a === "--work-tree") { workTree = args[++i] ?? workTree; continue; }
        if (a.startsWith("--work-tree=")) { workTree = a.slice(a.indexOf("=") + 1); continue; }
        if (a === "-C" || a === "--git-dir") { dir = args[++i] ?? dir; continue; }
        if (a.startsWith("--git-dir=")) { dir = a.slice(a.indexOf("=") + 1); continue; }
        if (GIT_VALUE_OPTS.has(a)) { i++; continue; }
        if (a.startsWith("-")) continue;
        sub = a;
        subIdx = i;
        break;
      }
      // The scan above stops AT the subcommand, so `config`'s own read flags sit past it.
      const subIsRead = sub !== null && (GIT_LEASE_READ_SUBCOMMANDS.has(sub)
        || (sub === "config" && args.slice(subIdx + 1).some((a) => GIT_CONFIG_READ_FLAGS.has(a))));
      // A bare `git commit` with no -C targets the CURRENT directory — which the `cd` branch above
      // may have rebound. Omitting that would make `cd ../other && git commit` invisible.
      // A relative --work-tree is resolved against -C's directory, exactly as git does.
      if (sub !== null && !subIsRead) {
        if (workTree !== null) add(workTree, dir !== null ? resolve(cwd, dir) : cwd);
        else add(dir ?? ".");
      }
      continue;
    }
    if (ALL_ARG_TOOLS.has(tool)) { for (const a of plain) add(a); continue; }
    if (DEST_ARG_TOOLS.has(tool)) { if (plain.length > 0) add(plain[plain.length - 1]!); continue; }
    if (tool === "tee") { for (const a of plain) add(a); continue; }
    if (tool === "sed" && args.some((a) => a === "-i" || a === "--in-place" || (a.startsWith("-i") && !a.startsWith("--")) || a.startsWith("--in-place="))) {
      // sed's first non-flag arg is the SCRIPT, not a file; with only one, sed is editing stdin
      // and there is no file target at all.
      if (plain.length >= 2) for (const a of plain.slice(1)) add(a);
      continue;
    }
  }
  return out;
}
