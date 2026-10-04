import { parsePathToken } from "@chimera/ui-state";

// CLICKABLE-LINKS: an inline `[text](url)` span never becomes a live <a> in
// the webview (that would let a message body navigate the app shell away
// from itself — see MessageBody.tsx/Markdown.tsx's no-anchor rule). Instead
// a click hands the url to the OS opener via the same Rust command "link"
// artifacts already use (open_artifact_url). The scheme allowlist is the
// actual security boundary here: handing an arbitrary scheme (file:,
// javascript:, data:, a custom handler) to the OS opener is a bigger risk
// than webview navigation, so it is enforced in TS BEFORE the url ever
// reaches Rust — never rely on the Rust side to filter.
export function isOpenableLinkUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Bridge is imported lazily (not at module scope) so pulling in this pure
// validator — from MessageBody/Markdown, which every transcript test
// touches — never triggers rpc/bridge.ts's own module-load side effects
// (its DEV dev_probe wiring) in tests that don't mock the bridge.
export function openInlineLinkUrl(url: string): void {
  if (!isOpenableLinkUrl(url)) return;
  void import("../rpc/bridge").then(({ openArtifactUrl }) => openArtifactUrl(url));
}

/** Explicit Markdown destinations may name files, including spaces and line suffixes.
 * The daemon's existing fs.resolve remains the authority on allowed roots/readability. */
export function localLinkTarget(url: string): { path: string; line: number | null } | null {
  let raw = url.startsWith("<") && url.endsWith(">") ? url.slice(1, -1) : url;
  try { raw = decodeURIComponent(raw); } catch { return null; }
  if (!raw || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//") || raw.startsWith("#")) return null;
  const { path, line } = parsePathToken(raw);
  if (!path.includes("/") && !/\.[a-z0-9]+$/i.test(path)) return null;
  return { path, line: line !== null && Number.isSafeInteger(line) && line > 0 ? line : null };
}
