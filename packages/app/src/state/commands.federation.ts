// W10 (F10 · coverage B15) — Federation pairing command layer + the pairing
// UI's own local store. Same shape discipline as commands.settings.ts /
// commands.host.ts: a PURE factory over injected deps (store + request) with NO
// ../rpc/bridge import, so every transition is unit-testable against a stub
// request; the component binds the singleton with appStore + rpcCall via
// getFederationCommands. RPC failures surface through the existing commandError
// action (the Toast's danger channel), never a crash.
//
// SECRET DISCIPLINE (F10): the raw invite token lives ONLY inside the blob
// fed.invite.create returns. That blob is held here transiently ONLY so the
// operator can copy it (the ONE row that carries the token, mock line 937) and
// is dropped on the next generate/clear. fed.invite.list carries HASHES only.
// The join field's blob is previewed via selectors.federation.blobPreview which
// never returns the token. Nothing here logs a blob or a token.
import type { UiStore } from "@chimera/ui-state";
import type { FedJoinResult, InviteListEntry } from "@chimera/protocol";
import {
  buildGrantParams,
  type GrantForm,
  type PeerGrantConfig,
  type PeerStatusSnapshot,
} from "./selectors.federation";

export type RequestFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export type FederationState = {
  /** fed.invite.list rows (hashes/exp/used — never raw tokens). */
  invites: readonly InviteListEntry[];
  /** the LAST generated invite blob — held ONLY for the copy affordance, dropped
   * on the next generate or clearBlob. null when nothing was just generated. */
  lastBlob: string | null;
  lastBlobExp: number | null;
  /** live peer.status snapshots (runtime state + outbox + host-tools carriage). */
  peers: readonly PeerStatusSnapshot[];
  /** config.get federation.peers — the grant half (allowSpawn/accounts/max). */
  configPeers: readonly PeerGrantConfig[];
  /** accounts.list names for the grant menu multi-pick. */
  accountNames: readonly string[];
  /** a fed.join is in flight (drives the step indicator's "active" phase). */
  joining: boolean;
  /** the last fed.join result (per-step outcomes). */
  joinResult: FedJoinResult | null;
  loaded: boolean;
};

const initial: FederationState = {
  invites: [],
  lastBlob: null,
  lastBlobExp: null,
  peers: [],
  configPeers: [],
  accountNames: [],
  joining: false,
  joinResult: null,
  loaded: false,
};

const errMessage = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
};

type RedactedFedConfig = { federation?: { peers?: unknown } };

function readConfigPeers(cfg: RedactedFedConfig | null): PeerGrantConfig[] {
  const peers = cfg?.federation?.peers;
  if (!Array.isArray(peers)) return [];
  const out: PeerGrantConfig[] = [];
  for (const p of peers) {
    if (typeof p !== "object" || p === null) continue;
    const o = p as Record<string, unknown>;
    if (typeof o["engineId"] !== "string") continue;
    out.push({
      engineId: o["engineId"],
      allowSpawn: o["allowSpawn"] === true,
      accounts: o["accounts"] === "auto"
        ? "auto"
        : Array.isArray(o["accounts"]) ? (o["accounts"] as unknown[]).filter((a): a is string => typeof a === "string") : [],
      maxConcurrent: typeof o["maxConcurrent"] === "number" ? o["maxConcurrent"] : undefined,
      ssh: typeof o["ssh"] === "object" && o["ssh"] !== null ? { host: (o["ssh"] as Record<string, unknown>)["host"] as string | undefined } : undefined,
      socketPath: typeof o["socketPath"] === "string" ? o["socketPath"] : undefined,
    });
  }
  return out;
}

function readPeerSnapshots(raw: unknown): PeerStatusSnapshot[] {
  const list = (raw as { peers?: unknown })?.peers;
  if (!Array.isArray(list)) return [];
  const out: PeerStatusSnapshot[] = [];
  for (const s of list) {
    if (typeof s !== "object" || s === null) continue;
    const o = s as Record<string, unknown>;
    if (typeof o["engineId"] !== "string") continue;
    out.push({
      engineId: o["engineId"],
      state: typeof o["state"] === "string" ? o["state"] : "connecting",
      outboxPending: typeof o["outboxPending"] === "number" ? o["outboxPending"] : 0,
      card: (o["card"] as PeerStatusSnapshot["card"]) ?? null,
      hostTools: o["hostTools"],
    });
  }
  return out;
}

export type FederationCommands = ReturnType<typeof createFederationCommands>;

export function createFederationCommands(store: UiStore, request: RequestFn) {
  let state: FederationState = initial;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<FederationState>): void => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };
  const fail = (err: unknown): void => store.dispatch({ type: "commandError", message: errMessage(err) });

  // ---- reads --------------------------------------------------------------

  const loadInvites = async (): Promise<void> => {
    try {
      const res = await request<{ invites?: InviteListEntry[] }>("fed.invite.list", {});
      set({ invites: Array.isArray(res?.invites) ? res.invites : [], loaded: true });
    } catch (err) {
      fail(err); // keep the previous rows
    }
  };

  const loadPeers = async (): Promise<void> => {
    // peer.status = runtime; config.get = the grant half. Both are best-effort;
    // a failure keeps the prior view (never wipes a loaded table on a blip).
    const [snaps, cfg] = await Promise.allSettled([
      request<unknown>("peer.status", {}),
      request<RedactedFedConfig>("config.get", {}),
    ]);
    const patch: Partial<FederationState> = { loaded: true };
    if (snaps.status === "fulfilled") patch.peers = readPeerSnapshots(snaps.value);
    else fail(snaps.reason);
    if (cfg.status === "fulfilled") patch.configPeers = readConfigPeers(cfg.value);
    else fail(cfg.reason);
    set(patch);
  };

  const loadAccounts = async (): Promise<void> => {
    try {
      const accounts = await request<Array<{ name?: unknown }>>("accounts.list", {});
      set({ accountNames: Array.isArray(accounts) ? accounts.map((a) => String(a?.name ?? "")).filter(Boolean) : [] });
    } catch (err) {
      fail(err);
    }
  };

  const loadAll = async (): Promise<void> => {
    await Promise.all([loadInvites(), loadPeers(), loadAccounts()]);
  };

  // ---- invite writes ------------------------------------------------------

  /** g — fed.invite.create {ttlSeconds}. The returned blob carries the token
   * ONCE; we hold it transiently for the copy row and refresh the invite list.
   * Returns the blob so the caller can drive a copy-to-clipboard immediately. */
  const createInvite = async (ttlSeconds?: number): Promise<string | null> => {
    try {
      const res = await request<{ id: string; blob: string; exp: number }>(
        "fed.invite.create",
        ttlSeconds ? { ttlSeconds } : {},
      );
      set({ lastBlob: res.blob, lastBlobExp: res.exp });
      await loadInvites();
      return res.blob;
    } catch (err) {
      fail(err);
      return null;
    }
  };

  /** r — fed.invite.revoke {id}. */
  const revokeInvite = async (id: string): Promise<void> => {
    try {
      await request("fed.invite.revoke", { id });
      await loadInvites();
    } catch (err) {
      fail(err);
    }
  };

  /** Drop the transient blob (the copy row disappears). */
  const clearBlob = (): void => set({ lastBlob: null, lastBlobExp: null });

  // ---- join ---------------------------------------------------------------

  /** v — fed.join {blob}. Runs the config→tunnel→handshake→paired steps
   * server-side and returns them atomically; we flip `joining` for the in-flight
   * indicator, store the result, then refresh peers so a successful pairing
   * lands its row (a peer_paired event refresh also fires). */
  const join = async (blob: string): Promise<FedJoinResult | null> => {
    set({ joining: true, joinResult: null });
    try {
      const result = await request<FedJoinResult>("fed.join", { blob: blob.trim() });
      set({ joining: false, joinResult: result });
      await loadPeers();
      return result;
    } catch (err) {
      set({ joining: false });
      fail(err);
      return null;
    }
  };

  const clearJoin = (): void => set({ joinResult: null });

  // ---- grant --------------------------------------------------------------

  /** space grant menu submit → fed.peer.grant {engineId, allowSpawn, accounts,
   * maxConcurrent} (a LOCAL config write — the peer's own policy stays on the
   * peer). Refresh peers to reflect the new grant label. */
  const grant = async (engineId: string, form: GrantForm): Promise<boolean> => {
    try {
      await request("fed.peer.grant", buildGrantParams(engineId, form));
      await loadPeers();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  // ---- self-refresh (peer_paired / network_changed / config_changed) ------

  const onDaemonEvent = (kind: string): void => {
    if (kind === "peer_paired") { void loadPeers(); void loadInvites(); return; }
    if (kind === "network_changed" || kind === "config_changed") { void loadPeers(); }
  };

  return {
    getState: (): FederationState => state,
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    loadInvites,
    loadPeers,
    loadAccounts,
    loadAll,
    createInvite,
    revokeInvite,
    clearBlob,
    join,
    clearJoin,
    grant,
    onDaemonEvent,
  };
}

// The app-side singleton, bound lazily by the component with the deps IT imports
// (commands.settings.ts pattern) — this module stays free of bridge/store
// imports so tests build their own instance around a stub request.
let singleton: FederationCommands | null = null;
export function getFederationCommands(store: UiStore, request: RequestFn): FederationCommands {
  if (!singleton) singleton = createFederationCommands(store, request);
  return singleton;
}
