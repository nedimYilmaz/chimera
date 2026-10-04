import { createStore, type ChimeraApi } from "@chimera/ui-state";
import type { NormalizedEvent } from "@chimera/protocol";
import { validateRpcResponse, type RpcCallOpts, type RpcMethod, type RpcRequestInputFor, type RpcResponseFor } from "@chimera/protocol/contract";
import { onDaemonEvent, onDaemonState, rpcCall, subscribeEvents } from "../rpc/bridge";
import { installHistoryBackfill } from "./history";
import { createReconnectRefetcher, createSnapshotLoader, RECONNECT_REPLAY_LIMIT } from "./reconnect";
import { installVoiceEventBridge } from "../voice/voiceEvents";
import { installSpeakingWatchdog } from "../voice/watchdog";
import { installMuteStopsSpeech, speechTimeoutNotifier } from "../voice/notices";
import { installVoiceStopKeybinding } from "../voice/keybind";
import { loadPersistedOutbox, persistOutbox, loadPersistedTerminalDock, persistTerminalDock } from "./persistence";

// W2 state port (PLAN-TAURI §3): the desktop app's singleton store — the shared
// @chimera/ui-state reducer/store fed by the Tauri rpc bridge. The bridge is
// the app's ONLY transport (the webview never touches the daemon socket), so
// this adapter is the entire glue layer: ChimeraApi's methods mapped onto
// the bridge contract, nothing else. All business logic stays daemon-side and
// all projection logic stays in ui-state's reducer (§0: the UI holds a
// projection).
const bridgeApi: ChimeraApi = {
  request: <T = unknown>(method: string, params?: unknown): Promise<T> => rpcCall<T>(method, params ?? {}),

  // TYPED-CLIENT-SDK: the typed sibling of `request`, mirroring ChimeraClient.call — same
  // rpcCall transport, plus the shared opt-in validateRpcResponse for opts.validateResponse.
  call: <M extends RpcMethod>(method: M, params: RpcRequestInputFor<M>, opts?: RpcCallOpts): Promise<RpcResponseFor<M>> => {
    const result = rpcCall<RpcResponseFor<M>>(method, params);
    return opts?.validateResponse ? result.then((value) => validateRpcResponse(method, value)) : result;
  },

  // Attach the event listener BEFORE enabling the daemon-side stream, so an
  // event emitted the instant the subscription lands is never dropped between
  // the two calls (mirrors the TUI store's subscribe-first-then-replay
  // ordering concern, minus the tail replay — the reducer's seq watermark
  // dedupes any overlap regardless). subscribeEvents is idempotent and the
  // Rust core re-applies it on every reconnect, so calling it once here is
  // enough for the lifetime of the page.
  subscribe: async (filter, cb) => {
    // Re-verify minor: connectAndLoad re-runs on every reconnect refetch, so
    // without disposing the PREVIOUS listener each reconnect would stack one
    // more duplicate event callback for the life of the page (harmless for
    // state — the seq watermark dedupes — but N× dispatch work after N drops).
    prevEventListener?.();
    const off = onDaemonEvent(cb);
    prevEventListener = off;
    await subscribeEvents(filter);
    return off;
  },
};
let prevEventListener: (() => void) | null = null;

export const appStore = createStore(bridgeApi);

// Lazy per-agent history backfill (TUI store parity — see history.ts): when
// the selection lands on an agent with an empty, never-backfilled transcript,
// ONE agent.tail fetch rebuilds it via the backfillHistory reducer action.
// Installed for the lifetime of the page, exactly like the TUI's dispatch hook.
installHistoryBackfill(appStore, rpcCall);

// VOICE S5+S6: the voice_* event consumer (TTS playback queue + session-state fold), installed
// for the lifetime of the page — same convention as installHistoryBackfill above.
installVoiceEventBridge();

// VOICE-STOP: the "can never get stuck speaking" backstop — a `speaking` state with no playback
// progress for 2 minutes falls back to idle/listening with a visible reason.
const notifyVoice = (message: string): void => { appStore.dispatch({ type: "notice", message }); };
installSpeakingWatchdog({ onTimeout: speechTimeoutNotifier(notifyVoice) });

// VOICE-STOP: muting spoken replies must silence the reply in flight, not just the next one.
installMuteStopsSpeech(notifyVoice);

// VOICE-STOP: esc → stop, registered page-wide (not from a screen component) so it reaches the
// operator on every tab.
installVoiceStopKeybinding();

// OUTBOX-SURVIVES-RELOAD: restore any queued-but-undelivered messages from a
// previous page life BEFORE anything else touches the outbox, then persist
// every future change in the same tick (no timer) so a drained/edited item's
// persisted copy never lags what's actually in state. Delivery always goes
// through outboxRemove (commands.agents.ts's deliverOneQueued), so a
// delivered item is removed from `state.outbox` — and thus from the next
// persisted snapshot — before any reload could resurrect it.
for (const item of loadPersistedOutbox()) {
  appStore.dispatch({ type: "outboxAdd", item });
}
let prevOutbox = appStore.getState().outbox;
appStore.subscribe(() => {
  const next = appStore.getState().outbox;
  if (next !== prevOutbox) {
    prevOutbox = next;
    persistOutbox(next);
  }
});

// IN-APP-TERMINAL Task 6 / TERMINAL-DOCK-PER-AGENT: restore the dock's HEIGHT before anything
// renders — mirrors the outbox restore above. Open-state is per-agent and not persisted (see
// persistence.ts's own doc comment), so there's nothing else to replay here.
{
  const persistedDock = loadPersistedTerminalDock();
  appStore.dispatch({ type: "terminalDockResized", height: persistedDock.height });
}
let prevDockHeight = appStore.getState().terminals.dockHeight;
appStore.subscribe(() => {
  const next = appStore.getState().terminals.dockHeight;
  if (next !== prevDockHeight) {
    prevDockHeight = next;
    persistTerminalDock(next);
  }
});

// DEV-only test seam (companion to the bridge's __CHIMERA_MOCK__): unattended
// browser gates need to read state / dispatch selection without synthesizing
// pointer events. Dead-code-eliminated from production builds.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>)["__CHIMERA_STORE__"] = appStore;
}

// One-shot app bootstrap, called from main.tsx right after the React root
// renders (kept HERE so main.tsx stays a two-line bootstrap). Failures only
// warn: the daemon may simply be down at launch — the bridge keeps reconnecting on its own and
// the UI renders the disconnected state. BLANK-UI-AFTER-SLOW-FIRST-LOAD: the load itself is now
// retried on a bounded ladder rather than left to a connection transition that a slow-but-healthy
// daemon never produces.
export function bootstrapAppStore(): void {
  // Final-acceptance MAJOR 4 (coverage A6-1): on re-entry into "connected"
  // from a down state, gap-fill the outage's missed events (events.replay from
  // lastSeq+1, dispatched as normal event actions — the watermark dedupes) and
  // re-run connectAndLoad (idempotent subscribe + full-replace snapshots). The
  // transition/re-entrancy logic lives in reconnect.ts (pure, unit-tested);
  // the attach-time snapshot state seeds `prev`, so the initial boot's own
  // "connected" never double-fetches.
  // BLANK-UI-AFTER-SLOW-FIRST-LOAD: ONE retrying loader owns every snapshot load — the initial
  // one and every reconnect refetch. Declared first so both call sites share it. See
  // reconnect.ts for why a failure with a HEALTHY socket previously had no recovery path at all.
  const snapshotLoader = createSnapshotLoader({
    load: () => appStore.connectAndLoad(),
    onError: (err, attempt) =>
      console.warn(`[chimera] daemon snapshot load failed (attempt ${attempt}, retrying):`, err),
  });
  const onReconnect = createReconnectRefetcher({
    getLastSeq: () => appStore.getState().lastSeq,
    replay: (params) => rpcCall<NormalizedEvent[]>("events.replay", params),
    dispatchEvent: (e) => appStore.dispatch({ type: "event", event: e, stampTs: true }),
    // Through the loader: a refetch that fails on reconnect now retries on the ladder instead
    // of leaving stale panes until the NEXT drop happens to come along.
    refetch: async () => { snapshotLoader.run(); },
    onError: (err) => console.warn(`[chimera] reconnect refetch failed (replay limit ${RECONNECT_REPLAY_LIMIT}):`, err),
  });
  // daemon://state → the reducer's connected/reconnecting flags. The bridge
  // fires the CURRENT state immediately on attach, so the UI never renders a
  // stale "disconnected" default while the socket is actually live.
  onDaemonState((s) => {
    appStore.dispatch({ type: "connected", connected: s === "connected" });
    appStore.dispatch({ type: "reconnecting", reconnecting: s === "reconnecting" });
    onReconnect(s);
  });
  snapshotLoader.run();
  // W2 done-when evidence: a compact coherent-state snapshot in the dev
  // console, 2s after load (enough time for connectAndLoad's snapshots and the
  // first live events to have folded in). DEV-only — never ships noise.
  if (import.meta.env.DEV) {
    setTimeout(() => {
      const s = appStore.getState();
      console.log("[chimera] state snapshot:", {
        connected: s.connected,
        agents: s.agentOrder.length,
        teams: s.teams.items.length,
        queues: s.queues.items.length,
        events: s.events.length,
      });
    }, 2000);
  }
}
