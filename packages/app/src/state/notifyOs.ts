// W20 (F18 · coverage B22/C16) — the `os` channel's OS-level notification.
//
// tauri-plugin-notification (v2.3.3) delivers a click callback to JS ONLY on
// iOS/Android (its desktop path is a fire-and-forget notify-rust call with no
// click wiring at all — verified against the vendored crate source). Desktop
// click-to-focus/deep-link therefore has to go through the platform's own
// Notification Web API instead: Tauri's desktop webviews (WKWebView/WebView2)
// implement it natively, a real OS notification banner is rendered, and a
// click fires this SAME page's `onclick` directly — no native round-trip
// needed. This is the standard technique other Tauri apps use for exactly
// this gap.
//
// Best-effort by design: an unsupported webview / a user who denied the OS
// permission just never gets one shown — the toast channel (and the daemon's
// own delivery/`notify` event) is unaffected either way.

let permissionRequested = false;

/** Ask once (idempotent — safe to call every mount, e.g. under StrictMode).
 * No-op if the webview lacks the Notification constructor or permission was
 * already decided. */
export function requestOsNotifyPermission(): void {
  if (permissionRequested) return;
  permissionRequested = true;
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Notification.requestPermission().catch(() => {});
}

/** Show an OS notification for a delivered `notify` event; `onClick` fires
 * when the user clicks the banner (the caller applies the deep-link + focuses
 * the window). Swallows every failure — a notification is never load-bearing. */
export function showOsNotification(title: string, body: string, onClick: () => void): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    // best-effort — never blocks the event stream (F18 invariant)
  }
}
