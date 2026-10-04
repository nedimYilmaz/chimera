// W10 (F10 · coverage B15) — PURE selectors/formatters for the federation
// pairing UI (mock ?screen=settings network section, lines 935-946). No React,
// no store, no rpc imports — unit-testable exactly like selectors.settings.ts /
// selectors.host.ts. Every DECISION the pairing UI makes (how a blob previews
// WITHOUT leaking its token, how the join step indicator projects, what a grant
// call's payload is, how a peer row's state is derived, how an invite row reads)
// lives here as a pure function tested in the node env with no DOM.
//
// SECRET DISCIPLINE (F10): the raw invite token lives ONLY inside the blob the
// operator copies. fed.invite.create is the one RPC that ever returns it (inside
// the blob string); fed.invite.list returns HASHES. `blobPreview` decodes a blob
// for the join field's confirmation line but returns engine/endpoint/expiry
// ONLY — the decoded inviteToken is dropped inside the function and never
// surfaces in the returned view, so nothing here can render or log it.
import {
  decodePairBlob,
  FED_JOIN_STEPS,
  type FedJoinResult,
  type FedJoinStep,
  type InviteListEntry,
} from "@chimera/protocol";
import { fmtClock } from "./selectors";

// ---------------------------------------------------------------------------
// blob preview (join field) — decode chimera-pair:v1 WITHOUT exposing the token
// ---------------------------------------------------------------------------

export type BlobPreview =
  | { ok: true; engineId: string; endpointLabel: string; exp: number; expLabel: string; expired: boolean }
  | { ok: false; error: string };

/** Decode a pasted invite blob into a confirmation view. The decoded token is
 * NEVER returned — only the peer identity, its reachable endpoint, and the
 * expiry. A malformed blob returns the protocol error message so the join
 * field can show it inline before any RPC is attempted. `now` decides expiry. */
export function blobPreview(blob: string, now: number): BlobPreview {
  const trimmed = blob.trim();
  if (trimmed === "") return { ok: false, error: "paste a chimera-pair:v1 invite blob" };
  try {
    const parsed = decodePairBlob(trimmed);
    // parsed.inviteToken is intentionally NOT read here — it stays in this scope
    // and is dropped when the function returns.
    const endpointLabel = parsed.endpoint.ssh?.host ?? parsed.endpoint.socketPath;
    return {
      ok: true,
      engineId: parsed.card.engineId,
      endpointLabel,
      exp: parsed.exp,
      expLabel: fmtExp(parsed.exp, now),
      expired: parsed.exp <= now,
    };
  } catch (err) {
    const message = typeof err === "object" && err !== null && "message" in err
      ? String((err as { message: unknown }).message)
      : "invalid invite blob";
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// join step indicator (config → tunnel → handshake → paired) — mock line 940
// ---------------------------------------------------------------------------

export type StepStatus = "done" | "active" | "pending" | "failed";
export type StepView = { step: FedJoinStep; status: StepStatus; error: string | null };

/** Project a join attempt into the four-step indicator. fed.join runs the steps
 * server-side and returns them atomically, so the states are:
 *   - no attempt yet (result null, not joining)      → all pending
 *   - RPC in flight (joining, result null)           → first step active, rest pending
 *   - result in hand                                  → each canonical step maps to
 *       its result entry: ok → done, ok:false → failed (error inline); a step with
 *       NO entry (the run stopped at the failing step) → pending. */
export function projectJoin(result: FedJoinResult | null, joining: boolean): StepView[] {
  if (result) {
    return FED_JOIN_STEPS.map((step) => {
      const r = result.steps.find((s) => s.step === step);
      if (!r) return { step, status: "pending" as StepStatus, error: null };
      return r.ok
        ? { step, status: "done" as StepStatus, error: null }
        : { step, status: "failed" as StepStatus, error: r.error ?? "failed" };
    });
  }
  return FED_JOIN_STEPS.map((step, i) => ({
    step,
    status: (joining && i === 0 ? "active" : "pending") as StepStatus,
    error: null,
  }));
}

export type Tone = "success" | "warn" | "danger" | "muted";

/** Step glyph + tone (mock: done ✓ green · active ◐ amber+comet · pending muted
 * name · failed ✗ red). */
export function stepVisual(status: StepStatus): { glyph: string; tone: Tone; comet: boolean } {
  switch (status) {
    case "done": return { glyph: "✓", tone: "success", comet: false };
    case "active": return { glyph: "◐", tone: "warn", comet: true };
    case "failed": return { glyph: "✗", tone: "danger", comet: false };
    case "pending": return { glyph: "·", tone: "muted", comet: false };
  }
}

/** The failing step's error, if any (rendered inline under the indicator). */
export function joinError(steps: readonly StepView[]): string | null {
  const failed = steps.find((s) => s.status === "failed");
  return failed?.error ?? null;
}

// ---------------------------------------------------------------------------
// peers table + grant menu (mock lines 942-945)
// ---------------------------------------------------------------------------

/** The runtime snapshot the LOCAL peer.status RPC returns per peer (engine.ts:793
 * → FederationManager.peerStatuses). Loosely typed / read defensively — a daemon
 * field drift must never crash the table. */
export type PeerStatusSnapshot = {
  engineId: string;
  state: string;                 // "connecting" | "connected" | "partitioned"
  outboxPending: number;
  card?: { endpoint?: { ssh?: { host?: string }; socketPath?: string } } | null;
  hostTools?: unknown;
};

/** The grant half of a peer, read off config.get's redacted federation.peers
 * (publicKey is kept visible by the redactor; secrets aren't relevant here). */
export type PeerGrantConfig = {
  engineId: string;
  allowSpawn?: boolean;
  accounts?: "auto" | string[];
  maxConcurrent?: number;
  ssh?: { host?: string };
  socketPath?: string;
};

export type PeerRowState = "granted" | "paired" | "partitioned" | "pending-invite";

export type PeerRow = {
  key: string;
  /** engineId of a real peer; null for a pending-invite placeholder row. */
  engineId: string | null;
  /** engine cell text ("⇅ studio" real · "awaiting join" pending). */
  displayName: string;
  /** real peers draw the ⇅ mark; pending-invite rows do not. */
  remote: boolean;
  state: PeerRowState;
  stateLabel: string;            // "paired · granted" | "paired" | "partitioned" | "pending-invite"
  stateTone: Tone;
  glyph: string;                 // "●" real · "◌" pending-invite
  ip: string | null;
  outboxPending: number;
  /** grant view for a real peer (null for pending-invite — nothing to grant). */
  grant: { allowSpawn: boolean; accounts: "auto" | string[]; maxConcurrent: number } | null;
  grantsLabel: string;           // "spawn on · accounts main,second · max 4" | "read-only · exp …"
  /** space opens the grant menu only on a real peer row. */
  grantable: boolean;
};

const asStr = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** IP cell: prefer the pinned config ssh host (the durable link's address);
 * fall back to the live card's endpoint host. null → "—". */
function peerIp(cfg: PeerGrantConfig | undefined, snap: PeerStatusSnapshot | undefined): string | null {
  return (
    asStr(cfg?.ssh?.host) ??
    asStr(snap?.card?.endpoint?.ssh?.host) ??
    null
  );
}

/** A grant is "on" when the peer may spawn under at least one account. Default-
 * deny (allowSpawn false / accounts []) is read-only "paired". */
export function isGranted(grant: { allowSpawn: boolean; accounts: "auto" | string[] }): boolean {
  if (!grant.allowSpawn) return false;
  return grant.accounts === "auto" || grant.accounts.length > 0;
}

export function normalizeGrant(cfg: PeerGrantConfig | undefined): { allowSpawn: boolean; accounts: "auto" | string[]; maxConcurrent: number } {
  const accounts: "auto" | string[] = cfg?.accounts === "auto"
    ? "auto"
    : Array.isArray(cfg?.accounts) ? cfg!.accounts.filter((a): a is string => typeof a === "string") : [];
  return {
    allowSpawn: cfg?.allowSpawn === true,
    accounts,
    maxConcurrent: typeof cfg?.maxConcurrent === "number" && cfg.maxConcurrent > 0 ? cfg.maxConcurrent : 4,
  };
}

function grantsLabel(grant: { allowSpawn: boolean; accounts: "auto" | string[]; maxConcurrent: number }): string {
  if (!isGranted(grant)) return "read-only";
  const accts = grant.accounts === "auto" ? "auto" : grant.accounts.join(",");
  return `spawn on · accounts ${accts} · max ${grant.maxConcurrent}`;
}

/** Derive the peers table rows (mock 943-945). Real peers come from the pinned
 * config set (config.get federation.peers) merged with the live peer.status
 * snapshot for runtime state + outbox + ip. Pending-invite rows come from the
 * outstanding invite list (unused + unexpired) — the only truthful source for a
 * not-yet-joined peer (the invite carries no engineId, so the row is anonymous). */
export function derivePeerRows(
  configPeers: readonly PeerGrantConfig[],
  snapshots: readonly PeerStatusSnapshot[],
  invites: readonly InviteListEntry[],
  now: number,
): PeerRow[] {
  const snapById = new Map(snapshots.map((s) => [s.engineId, s]));
  const rows: PeerRow[] = [];

  for (const cfg of configPeers) {
    const snap = snapById.get(cfg.engineId);
    const grant = normalizeGrant(cfg);
    const partitioned = snap?.state === "partitioned";
    let state: PeerRowState;
    let stateLabel: string;
    let stateTone: Tone;
    if (partitioned) { state = "partitioned"; stateLabel = "partitioned"; stateTone = "danger"; }
    else if (isGranted(grant)) { state = "granted"; stateLabel = "paired · granted"; stateTone = "success"; }
    else { state = "paired"; stateLabel = "paired"; stateTone = "success"; }
    rows.push({
      key: `peer:${cfg.engineId}`,
      engineId: cfg.engineId,
      displayName: cfg.engineId,
      remote: true,
      state,
      stateLabel,
      stateTone,
      glyph: "●",
      ip: peerIp(cfg, snap),
      outboxPending: typeof snap?.outboxPending === "number" ? snap.outboxPending : 0,
      grant,
      grantsLabel: grantsLabel(grant),
      grantable: true,
    });
  }

  for (const inv of invites) {
    if (inv.used || inv.exp <= now) continue;   // active invites only become pending-invite rows
    rows.push({
      key: `invite:${inv.id}`,
      engineId: null,
      displayName: "awaiting join",
      remote: false,
      state: "pending-invite",
      stateLabel: "pending-invite",
      stateTone: "warn",
      glyph: "◌",
      ip: null,
      outboxPending: 0,
      grant: null,
      grantsLabel: `read-only · exp ${fmtClock(inv.exp)}`,
      grantable: false,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// grant menu payload builder (space → fed.peer.grant)
// ---------------------------------------------------------------------------

export type GrantForm = { allowSpawn: boolean; accounts: "auto" | string[]; maxConcurrent: number };

export type GrantParams = { engineId: string; allowSpawn: boolean; accounts: "auto" | string[]; maxConcurrent: number };

/** Build the fed.peer.grant params from the menu form. maxConcurrent is clamped
 * to a positive int (the schema rejects <=0); accounts stays "auto" or the
 * picked name list. */
export function buildGrantParams(engineId: string, form: GrantForm): GrantParams {
  const max = Math.max(1, Math.floor(form.maxConcurrent) || 1);
  const accounts: "auto" | string[] = form.accounts === "auto" ? "auto" : [...form.accounts];
  return { engineId, allowSpawn: form.allowSpawn, accounts, maxConcurrent: max };
}

/** Toggle one account name in a multi-pick grant form. Picking a name while in
 * "auto" mode switches to an explicit list containing just that name; unpicking
 * the last name leaves an empty list (read-only). */
export function toggleGrantAccount(current: "auto" | string[], name: string): string[] {
  const list = current === "auto" ? [] : [...current];
  const i = list.indexOf(name);
  if (i >= 0) list.splice(i, 1);
  else list.push(name);
  return list;
}

// ---------------------------------------------------------------------------
// invite list rows (created / expiry / used state + revoke) — deliverable 1
// ---------------------------------------------------------------------------

export type InviteRowState = "active" | "used" | "expired";
export type InviteRow = {
  id: string;
  createdLabel: string;
  expLabel: string;
  state: InviteRowState;
  tone: Tone;
  /** only an active invite can be revoked (used/expired are terminal). */
  revocable: boolean;
};

export function inviteRowState(entry: InviteListEntry, now: number): InviteRowState {
  if (entry.used) return "used";
  if (entry.exp <= now) return "expired";
  return "active";
}

/** Project fed.invite.list entries into table rows, newest first. */
export function deriveInviteRows(entries: readonly InviteListEntry[], now: number): InviteRow[] {
  return [...entries]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((e) => {
      const state = inviteRowState(e, now);
      return {
        id: e.id,
        createdLabel: fmtClock(e.createdAt),
        expLabel: fmtExp(e.exp, now),
        state,
        tone: state === "active" ? "success" : state === "used" ? "muted" : "danger",
        revocable: state === "active",
      };
    });
}

// ---------------------------------------------------------------------------
// exp countdown (mock: "12:44 (14m)") — clock + minutes remaining
// ---------------------------------------------------------------------------

/** "HH:MM (Nm)" while time remains, "HH:MM (expired)" once past. Sub-minute
 * remaining reads "(<1m)". */
export function fmtExp(exp: number, now: number): string {
  const clock = fmtClock(exp);
  const remainMs = exp - now;
  if (remainMs <= 0) return `${clock} (expired)`;
  const mins = Math.floor(remainMs / 60_000);
  return mins < 1 ? `${clock} (<1m)` : `${clock} (${mins}m)`;
}

// ---------------------------------------------------------------------------
// TTL choices for the invite generator (mock has no explicit menu; F10 says
// "invite generation (TTL, …)"). A short menu of sane presets → fed.invite.create
// {ttlSeconds}. The daemon default is 24h when omitted.
// ---------------------------------------------------------------------------

export const INVITE_TTL_CHOICES: ReadonlyArray<{ label: string; seconds: number }> = [
  { label: "15m", seconds: 15 * 60 },
  { label: "1h", seconds: 60 * 60 },
  { label: "24h", seconds: 24 * 60 * 60 },
  { label: "7d", seconds: 7 * 24 * 60 * 60 },
];
