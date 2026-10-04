// W5 — coordination-screen command wrappers: team.list/status/create/dissolve,
// queue.list/status/push/cancelTask, memory.search/add over the ONE rpc door,
// with their store dispatches. Structured like history.ts (W3 finding 4): a
// PURE factory over injected deps — no ../rpc/bridge import — so the seq-guard
// / refresh logic is unit-testable against a plain createStore + stub request;
// the screens bind the singleton with the real appStore + rpcCall via
// getCoordCommands. All reducer actions used here (teams/queues/teamDetail/
// queueDetail/pushQueue/memory/confirm/commandError) already exist in
// @chimera/ui-state — this module adds NO state shape.
import type { MemoryHit, QueueStatusView, TeamStatusView, UiStore } from "@chimera/ui-state";
import type { MemoryGetResult, MemoryStatsResult } from "@chimera/protocol";
import { buildMemorySearchParams } from "./selectors.coord";
import { scopeMatches } from "@chimera/ui-state";

// MEM-4's memory.index RPC is not yet on every daemon; this is the app's local
// view of its status reply (the protocol type lands with MEM-4). memoryIndexStatus
// degrades to null on an "unknown method" daemon so the mode chip simply omits the
// "indexing n/N" hint rather than erroring.
export type MemoryIndexView = {
  state: "off" | "building" | "ready" | "error";
  provider?: string;
  model?: string;
  embedded: number;
  total: number;
  pending: number;
  degraded?: boolean;
};

export type RequestFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;

// Phase-1 daemon probe, byte-for-byte the classifier ui-state's createStore and
// the TUI store share (locked error text; PM decision D6): only a POSITIVE
// unknown-method flips a pane to available:false — any other error is transient
// and keeps the previous contents.
const isUnknownMethod = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  return code === "protocol" && typeof message === "string" && /unknown method/.test(message);
};

const errMessage = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
};

export type CoordCommands = ReturnType<typeof createCoordCommands>;

export function createCoordCommands(store: UiStore, request: RequestFn) {
  // Out-of-order guard for the live memory search (TUI store's memorySearchSeq,
  // ported): every issued search takes a fresh seq; a reply only commits when
  // it is STILL the latest issued, so a slow stale reply can never clobber a
  // newer query's results.
  let memorySearchSeq = 0;

  /** Fire-and-forget guard for keybinding-driven calls: an RPC rejection
   * surfaces as lastError (the footer's red line), never as a crash. */
  const guarded = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      store.dispatch({ type: "commandError", message: errMessage(err) });
    }
  };

  const tryPhase2 = async (method: "team.list" | "queue.list", kind: "teams" | "queues"): Promise<void> => {
    try {
      const items = await request<Array<Record<string, unknown>>>(method, {});
      store.dispatch({ type: kind, available: true, items });
    } catch (err) {
      if (isUnknownMethod(err)) store.dispatch({ type: kind, available: false, items: [] });
      // other errors: transient — keep the previous pane contents
    }
  };

  const fetchQueueStatus = (name: string): Promise<QueueStatusView> =>
    request<QueueStatusView>("queue.status", { queue: name });

  /** Re-fetch queue.status after a mutation, but only while a drill for THIS
   * queue is still open (TUI store parity). */
  const reloadQueueDetailIfOpen = async (queue: string): Promise<void> => {
    const open = store.getState().queueDetail;
    if (!open || open.spec["name"] !== queue) return;
    store.dispatch({ type: "queueDetail", detail: await fetchQueueStatus(queue) });
  };

  const reloadTeamDetailIfOpen = async (): Promise<void> => {
    const open = store.getState().teamDetail;
    const name = open?.spec["name"];
    if (typeof name !== "string") return;
    store.dispatch({ type: "teamDetail", detail: await request<TeamStatusView>("team.status", { name }) });
  };

  const memorySearch = (params: { query?: string; limit?: number } = {}): Promise<void> =>
    guarded(async () => {
      const seq = ++memorySearchSeq;
      // MEM-5: the search composes the live query with the mode chip + folder-rail
      // selection from state. An empty/whitespace query becomes a recent-listing
      // (the daemon treats a present-but-empty query as a real, unmatchable term)
      // — TUI parity. `unfiledOnly` post-filters to null-folder records because
      // the RPC's folder param is a prefix match with no "is-null" form.
      const mem = store.getState().memory;
      const query = params.query !== undefined ? params.query : mem.query;
      const { params: rpcParams, unfiledOnly, scope } = buildMemorySearchParams(query, mem.mode, mem.folder, mem.scope, params.limit);
      const raw = await request<MemoryHit[]>("memory.search", rpcParams);
      if (seq !== memorySearchSeq) return; // stale reply: a newer search owns the pane
      const withFolder = unfiledOnly ? raw.filter((h) => h.record.folder == null) : raw;
      // F34.UI: same page-limited caveat as unfiledOnly — the scope post-filter
      // trims THIS page, so a narrow scope over a big page shows fewer rows than
      // `limit`, never rows from another scope.
      const items = scope.kind === "all" ? withFolder : withFolder.filter((h) => scopeMatches(scope, h.record.scope));
      store.dispatch({ type: "memory", items });
    });

  return {
    // ---- snapshots -------------------------------------------------------
    loadTeams: (): Promise<void> => tryPhase2("team.list", "teams"),
    loadQueues: (): Promise<void> => tryPhase2("queue.list", "queues"),

    /** Raw queue.status (no dispatch) — the queues master list derives its
     * per-queue counts from this, and the team detail resolves its workers'
     * task bindings through it. */
    queueStatus: fetchQueueStatus,

    /** Refresh whatever coordination data is on screen: both list panes plus
     * any open drill-in. Fired on tab entry and on relevant events. */
    refresh: (): Promise<void> =>
      guarded(async () => {
        await Promise.all([tryPhase2("team.list", "teams"), tryPhase2("queue.list", "queues")]);
        await Promise.all([reloadTeamDetailIfOpen(), (async () => {
          const open = store.getState().queueDetail;
          const name = open?.spec["name"];
          if (typeof name === "string") await reloadQueueDetailIfOpen(name);
        })()]);
      }),

    // ---- teams -----------------------------------------------------------
    openTeamDetail: (name: string): Promise<void> =>
      guarded(async () => {
        store.dispatch({ type: "teamDetail", detail: await request<TeamStatusView>("team.status", { name }) });
      }),

    closeTeamDetail: (): void => store.dispatch({ type: "teamDetail", detail: null }),

    /** team.create — REJECTS on failure (the form shows the error inline). */
    createTeam: async (spec: Record<string, unknown>): Promise<void> => {
      await request("team.create", { spec });
      await tryPhase2("team.list", "teams");
    },

    /** Destructive — only ever reached through the ConfirmCard gate. */
    dissolveTeam: (name: string): Promise<void> =>
      guarded(async () => {
        await request("team.dissolve", { name });
        store.dispatch({ type: "teamDetail", detail: null }); // a dissolved team's drill is stale
        await tryPhase2("team.list", "teams");
      }),

    /** team.update — REJECTS on failure so TeamFormCard's own catch shows the
     * inline error (e.g. the in-use-role-removal guard: removing a role that
     * still has running members or a non-terminal task is refused), AND dispatches
     * commandError so the SAME refusal also surfaces as a toast (coverage
     * B8: "a refused role edit surfaces inline + toast" — never silent on either
     * channel). */
    updateTeam: async (name: string, patch: Record<string, unknown>): Promise<void> => {
      try {
        await request("team.update", { name, patch });
        await tryPhase2("team.list", "teams");
        await reloadTeamDetailIfOpen();
      } catch (err) {
        store.dispatch({ type: "commandError", message: errMessage(err) });
        throw err;
      }
    },

    // ---- queues ----------------------------------------------------------
    openQueueDetail: (name: string): Promise<void> =>
      guarded(async () => {
        store.dispatch({ type: "queueDetail", detail: await fetchQueueStatus(name) });
      }),

    closeQueueDetail: (): void => store.dispatch({ type: "queueDetail", detail: null }),

    /** queue.push — REJECTS on failure (inline form error); reloads the open
     * drill so the new task appears immediately. */
    pushTask: async (params: Record<string, unknown> & { queue: string }): Promise<void> => {
      await request("queue.push", params);
      await reloadQueueDetailIfOpen(params.queue);
      await tryPhase2("queue.list", "queues");
    },

    /** queue.editTask (TASK-EDIT-VERSIONING) — edit a still-queued (pending/
     * blocked) task in place; REJECTS on failure so EditTaskCard's own catch
     * shows the inline error (the daemon refuses an in_progress/terminal edit
     * with a protocol error). Reloads the open drill so the new head fields +
     * version bump show immediately. No editedBy — a UI/human edit records null. */
    editTask: async ({ taskId, queue, patch }: { taskId: string; queue: string; patch: Record<string, unknown> }): Promise<void> => {
      await request("queue.editTask", { taskId, patch });
      await reloadQueueDetailIfOpen(queue);
    },

    /** Destructive — only ever reached through the ConfirmCard gate. */
    cancelTask: (taskId: string, queue: string): Promise<void> =>
      guarded(async () => {
        await request("queue.cancelTask", { taskId });
        await reloadQueueDetailIfOpen(queue);
      }),

    /** QUEUE-REORDER: queue.moveTask — an adjacent swap with the neighbouring task in drain
     * order (see queues.ts moveTask's own comment for why a swap, not a priority edit). Not
     * destructive (no ConfirmCard) — a boundary no-op is harmless and every move is one more
     * moveTask call away from being undone. `guarded` (like pauseQueue/cancelTask) so a click
     * that loses a race (e.g. the task started running) surfaces as a toast, not a crash. */
    moveTask: (taskId: string, queue: string, direction: "up" | "down"): Promise<void> =>
      guarded(async () => {
        await request("queue.moveTask", { taskId, direction });
        await reloadQueueDetailIfOpen(queue);
      }),

    /** QUEUE-REORDER: queue.retryTask — clones a failed/dead_letter task into a fresh pending
     * one without retyping the prompt (the operator's literal ask). `guarded`, same rationale
     * as moveTask above. */
    retryTask: (taskId: string, queue: string): Promise<void> =>
      guarded(async () => {
        await request("queue.retryTask", { taskId });
        await reloadQueueDetailIfOpen(queue);
        await tryPhase2("queue.list", "queues");
      }),

    /** QUEUE-REORDER: queue.addDependency — the T15 incident's actual fix (an ORDERING
     * CONSTRAINT, not a priority tiebreak). `guarded`, same rationale as moveTask above. */
    addDependency: (taskId: string, queue: string, dependsOnTaskId: string): Promise<void> =>
      guarded(async () => {
        await request("queue.addDependency", { taskId, dependsOnTaskId });
        await reloadQueueDetailIfOpen(queue);
      }),

    /** queue.create (D11 W16) — REJECTS on failure (QueueFormCard's inline error). */
    createQueue: async (spec: Record<string, unknown>): Promise<void> => {
      await request("queue.create", { spec });
      await tryPhase2("queue.list", "queues");
    },

    /** queue.update (D11) — REJECTS on failure (QueueFormCard inline error). */
    updateQueue: async (name: string, patch: Record<string, unknown>): Promise<void> => {
      await request("queue.update", { name, patch });
      await tryPhase2("queue.list", "queues");
      await reloadQueueDetailIfOpen(name);
    },

    /** QUEUE-PAUSE (queue.pause/queue.resume): non-destructive, no confirm gate — a
     * pause is instantly reversible (unlike delete). Reloads the master list + any
     * open drill so the paused badge/toggle label updates immediately even though
     * the live queue_paused/queue_resumed event (folded in ui-state's reducer)
     * would already have done so on its own. */
    pauseQueue: (name: string): Promise<void> =>
      guarded(async () => {
        await request("queue.pause", { queue: name });
        await tryPhase2("queue.list", "queues");
        await reloadQueueDetailIfOpen(name);
      }),

    resumeQueue: (name: string): Promise<void> =>
      guarded(async () => {
        await request("queue.resume", { queue: name });
        await tryPhase2("queue.list", "queues");
        await reloadQueueDetailIfOpen(name);
      }),

    /** Destructive — only ever reached through the ConfirmCard gate (itself only
     * offered once the caller's OWN pending-count check passed — see
     * QueuesScreen's requestDeleteQueue). REJECTS on failure so the refusal
     * shows BOTH inline (footer hint) and as a toast — the engine's guard is
     * authoritative even if the client's count was stale (coverage B9). */
    deleteQueue: async (name: string): Promise<void> => {
      try {
        await request("queue.delete", { name });
        if (store.getState().queueDetail?.spec["name"] === name) store.dispatch({ type: "queueDetail", detail: null });
        await tryPhase2("queue.list", "queues");
      } catch (err) {
        store.dispatch({ type: "commandError", message: errMessage(err) });
        throw err;
      }
    },

    // ---- memory ----------------------------------------------------------
    memorySearch,

    /** Tab-entry / post-add load for the CURRENT query. */
    loadMemory: (): Promise<void> => memorySearch({ query: store.getState().memory.query }),

    /** MEM-5: memory.stats powers the folder-rail counts AND the true "N of M"
     * total (M was capped at 100 by the old limit:100 count search). Returns the
     * whole stats payload; the screen reads `.total` and `.byFolder`. */
    memoryStats: (): Promise<MemoryStatsResult> => request<MemoryStatsResult>("memory.stats", {}),

    /** MEM-5: memory.get {id} → the record + resolved outbound links + inbound
     * backlinks (with snippets). Drives the detail pane's links→/backlinks←
     * sections and wiki-chip navigation. */
    memoryGet: (id: string): Promise<MemoryGetResult> => request<MemoryGetResult>("memory.get", { id }),

    /** MEM-5: an unfiltered listing (max limit) reduced to the known titles, for
     * the `[[` autocomplete popup. Counted WITHOUT dispatching so it never
     * clobbers the visible (possibly filtered) list. Dedupes, most-recent first. */
    memoryTitles: async (): Promise<Array<{ title: string; id: string }>> => {
      const items = await request<MemoryHit[]>("memory.search", { limit: 100 });
      const seen = new Set<string>();
      const out: Array<{ title: string; id: string }> = [];
      for (const h of items) {
        const t = h.record.title;
        if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push({ title: t, id: h.record.id }); }
      }
      return out;
    },

    /** MEM-5: memory.index {action:"status"} → the embed-index state for the mode
     * chip's "indexing n/N" hint + degraded flag. MEM-4 owns the RPC; a daemon
     * without it (unknown method) or any transient error degrades to null so the
     * chip simply shows no index hint — search itself never depends on this. */
    memoryIndexStatus: async (): Promise<MemoryIndexView | null> => {
      try {
        return await request<MemoryIndexView>("memory.index", { action: "status" });
      } catch {
        return null;
      }
    },

    /** MEM-7 (§4, §8): memory.index {action:"rebuild"} — discards every vector and re-embeds from
     * scratch in the background; returns the fresh status immediately (state flips to "building").
     * Unlike memoryIndexStatus this REJECTS on failure: rebuild is a user-initiated action (a click,
     * not a background poll), so the caller must be able to surface the error instead of it
     * disappearing into a silently-blanked index row. */
    memoryIndexRebuild: async (): Promise<MemoryIndexView> => {
      return request<MemoryIndexView>("memory.index", { action: "rebuild" });
    },

    /** memory.add as the desktop app ("app" author, distinct from an agentId)
     * — REJECTS on failure (inline form error), then reloads in context. */
    memoryAdd: async (params: Record<string, unknown>): Promise<void> => {
      await request("memory.add", params);
      await memorySearch({ query: store.getState().memory.query });
    },

    /** memory.update (D11) — REJECTS on failure (MemoryNoteCard inline error);
     * reloads the current search so the edited text/tags show immediately —
     * the very next memory_search (this UI's or any agent's) already reflects
     * the change regardless (the daemon writes synchronously). */
    memoryUpdate: async (params: Record<string, unknown>): Promise<void> => {
      await request("memory.update", params);
      await memorySearch({ query: store.getState().memory.query });
    },

    /** Destructive — only ever reached through the ConfirmCard gate. */
    memoryDelete: (id: string): Promise<void> =>
      guarded(async () => {
        await request("memory.delete", { id });
        await memorySearch({ query: store.getState().memory.query });
      }),

    // ---- cross-screen navigation ----------------------------------------
    /** Teams-detail 2×click / events agent-id click → the Agents tab with that
     * agent selected. ONE shared path so every affordance dispatches the same
     * selectTab+selectAgent pair (PLAN §0.4 parity). */
    openAgent: (agentId: string): void => {
      store.dispatch({ type: "selectAgent", agentId });
      store.dispatch({ type: "selectTab", tab: "agents" });
    },
  };
}

// The app-side singleton: bound lazily by the first screen that asks, with the
// deps IT imports (screens already import appStore/rpcCall) — this module
// itself stays free of bridge/store imports so tests can build their own
// instance around a stub request.
let singleton: CoordCommands | null = null;
export function getCoordCommands(store: UiStore, request: RequestFn): CoordCommands {
  if (!singleton) singleton = createCoordCommands(store, request);
  return singleton;
}
