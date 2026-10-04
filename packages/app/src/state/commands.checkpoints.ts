// F20 (W22 · coverage §B24/§C18) — the checkpoints strip/card's own local
// store (HostToolsCard/commands.host.ts shape discipline: a PURE factory over
// injected deps, unit-testable against a stub request). Tauri-only, Ink track
// frozen for this feature (F20-checkpoints.md), so state lives HERE rather
// than the shared @chimera/ui-state reducer — mirrors W20/W21's
// commands.notify.ts/commands.usage.ts precedent, not AccountsCard's
// shared-reducer one. The ONE app-wide singleton is shared by CheckpointStrip
// (always-mounted, the mock's composer-area marker row) and CheckpointsCard
// (the full list overlay) so a revert requested from either surface resolves
// through the identical guarded path.
import { useEffect, useState } from "react";
import type { CheckpointRecord, CheckpointStatus } from "@chimera/protocol";
import type { UiStore } from "@chimera/ui-state";
import { checkpointRow, resolveCheckpointCwd, type CheckpointRow } from "./selectors.checkpoints";

export type RequestFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export type CheckpointsState = {
  cwd: string | null;
  supported: boolean;
  count: number;
  latest: CheckpointRow | null;
  open: boolean;
  items: CheckpointRow[];
  selected: number;
  confirmId: string | null;
};

const initial: CheckpointsState = {
  cwd: null,
  supported: false,
  count: 0,
  latest: null,
  open: false,
  items: [],
  selected: 0,
  confirmId: null,
};

const errMessage = (err: unknown): string =>
  typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : String(err);

export type CheckpointsCommands = ReturnType<typeof createCheckpointsCommands>;

export function createCheckpointsCommands(store: UiStore, request: RequestFn) {
  let state: CheckpointsState = initial;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<CheckpointsState>): void => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };

  /** Re-derive dark/light + the strip's "latest" for a repo cwd — called on
   * every selected-agent change AND on every checkpoint_created/reverted
   * event (F20: "driven by checkpoint_created/reverted events"). A non-git
   * cwd (`supported:false`) clears count/latest so the strip stays hidden —
   * F20's "non-git cwd stays dark" rule. A stale in-flight response (the
   * selection moved on again before it resolved) is dropped rather than
   * clobbering the newer cwd's state. */
  const refreshStatus = async (cwd: string | null): Promise<void> => {
    set({ cwd });
    if (!cwd) {
      set({ supported: false, count: 0, latest: null });
      return;
    }
    try {
      const status = await request<CheckpointStatus>("checkpoint.status", { cwd });
      if (state.cwd !== cwd) return;
      set({ supported: status.supported, count: status.count ?? 0, latest: status.latest ? checkpointRow(status.latest) : null });
    } catch {
      if (state.cwd === cwd) set({ supported: false, count: 0, latest: null });
    }
  };

  const refreshList = async (): Promise<void> => {
    const cwd = state.cwd;
    if (!cwd) return;
    try {
      const rows = await request<CheckpointRecord[]>("checkpoint.list", { cwd });
      if (state.cwd !== cwd) return;
      set({ items: rows.map(checkpointRow), selected: 0 });
    } catch (err) {
      store.dispatch({ type: "commandError", message: errMessage(err) });
    }
  };

  return {
    getState: (): CheckpointsState => state,
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    refreshStatus,

    /** P3-T4 — CheckpointStrip's own resolver: given the SELECTED agent id,
     * resolve the repo cwd checkpoint.status/list should read and call
     * refreshStatus with it. Prefers the agent's `projectId` (P3-T2) resolved
     * against `project.list`'s `path` — so a worktree agent (whose raw
     * `spec.cwd` sits under `.chimera/worktrees/...`) still shows its PROJECT's
     * checkpoint history — and falls back to the raw `spec.cwd` when no
     * projectId resolves (old daemon / non-project agent), preserving the
     * pre-P3-T4 behavior. `project.list` is only fetched when a projectId is
     * present, so a plain agent costs exactly the one agent.status call it did
     * before. Any RPC failure (ghost agent, ...) resolves to dark, same as a
     * rejected checkpoint.status always has. */
    async refreshForAgent(agentId: string | null): Promise<void> {
      if (!agentId) {
        await refreshStatus(null);
        return;
      }
      try {
        const rec = await request<Record<string, unknown>>("agent.status", { agentId });
        const spec = rec["spec"] && typeof rec["spec"] === "object" ? (rec["spec"] as Record<string, unknown>) : null;
        const cwd = spec && typeof spec["cwd"] === "string" ? (spec["cwd"] as string) : null;
        const projectId = typeof rec["projectId"] === "string" ? (rec["projectId"] as string) : null;
        let projects: Array<{ name: string; path: string }> = [];
        if (projectId) {
          try {
            const raw = await request<Array<Record<string, unknown>>>("project.list", {});
            projects = raw
              .filter((p) => typeof p["name"] === "string" && typeof p["path"] === "string")
              .map((p) => ({ name: p["name"] as string, path: p["path"] as string }));
          } catch { /* project.list failed — resolveCheckpointCwd below falls back to cwd */ }
        }
        await refreshStatus(resolveCheckpointCwd({ projectId, cwd }, projects));
      } catch {
        await refreshStatus(null);
      }
    },

    /** Click on the strip / the card's own opener. */
    toggle(): void {
      if (state.open) {
        set({ open: false, confirmId: null });
        return;
      }
      set({ open: true });
      void refreshList();
    },
    escape(): void {
      set({ open: false, confirmId: null });
    },

    select(index: number): void {
      if (index < 0 || index >= state.items.length) return;
      set({ selected: index });
    },
    move(delta: number): void {
      if (state.items.length === 0) return;
      set({ selected: Math.min(state.items.length - 1, Math.max(0, state.selected + delta)) });
    },

    /** `mod+k` on the selected agent — a manual checkpoint. No-ops for a
     * dark (non-git / no cwd resolved yet) repo — the keybinding stays bound
     * globally (F20: manual checkpoint keybinding), the guard is here rather
     * than in the keymap row. */
    async createManual(agentId: string): Promise<void> {
      const cwd = state.cwd;
      if (!cwd || !state.supported) return;
      try {
        await request("checkpoint.create", { cwd, trigger: "manual", agentId });
        store.dispatch({ type: "notice", message: "checkpoint created" });
        await refreshStatus(cwd);
        if (state.open) void refreshList();
      } catch (err) {
        store.dispatch({ type: "commandError", message: errMessage(err) });
      }
    },

    /** `r` — opens the guard-carrying ConfirmCard for one checkpoint id (the
     * strip's latest, or the card's selected row). Rendered by CheckpointsCard
     * alone (registered via OverlayOutlet regardless of the list card's own
     * open/closed state) so a press from either surface never double-mounts
     * the modal. */
    requestRevert(id: string): void {
      set({ confirmId: id });
    },
    cancelRevert(): void {
      set({ confirmId: null });
    },

    /** The ConfirmCard's "enter"/confirm action — F20's ONE guarded revert
     * path. A busy repo throws CheckpointStore's CheckpointBusyError
     * ({code:"guardrail"}, message already reads "…kill it first") — that
     * message surfaces verbatim as a commandError toast (Toast.tsx), same as
     * every other failure here; there's nothing guard-specific to special-case. */
    async confirmRevert(): Promise<void> {
      const { cwd, confirmId } = state;
      if (!cwd || !confirmId) return;
      try {
        await request("checkpoint.revert", { cwd, id: confirmId });
        set({ confirmId: null });
        store.dispatch({ type: "notice", message: `reverted to checkpoint cp-${confirmId}` });
        await refreshStatus(cwd);
        if (state.open) void refreshList();
      } catch (err) {
        set({ confirmId: null });
        store.dispatch({ type: "commandError", message: errMessage(err) });
      }
    },
  };
}

let singleton: CheckpointsCommands | null = null;
export function getCheckpointsCommands(store: UiStore, request: RequestFn): CheckpointsCommands {
  if (!singleton) singleton = createCheckpointsCommands(store, request);
  return singleton;
}

/** Lazily resolves the "files changed since" count for every visible row
 * (mirrors commands.artifacts.useDiffMeta's per-id fetch-once-and-cache shape)
 * — the count needs a git shell-out per ref, so it's fetched off the row list
 * rather than carried on CheckpointRecord itself. Cache is keyed by id and
 * reset whenever the visible row set changes (list re-fetch on open / after a
 * create/revert already gives every row a fresh id set). */
export function useFilesSinceMeta(
  cwd: string | null,
  rows: readonly CheckpointRow[],
  fetchFilesSince: (cwd: string, ref: string) => Promise<number>,
): Record<string, number> {
  const [meta, setMeta] = useState<Record<string, number>>({});
  const key = rows.map((r) => r.id).join(",");

  useEffect(() => {
    if (!cwd) return undefined;
    let alive = true;
    for (const row of rows) {
      if (meta[row.id] !== undefined) continue;
      fetchFilesSince(cwd, row.ref)
        .then((count) => {
          if (alive) setMeta((m) => ({ ...m, [row.id]: count }));
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cwd]);

  return meta;
}
