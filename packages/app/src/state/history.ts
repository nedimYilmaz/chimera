import type { UiStore } from "@chimera/ui-state";
import type { NormalizedEvent } from "@chimera/protocol";
import { errorText } from "./errorText";

export const HISTORY_PAGE = 500;

type Request = <T = unknown>(method: string, params?: unknown) => Promise<T>;

// TRANSCRIPT-TAIL-FIRST: the newest page — no fromSeq/toSeq. events.replay's own
// "no fromSeq" branch (packages/core/src/events.ts) already serves the NEWEST
// `limit` events for the agent, so this is the exact content the transcript pane
// wants to paint FIRST (it's also where the scroll position lands). One RPC,
// dispatched via backfillHistory the instant it resolves — the operator sees the
// tail before anything older has even been asked for.
export async function fetchNewestHistoryPage(agentId: string, request: Request): Promise<NormalizedEvent[]> {
  const batch = await request<NormalizedEvent[]>("events.replay", { agentId, limit: HISTORY_PAGE });
  return Array.isArray(batch) ? batch : [];
}

// TRANSCRIPT-LAZY-OLDER: the next OLDER page, bounded by `toSeq` just below the
// oldest seq seen so far. Still no fromSeq — events.replay's "no fromSeq" branch
// keeps returning the NEWEST `limit` events, just now bounded above by toSeq, so
// each call walks one page further back. Returns [] when nothing older remains.
async function fetchOlderHistoryPage(agentId: string, request: Request, beforeSeq: number): Promise<NormalizedEvent[]> {
  const batch = await request<NormalizedEvent[]>("events.replay", { agentId, toSeq: beforeSeq - 1, limit: HISTORY_PAGE });
  return Array.isArray(batch) ? batch : [];
}

// TRANSCRIPT-LAZY-OLDER (merged with remote's TRANSCRIPT-WINDOWING state
// machine): fetch exactly ONE older page for `agentId`, triggered by the
// operator scrolling near the top of the transcript (TranscriptPanel's
// useTranscriptScroll onNearTop) or by a search jump-to-hit walking backward
// (TranscriptPanel's jumpToHit, which awaits this in a loop). No background
// walk — this is the entire older-paging surface.
//
// Guarded entirely by the AgentView's own fields (types.ts) rather than a
// module-level Map — this keeps the guard correct across evictions for free:
// reducer.ts's evictTranscriptFront resets historyOlderExhausted to false the
// moment it drops rows from the front (there IS older content again the
// instant that happens), so a later scroll-to-top naturally retries instead
// of sitting on a stale "exhausted" flag from before the eviction.
//   - historyMinSeq === null: the newest page hasn't painted yet, nothing to
//     anchor an older fetch against.
//   - historyOlderLoadState === "loading": a page is already in flight for
//     this agent — a second concurrent trigger is a no-op, not queued.
//   - historyOlderExhausted: a previous page already came back short — the
//     true beginning of this agent's CURRENTLY RESIDENT history has been
//     reached (see the eviction-reset note above for what un-sets this).
// A rejected fetch dispatches historyOlderLoadFailed (historyOlderLoadState
// "failed") rather than retrying silently — the pane can show the failure and
// a later scroll-to-top retries, same contract as the newest-page fetch.
export async function requestOlderHistoryPage(store: UiStore, agentId: string, request: Request): Promise<void> {
  const agent = store.getState().agents[agentId];
  if (!agent || agent.historyMinSeq === null) return;
  if (agent.historyOlderLoadState === "loading" || agent.historyOlderExhausted) return;
  store.dispatch({ type: "historyOlderLoadStarted", agentId });
  let batch: NormalizedEvent[];
  try {
    batch = await fetchOlderHistoryPage(agentId, request, agent.historyMinSeq);
  } catch (err: unknown) {
    store.dispatch({ type: "historyOlderLoadFailed", agentId, message: errorText(err) });
    return;
  }
  if (batch.length > 0) store.dispatch({ type: "prependHistory", agentId, events: batch });
  store.dispatch({ type: "historyOlderLoadFinished", agentId, exhausted: batch.length < HISTORY_PAGE });
}

// W3 review finding 4 — the retired TUI store's lazy history backfill (loadHistory + the
// dispatch()-side auto-load), ported onto the shared store. The desktop store previously shipped ui-state's
// backfillHistory reducer + AgentView.historyLoaded with ZERO callers, so an
// agent that finished before the app launched (or was resumed by a daemon
// restart) rendered a permanently blank transcript. Semantics mirror the TUI
// exactly:
//   - whenever the SELECTION lands on an agent whose transcript is still empty,
//     whose history hasn't been backfilled, and whose state isn't "unknown"
//     (an agent.list record exists), fire ONE `agent.tail {agentId, n:1000}`
//     and fold the reply in via the backfillHistory reducer action;
//   - a module-level requested-set guards re-entry, populated BEFORE the await
//     so a rapid re-select mid-fetch can never double-request (TUI parity);
//   - fire-and-forget: a failed tail releases the requested-set guard (so a
//     later reselect retries — a transient failure must not permanently blank
//     the transcript) and surfaces the failure via the shared `notice` channel
//     using errorText() (the daemon's rejection is a {code,message} shape, not
//     an Error instance). The once-per-agent contract only holds for a
//     SUCCESSFUL load; historyLoaded stays false on failure.
//   - TRANSCRIPT-LOADING-STATE: historyLoadState mirrors this same lifecycle
//     ("loading" before the request, "loaded"/"failed" after) so a pane can
//     render an honest in-flight skeleton instead of a blank body — see its
//     doc comment in ui-state/types.ts.
//   - TRANSCRIPT-TAIL-FIRST: the single `agent.tail` fetch above is now a paged
//     `events.replay` fetch of just the NEWEST page (painted via
//     backfillHistory the instant it resolves — historyLoaded flips true here,
//     same as before).
//   - TRANSCRIPT-LAZY-OLDER: there is no background walk past that. Anything
//     OLDER than the newest page is fetched one page at a time, ONLY when the
//     operator scrolls near the top of the transcript (requestOlderHistoryPage,
//     wired from TranscriptPanel's onNearTop) — see its own doc comment above.
// Watching via store.subscribe (not a dispatch wrapper) is the app-shaped
// equivalent of the TUI's dispatch() hook: createStore's INTERNAL dispatch
// (event stream, connectAndLoad snapshots — where the reducer's auto-select of
// the first record happens) never passes through an exported wrapper, but
// every dispatch wakes subscribers, so the selection watcher sees them all.
//
// Kept in its own module (no ../rpc/bridge import) so the trigger logic is
// unit-testable against a plain createStore + stub request, exactly like the
// pure selectors.

export function installHistoryBackfill(
  store: UiStore,
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>,
): () => void {
  const requested = new Set<string>();
  let lastSelected = store.getState().selectedAgentId;
  const maybeBackfill = (): void => {
    const sel = store.getState().selectedAgentId;
    if (sel === lastSelected) return; // only selection LANDINGS trigger (TUI: sel !== prev.selectedAgentId)
    lastSelected = sel;
    if (!sel) return;
    const a = store.getState().agents[sel];
    if (!a || a.state === "unknown" || a.historyLoaded || a.transcript.length > 0 || requested.has(sel)) return;
    requested.add(sel); // BEFORE the await — mid-fetch reselect can't double-request
    // TRANSCRIPT-LOADING-STATE: flip historyLoadState to "loading" before the
    // request fires so the pane can render a skeleton instead of a blank body
    // while this is in flight.
    store.dispatch({ type: "historyLoadStarted", agentId: sel });
    void fetchNewestHistoryPage(sel, request)
      .then((events) => {
        // Defensive: the dev mock seam answers unknown methods with null —
        // treat any non-array reply as an empty history rather than crashing
        // the reducer's replay loop.
        const newestPage = Array.isArray(events) ? events : [];
        store.dispatch({ type: "backfillHistory", agentId: sel, events: newestPage });
        // TRANSCRIPT-LAZY-OLDER: the newest page has painted. If it came back
        // short, the whole history already fit in one page — nothing older to
        // ever fetch, so mark it exhausted up front (no RPC, just a length
        // check on data already in hand) and flip the "older" state to a
        // settled "loaded" rather than leaving it "idle" forever. Anything
        // older than that is fetched ONLY on a scroll-to-top trigger, never here.
        if (newestPage.length < HISTORY_PAGE) {
          store.dispatch({ type: "historyOlderLoadFinished", agentId: sel, exhausted: true });
        }
      })
      .catch((err: unknown) => {
        requested.delete(sel); // release the in-flight guard so a reselect can retry
        console.warn("[chimera] history backfill failed:", err);
        store.dispatch({ type: "notice", message: `history load failed: ${errorText(err)}` });
        store.dispatch({ type: "historyLoadFailed", agentId: sel, message: errorText(err) });
      });
  };
  // Cover a selection that already exists at install time (bootstrap ordering).
  const unsubscribe = store.subscribe(maybeBackfill);
  if (lastSelected) {
    lastSelected = null;
    maybeBackfill();
  }
  return unsubscribe;
}
