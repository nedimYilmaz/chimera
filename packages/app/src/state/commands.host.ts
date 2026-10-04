// W8 — HostToolsCard commands + the card's own local store (OverlayOutlet
// contract: a system card "reads ui-state or its own local store"; ui-state is
// read-only for W8, so open/selection/data live HERE). Same shape discipline
// as commands.coord.ts: a PURE factory over injected deps (store + request) —
// no ../rpc/bridge import — so every transition is unit-testable against a
// stub request; the card binds the singleton with appStore + rpcCall via
// getHostCommands. RPC failures surface through the existing commandError
// action (the footer's red line), never as a crash.
import type { UiStore } from "@chimera/ui-state";
import {
  effectiveMode,
  nextPolicyMode,
  parseHostToolsReply,
  shapeHostRows,
  type HostRowView,
  type HostToolsReply,
  type ToolPolicyModeU,
} from "./selectors.host";

export type RequestFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export type HostToolsState = {
  open: boolean;
  /** Last host.tools reply (local machine). */
  reply: HostToolsReply | null;
  /** peer.status host-tools carriage rows. As of D8 (commit 3797910) the LOCAL
   * `peer.status` RPC carries each peer's cached host-tool summary, so
   * refreshPeers() now feeds these live (W10 · F10) — the ⇅ remote read-only
   * rows finally render real data. Empty until the first refreshPeers()/an
   * unfederated daemon. */
  peers: ReadonlyArray<HostToolsReply>;
  /** CLIENT-side fetch time of `reply` — the daemon reply has no scannedAt
   * field, so the header age is fetch age (noted on the card). */
  fetchedAt: number | null;
  selected: number;
  /** null = row mode; a number = the per-profile edit cursor (index into the
   * selected row's profileTools). */
  profileCursor: number | null;
};

const errMessage = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
};

export type HostCommands = ReturnType<typeof createHostCommands>;

export function createHostCommands(store: UiStore, request: RequestFn, now: () => number = Date.now) {
  let state: HostToolsState = { open: false, reply: null, peers: [], fetchedAt: null, selected: 0, profileCursor: null };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<HostToolsState>): void => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };

  const rows = (): HostRowView[] => shapeHostRows(state.reply, state.peers);

  const entry = (tool: string) => state.reply?.tools.find((t) => t.tool === tool);

  /** Optimistic local policy write (reconciled by the next host.tools fetch). */
  const applyLocal = (targets: ReadonlyArray<{ tool: string; profile: string; mode: ToolPolicyModeU }>): void => {
    if (!state.reply) return;
    const byTool = new Map<string, Array<{ profile: string; mode: ToolPolicyModeU }>>();
    for (const t of targets) {
      const list = byTool.get(t.tool) ?? [];
      list.push(t);
      byTool.set(t.tool, list);
    }
    set({
      reply: {
        ...state.reply,
        tools: state.reply.tools.map((t) => {
          const writes = byTool.get(t.tool);
          if (!writes) return t;
          const policy = { ...t.policy };
          for (const w of writes) policy[w.profile] = w.mode;
          return { ...t, policy };
        }),
      },
    });
  };

  const refresh = async (): Promise<void> => {
    try {
      const raw = await request("host.tools", {});
      const parsed = parseHostToolsReply(raw);
      if (parsed === null) throw new Error("host.tools: unreadable reply shape");
      const max = Math.max(0, shapeHostRows(parsed, state.peers).length - 1);
      set({ reply: parsed, fetchedAt: now(), selected: Math.min(state.selected, max) });
    } catch (err) {
      store.dispatch({ type: "commandError", message: errMessage(err) });   // keep the previous rows
    }
  };

  /** W10 · F10: the LIVE ⇅ remote-rows feed. The local `peer.status` RPC (D8,
   * engine.ts:793) returns each peer's cached host-tool summary alongside its
   * link state; we lift every non-null `hostTools` ({host, tools}) through the
   * SAME defensive parser the local reply uses and hand the read-only rows to
   * setPeers. Best-effort: an unfederated daemon returns {peers:[]} → []; an old
   * daemon without peer.status throws unknown-method → the prior rows stay. This
   * REPLACES the W8 dead seam (setPeers was never called; peers stayed []). */
  const refreshPeers = async (): Promise<void> => {
    try {
      const raw = await request<{ peers?: unknown[] }>("peer.status", {});
      const snaps = Array.isArray(raw?.peers) ? raw.peers : [];
      const peers: HostToolsReply[] = [];
      for (const snap of snaps) {
        const ht = (snap as { hostTools?: unknown } | null)?.hostTools;
        const parsed = parseHostToolsReply(ht);
        if (parsed !== null) peers.push(parsed);
      }
      const max = Math.max(0, shapeHostRows(state.reply, peers).length - 1);
      set({ peers, selected: Math.min(state.selected, max) });
    } catch {
      /* unfederated / old daemon / transient: keep the last-known remote rows */
    }
  };

  /** host.setPolicy per target (exact engine params: {tool, profile, mode} —
   * profile "*" is the wildcard row), then ONE reconcile fetch. Optimistic
   * render happens before the calls; a failure reconciles too, so the card
   * never keeps a write the daemon rejected. */
  const setPolicy = async (targets: ReadonlyArray<{ tool: string; profile: string; mode: ToolPolicyModeU }>): Promise<void> => {
    applyLocal(targets);
    try {
      for (const t of targets) await request("host.setPolicy", { tool: t.tool, profile: t.profile, mode: t.mode });
    } catch (err) {
      store.dispatch({ type: "commandError", message: errMessage(err) });
    }
    await refresh();                                        // the mutation's reconcile IS the next fetch
  };

  return {
    getState: (): HostToolsState => state,
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    rows,

    /** mod+d (not bound on agents scope, KEYMAP-REDESIGN) — open fetches BOTH the local host.tools scan AND the peer.status
     * host-tools carriage (W10: the ⇅ remote rows are now live); re-toggle closes. */
    toggle: (): void => {
      if (state.open) { set({ open: false, profileCursor: null }); return; }
      set({ open: true, selected: 0, profileCursor: null });
      void refresh();
      void refreshPeers();
    },

    /** esc tiering: profile-edit exits first, then the card closes. */
    escape: (): void => {
      if (state.profileCursor !== null) set({ profileCursor: null });
      else set({ open: false });
    },

    refresh,

    /** W10 · F10: pull the ⇅ remote host-tools rows off the live peer.status RPC
     * (D8). Bound into the card's open path and re-run app-side on
     * peer_paired/network_changed so a freshly-paired peer's tools appear. */
    refreshPeers,

    /** Seed the peer.status host-tools carriage rows directly (the unit-test
     * door, and any caller that already holds parsed replies). refreshPeers() is
     * the live path. */
    setPeers: (peers: ReadonlyArray<HostToolsReply>): void => set({ peers }),

    select: (index: number): void => {
      const max = Math.max(0, rows().length - 1);
      set({ selected: Math.min(Math.max(0, index), max), profileCursor: null });
    },

    move: (delta: number): void => {
      const max = Math.max(0, rows().length - 1);
      set({ selected: Math.min(Math.max(0, state.selected + delta), max), profileCursor: null });
    },

    /** space — row mode: cycle the selected row's WILDCARD mode allow→ask→deny
     * (every tool behind a rollup row moves together — they display one access
     * value); profile-edit mode: cycle the cursored profile's mode. Remote
     * rows are read-only (cycleTools/profileTools are [] — policy is the
     * peer's, B14) and no-op. */
    cycle: (): Promise<void> => {
      const row = rows()[state.selected];
      if (!row || row.remote) return Promise.resolve();
      if (state.profileCursor !== null) {
        const target = row.profileTools[state.profileCursor];
        if (!target) return Promise.resolve();
        const e = entry(target.tool);
        if (!e) return Promise.resolve();
        return setPolicy([{ tool: target.tool, profile: target.profile, mode: nextPolicyMode(effectiveMode(e, target.profile)) }]);
      }
      if (row.cycleTools.length === 0) return Promise.resolve();
      const first = entry(row.cycleTools[0]!);
      if (!first) return Promise.resolve();
      const mode = nextPolicyMode(effectiveMode(first, null));
      return setPolicy(row.cycleTools.map((tool) => ({ tool, profile: "*", mode })));
    },

    /** p — enter/exit the per-profile edit cursor (local rows only). Index 0
     * is always the "default (*)" wildcard entry (HOST-TOOLS-DEFAULT-POLICY-UI)
     * — every local row has at least that one target now, even tools with no
     * named contexts (gh/docker/npm). */
    profileEdit: (): void => {
      if (state.profileCursor !== null) { set({ profileCursor: null }); return; }
      const row = rows()[state.selected];
      if (!row || row.remote || row.profileTools.length === 0) return;
      set({ profileCursor: 0 });
    },

    moveProfileCursor: (delta: number): void => {
      if (state.profileCursor === null) return;
      const row = rows()[state.selected];
      const max = Math.max(0, (row?.profileTools.length ?? 1) - 1);
      set({ profileCursor: Math.min(Math.max(0, state.profileCursor + delta), max) });
    },
  };
}

// The app-side singleton, bound lazily by the card with the deps IT imports
// (commands.coord.ts pattern) — this module stays free of bridge/store imports
// so tests build their own instance around a stub request.
let singleton: HostCommands | null = null;
export function getHostCommands(store: UiStore, request: RequestFn): HostCommands {
  if (!singleton) singleton = createHostCommands(store, request);
  return singleton;
}
