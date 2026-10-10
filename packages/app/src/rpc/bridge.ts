// The ONE door between the webview and chimerad — W2's store and every screen
// import from here and only here. The Rust side (src-tauri/src/daemon.rs) owns
// the socket, framing, hello handshake, reconnect backoff and subscribe
// re-apply; this module is a thin typed veneer over Tauri invoke/listen.
// Wire types come from @chimera/protocol — never re-declared.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NormalizedEvent } from "@chimera/protocol";

export type ConnState = "connected" | "reconnecting" | "disconnected";

// ---- DEV-only test seam --------------------------------------------------
// Unattended visual gates run the frontend in a plain browser (Playwright over
// the vite dev server) where Tauri's IPC doesn't exist. When a test installs
// `window.__CHIMERA_MOCK__` BEFORE the app loads, every bridge function routes
// through it instead of invoke/listen, and the bridge exposes
// `window.__CHIMERA_PUSH__` so the test can inject state/event frames as if
// Rust emitted them. Behind import.meta.env.DEV, so production builds
// dead-code-eliminate the whole seam.
type MockBridge = { rpc(method: string, params: unknown): Promise<unknown> };
type PushHooks = { state(s: ConnState): void; event(e: NormalizedEvent): void };
declare global {
  interface Window {
    __CHIMERA_MOCK__?: MockBridge;
    __CHIMERA_PUSH__?: PushHooks;
  }
}
// This module only ever runs inside the Tauri webview (window always present) or under the
// DEV mock seam above (also window-gated). A bare `window === undefined` means neither — e.g.
// store.ts's module-level installVoiceEventBridge()/dev-probe wiring evaluating under a plain
// Node test runner — where invoke/listen would throw ReferenceError deep in @tauri-apps/api.
// Treat that case as an inert no-op bridge rather than letting it crash module import.
const hasWindow = typeof window !== "undefined";
const mock: MockBridge | undefined = import.meta.env.DEV && hasWindow ? window.__CHIMERA_MOCK__ : undefined;
const mockStateCbs = new Set<(s: ConnState) => void>();
const mockEventCbs = new Set<(e: NormalizedEvent) => void>();
let mockConnState: ConnState = "disconnected";
if (mock) {
  window.__CHIMERA_PUSH__ = {
    state(s) {
      mockConnState = s;
      for (const cb of mockStateCbs) cb(s);
    },
    event(e) {
      for (const cb of mockEventCbs) cb(e);
    },
  };
}
// ---------------------------------------------------------------------------

/** One JSON-RPC round-trip. Rejections carry the daemon's own {code,message}
 * shape (RpcError serializes it 1:1), so error probes like the TUI store's
 * isUnknownMethod work unchanged against this bridge. 30s timeout Rust-side. */
export function rpcCall<T = unknown>(method: string, params?: unknown): Promise<T> {
  if (mock) return mock.rpc(method, params ?? {}) as Promise<T>;
  // `params ?? {}` mirrors the daemon's own `req.params ?? {}` default and
  // keeps the Rust command's non-optional `params: Value` satisfied.
  return invoke<T>("rpc_call", { method, params: params ?? {} });
}

/** Turn on the daemon's event stream for this app. Idempotent: the daemon
 * keeps exactly one subscription per connection (a re-subscribe replaces it),
 * and Rust remembers the last filter and re-applies it after every reconnect —
 * call once, never again after a `reconnecting` → `connected` transition. */
export async function subscribeEvents(filter?: { agentId?: string }): Promise<void> {
  if (mock) return;
  await invoke("subscribe", { filter: filter ?? {} });
}

/** Every daemon event (NormalizedEvent JSON verbatim). Returns a disposer. */
export function onDaemonEvent(cb: (e: NormalizedEvent) => void): () => void {
  if (mock) {
    mockEventCbs.add(cb);
    return () => mockEventCbs.delete(cb);
  }
  if (!hasWindow) return () => {};
  let disposed = false;
  const unlisten = listen<NormalizedEvent>("daemon://event", (ev) => {
    if (!disposed) cb(ev.payload);
  });
  return () => {
    disposed = true;
    void unlisten.then((un) => un());
  };
}

/** Connection-state transitions, plus the CURRENT state delivered immediately
 * on attach (via one daemon_status snapshot) — `daemon://state` only fires on
 * transitions, so a late subscriber would otherwise render nothing until the
 * next drop/reconnect. Returns a disposer. */
export function onDaemonState(cb: (s: ConnState) => void): () => void {
  if (mock) {
    mockStateCbs.add(cb);
    cb(mockConnState); // mirror the real path's attach-time snapshot delivery
    return () => mockStateCbs.delete(cb);
  }
  if (!hasWindow) return () => {};
  let disposed = false;
  // If a live transition lands before the snapshot resolves, the snapshot is
  // stale — drop it rather than rewinding the UI to an older state.
  let sawLive = false;
  const unlisten = listen<ConnState>("daemon://state", (ev) => {
    if (disposed) return;
    sawLive = true;
    cb(ev.payload);
  });
  void daemonStatus().then((s) => {
    if (!disposed && !sawLive) cb(s);
  });
  return () => {
    disposed = true;
    void unlisten.then((un) => un());
  };
}

/** Snapshot of the current connection state (Rust-side watch value). */
export function daemonStatus(): Promise<ConnState> {
  if (mock) return Promise.resolve(mockConnState);
  if (!hasWindow) return Promise.resolve("disconnected");
  return invoke<ConnState>("daemon_status");
}

// ---- F17 (W19) artifacts: local-fs snapshot read + OS open --------------
// Tauri-only capabilities (the webview itself has no fs seam — same rule
// ImageChip's OS-viewer open follows). The browser/mock gate has no
// equivalent (there is no on-disk snapshot to read there), so these reject/
// no-op under `mock` rather than attempting an invoke() the runtime can't
// serve; callers already treat a rejected read as "no preview available".

/** Read an artifact's on-disk snapshot (`${CHIMERA_HOME}/artifacts/<id>`) as
 * text — feeds the in-app preview (F12 renderer) and a diff chip's ±line
 * count (selectors.artifacts.countDiffLines). */
export function readArtifactSnapshot(id: string): Promise<string> {
  if (mock) return Promise.reject(new Error("artifact preview is unavailable in the mock bridge"));
  return invoke<string>("read_artifact", { id });
}

export async function prepareLocalMedia(path: string): Promise<string> {
  if (mock) return mock.rpc("native.prepareLocalMedia", { path }) as Promise<string>;
  return convertFileSrc(await invoke<string>("prepare_local_media", { path }));
}

export async function openLocalFile(path: string, reveal = false): Promise<void> {
  if (mock) { await mock.rpc("native.openLocalFile", { path, reveal }); return; }
  await invoke("open_local_file", { path, reveal });
}

/** `o` OS-open for a report/diff/chart/file-kind artifact's snapshot. */
export function openArtifactSnapshot(id: string): Promise<void> {
  if (mock) return Promise.resolve();
  return invoke("open_artifact", { id });
}

/** `o` OS-open for a "link"-kind artifact (no snapshot — opens the url). */
export function openArtifactUrl(url: string): Promise<void> {
  if (mock) return Promise.resolve();
  return invoke("open_artifact_url", { url });
}

// ---- F18 (W20) notifications: dock badge --------------------------------

/** Native taskbar/dock badge count (Window::set_badge_count — core Tauri, no
 * plugin) = pending permissions + questions (selectors.notify.pendingBadgeCount).
 * A count <= 0 clears the badge. No-op under the browser/mock bridge. */
export function setDockBadge(count: number): Promise<void> {
  if (mock) return Promise.resolve();
  return invoke("set_dock_badge", { count });
}

// ---- F19 (W21) usage & cost: csv export -----------------------------------

/** `x` in the usage card writes the current groupBy rows to
 * `${CHIMERA_HOME}/exports/<filename>` and resolves the on-disk path (the
 * "csv exported: <path>" toast text) — no fs seam in the webview, same rule
 * as artifact snapshots. The browser/mock bridge has nowhere to write, so it
 * resolves a synthetic path instead of invoking a command the runtime can't
 * serve (mirrors setDockBadge's no-op-under-mock shape). */
export function exportCsv(filename: string, content: string): Promise<string> {
  if (mock) return Promise.resolve(`/mock/exports/${filename}`);
  return invoke<string>("write_export", { filename, content });
}

// ---- F20 (files-since fix) checkpoints: files changed since a checkpoint --

/** The checkpoints card's "files changed since" count for one row —
 * `git diff --name-only <ref>..HEAD` in the repo, Tauri-only (no fs/git seam
 * in the webview itself, same rule as artifact snapshots). Rejects under the
 * mock bridge; commands.checkpoints.ts's per-row fetch already swallows a
 * rejection rather than toasting one per row. */
export function checkpointFilesSince(cwd: string, ref: string): Promise<number> {
  if (mock) return Promise.reject(new Error("files-since is unavailable in the mock bridge"));
  return invoke<number>("checkpoint_files_since", { cwd, checkpointRef: ref });
}

// DEV probe: mirror everything the webview RECEIVES back into Rust's dev_probe
// command (append-to-$CHIMERA_PROBE_FILE, debug builds only). This is the
// machine-checkable proof that daemon frames traverse the full pipe — socket →
// daemon.rs → emit → webview listener — in unattended runs where the window
// itself is unobservable (locked display defeats screencapture). No-ops
// entirely unless the env var is set on the Rust side.
if (import.meta.env.DEV && !mock) {
  onDaemonState((s) => void invoke("dev_probe", { line: `state ${s}` }).catch(() => {}));
  onDaemonEvent((e) => void invoke("dev_probe", { line: `event ${e.kind} ${e.agentId}` }).catch(() => {}));
}
