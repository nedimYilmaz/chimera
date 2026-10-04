// W8 — PURE selectors/formatters for the HostToolsCard (mock showHostTools,
// lines 409-431; contracts: design/coverage.html §B14). Same discipline as
// selectors.coord.ts: plain functions over the loosely-typed host.tools reply
// (read defensively — daemon-side field drift must never crash the card), no
// React, no store import, fully unit-testable.
//
// Data source (packages/core/src/engine.ts "host.tools"):
//   { host: engineId, tools: [{ tool, version, profiles[], policy }] }
// where policy is ToolPolicyStore.policyFor's merged per-profile map
// ({} ⇒ no policy configured ⇒ effective allow everywhere; "*" = wildcard).
// The reply carries NO scannedAt field — the card shows the CLIENT-side fetch
// age instead (see fmtScanAge; noted on the card's hint title).

export type ToolPolicyModeU = "allow" | "ask" | "deny";
export type HostToolEntry = {
  tool: string;
  version: string;
  profiles: string[];
  policy: Record<string, string>;
};
export type HostToolsReply = { host: string; tools: HostToolEntry[] };

const MODES: readonly ToolPolicyModeU[] = ["allow", "ask", "deny"];

function isMode(v: unknown): v is ToolPolicyModeU {
  return typeof v === "string" && (MODES as readonly string[]).includes(v);
}

/** Defensive parse of the host.tools RPC reply. null on a shape we can't read. */
export function parseHostToolsReply(raw: unknown): HostToolsReply | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["host"] !== "string" || !Array.isArray(r["tools"])) return null;
  const tools: HostToolEntry[] = [];
  for (const t of r["tools"] as unknown[]) {
    if (typeof t !== "object" || t === null) continue;
    const o = t as Record<string, unknown>;
    if (typeof o["tool"] !== "string") continue;
    const profiles = Array.isArray(o["profiles"])
      ? (o["profiles"] as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    const policy: Record<string, string> = {};
    if (typeof o["policy"] === "object" && o["policy"] !== null) {
      for (const [k, v] of Object.entries(o["policy"] as Record<string, unknown>))
        if (isMode(v)) policy[k] = v;
    }
    tools.push({ tool: o["tool"], version: typeof o["version"] === "string" ? o["version"] : "", profiles, policy });
  }
  return { host: r["host"], tools };
}

// ---------------------------------------------------------------------------
// policy math
// ---------------------------------------------------------------------------

/** Effective mode for a profile: profile-specific beats wildcard ("*"), unset
 * ⇒ allow (mirrors ToolPolicyStore.modeFor's display view exactly). */
export function effectiveMode(entry: Pick<HostToolEntry, "policy">, profile: string | null): ToolPolicyModeU {
  if (profile !== null) {
    const specific = entry.policy[profile];
    if (isMode(specific)) return specific;
  }
  const wild = entry.policy["*"];
  return isMode(wild) ? wild : "allow";
}

/** The space-cycle contract (coverage B14): allow → ask → deny → allow. */
export function nextPolicyMode(mode: ToolPolicyModeU): ToolPolicyModeU {
  return mode === "allow" ? "ask" : mode === "ask" ? "deny" : "allow";
}

/** Mode → color token name (mock: allow --success, ask --warn, deny --danger). */
export type ModeTone = "success" | "warn" | "danger";
export function modeTone(mode: ToolPolicyModeU): ModeTone {
  return mode === "allow" ? "success" : mode === "ask" ? "warn" : "danger";
}

// ---------------------------------------------------------------------------
// row shaping (HOST-TOOLS-PER-ROW: every discovered tool — local AND
// remote/peer — gets its OWN row, no rollup; primary tools just sort first)
// ---------------------------------------------------------------------------

/** Sort-only hint: these tools list first (their familiar ctx/profiles/auth
 * labels), everything else follows in discovery order — every tool still
 * gets its own full row. */
export const PRIMARY_HOST_TOOLS: readonly string[] = ["kubectl", "aws", "gcloud"];

/** Mock's per-tool profiles-cell prefixes ("ctx: …", "profiles: …", "auth: …"). */
const PROFILE_LABEL: Record<string, string> = { kubectl: "ctx", aws: "profiles", gcloud: "auth" };
/** Remote row uses the mock's singular forms ("ctx: homelab · profile: default"). */
const REMOTE_PROFILE_LABEL: Record<string, string> = { kubectl: "ctx", aws: "profile", gcloud: "auth" };

/** The per-profile editor's synthetic entry for the WILDCARD "*" policy (the
 * mode a no-context command resolves to — ToolPolicyStore.modeFor). "(*)"
 * disambiguates it from a tool's own literal profile named "default" (e.g.
 * aws's default profile) — this is Chimera's UI label, not a context name.
 * Local rows only (HOST-TOOLS-DEFAULT-POLICY-UI): it's the only way today to
 * reach the wildcard policy from the per-profile editor — previously only
 * space-on-row could set it, and tools with zero named contexts had no
 * p-edit target at all. */
export const DEFAULT_PROFILE_LABEL = "default (*)";

export type ProfilePart = { text: string; danger: boolean };
export type AccessSegment = { mode: ToolPolicyModeU; names: string | null };
export type HostRowView = {
  key: string;
  hostMark: string | null;      // "◆ mbp" first local row / "⇅ studio" peer row
  remote: boolean;
  name: string;                 // tool cell ("kubectl", "gh", "docker", …) — one tool per row
  version: string;              // "1.31" / "—" when unknown
  profileLabel: string | null;  // "ctx"/"profiles"/"auth" for tools with a known label; null otherwise
  profileParts: ProfilePart[];  // separator-joined by the renderer (" · ")
  access: AccessSegment[];
  peerNote: string | null;      // "(peer policy — studio decides)"
  /** space target: this row's tool ([] ⇒ read-only remote row). */
  cycleTools: string[];
  /** p targets: the per-profile edit cursor's (tool, profile) list — local
   * rows only. Index 0 is always the synthetic "default (*)" entry (profile
   * "*", HOST-TOOLS-DEFAULT-POLICY-UI) so the no-context policy is reachable
   * even for tools with no named contexts; named profiles follow. */
  profileTools: Array<{ tool: string; profile: string }>;
  sep: boolean;                 // first peer row draws the mock's top separator
};

/** Access cell for one tool: profiles grouped by effective mode in first-
 * occurrence order; a single shared mode renders bare (mock gcloud: "deny"),
 * multiple modes list their profile names (mock kubectl: "ask prod · allow
 * staging, dev"). No profiles ⇒ the bare wildcard mode. */
export function accessSegments(entry: Pick<HostToolEntry, "profiles" | "policy">): AccessSegment[] {
  if (entry.profiles.length === 0) return [{ mode: effectiveMode(entry, null), names: null }];
  const groups: Array<{ mode: ToolPolicyModeU; profiles: string[] }> = [];
  for (const profile of entry.profiles) {
    const mode = effectiveMode(entry, profile);
    const g = groups.find((x) => x.mode === mode);
    if (g) g.profiles.push(profile);
    else groups.push({ mode, profiles: [profile] });
  }
  if (groups.length === 1) return [{ mode: groups[0]!.mode, names: null }];
  return groups.map((g) => ({ mode: g.mode, names: g.profiles.join(", ") }));
}

/** A tool row's profiles cell: one part per profile, DENIED names tinted
 * danger (mock kubectl row: "ctx: prod · staging · dev" with prod tinted). */
export function profileParts(entry: Pick<HostToolEntry, "profiles" | "policy">): ProfilePart[] {
  return entry.profiles.map((p) => ({ text: p, danger: effectiveMode(entry, p) === "deny" }));
}

export type CursoredProfile = { toolName: string; profileText: string; mode: ToolPolicyModeU };

/** The footer-caption input while the per-profile edit cursor is active: the
 * cursored row's tool name, the cursored profile's DISPLAY text (same text
 * the possibly-clipped chip renders — "default (*)", "adem-eks", …), and its
 * CURRENT effective mode. This is how HOST-TOOLS-PROFILE-VISIBILITY makes the
 * cursored profile identifiable even when `.cellProfiles` has clipped its
 * chip via CSS ellipsis (many-profile tools like kubectl). null when there is
 * nothing valid to caption (cursor closed, row is a read-only peer row, or
 * the row/entry lookup misses — defensive, mirrors parseHostToolsReply's
 * discipline). `profileParts`/`profileTools` are index-aligned by
 * construction (shapeHostRows builds both from the same default+profiles
 * sequence), so a shared index into both is safe for local rows. */
export function cursoredProfile(
  row: HostRowView | undefined,
  reply: HostToolsReply | null,
  profileCursor: number | null,
): CursoredProfile | null {
  if (!row || row.remote || profileCursor === null) return null;
  const target = row.profileTools[profileCursor];
  const part = row.profileParts[profileCursor];
  if (!target || !part) return null;
  const entry = reply?.tools.find((t) => t.tool === target.tool);
  if (!entry) return null;
  return { toolName: row.name, profileText: part.text, mode: effectiveMode(entry, target.profile) };
}

/** The whole card body. `peers` is the peer.status host-tools carriage shape
 * ({host, tools}); there is NO client-facing RPC that surfaces it today
 * (peer.status is peer-link-only — PLAN §7 W8), so the live card passes [] and
 * the remote rows are the documented degraded state: absent until a daemon
 * surface carries them. The shaping is contract-complete regardless (mock row
 * 5 renders 1:1 from this shape). */
export function shapeHostRows(
  local: HostToolsReply | null,
  peers: ReadonlyArray<HostToolsReply> = [],
): HostRowView[] {
  const rows: HostRowView[] = [];
  if (local !== null) {
    const primary = local.tools.filter((t) => PRIMARY_HOST_TOOLS.includes(t.tool));
    const rest = local.tools.filter((t) => !PRIMARY_HOST_TOOLS.includes(t.tool));
    [...primary, ...rest].forEach((t, i) => {
      const defaultMode = effectiveMode(t, null);
      rows.push({
        key: `local:${t.tool}`,
        hostMark: i === 0 ? `◆ ${local.host}` : null,
        remote: false,
        name: t.tool,
        version: t.version || "—",
        profileLabel: PROFILE_LABEL[t.tool] ?? null,
        // "default (*)" always leads — it's the wildcard row, editable even
        // when a tool has no named contexts (was the mock's bare "—").
        profileParts: [
          { text: DEFAULT_PROFILE_LABEL, danger: defaultMode === "deny" },
          ...(t.profiles.length > 0 ? profileParts(t) : []),
        ],
        access: [
          { mode: defaultMode, names: DEFAULT_PROFILE_LABEL },
          ...(t.profiles.length > 0 ? accessSegments(t) : []),
        ],
        peerNote: null,
        cycleTools: [t.tool],
        profileTools: [{ tool: t.tool, profile: "*" }, ...t.profiles.map((p) => ({ tool: t.tool, profile: p }))],
        sep: false,
      });
    });
  }
  peers.forEach((peer, pi) => {
    peer.tools.forEach((t, ti) => {
      rows.push({
        key: `peer:${peer.host}:${t.tool}`,
        hostMark: ti === 0 ? `⇅ ${peer.host}` : null,
        remote: true,
        name: t.tool,
        version: t.version || "—",
        profileLabel: REMOTE_PROFILE_LABEL[t.tool] ?? null,
        profileParts: t.profiles.length > 0 ? profileParts(t) : [{ text: "—", danger: false }],
        access: accessSegments(t),
        peerNote: `(peer policy — ${peer.host} decides)`,  // mock row 5 verbatim, host substituted
        cycleTools: [],                            // POLICY IS THE PEER'S — never editable here (B14)
        profileTools: [],
        sep: pi === 0 && ti === 0,                 // mock: separator above the first ⇅ row
      });
    });
  });
  return rows;
}

// ---------------------------------------------------------------------------
// header scan-age label
// ---------------------------------------------------------------------------

/** "last scan 4m ago" (mock header). fetchedAt is the CLIENT-side fetch
 * time — the daemon reply carries no scannedAt field, so this is honest fetch
 * age, not probe age (the card's hint title says so). */
export function fmtScanAge(fetchedAt: number | null, now: number): string {
  if (fetchedAt === null) return "scanning…";
  const mins = Math.floor(Math.max(0, now - fetchedAt) / 60_000);
  return mins < 1 ? "last scan just now" : `last scan ${mins}m ago`;
}
