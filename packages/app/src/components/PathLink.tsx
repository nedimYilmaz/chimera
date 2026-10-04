import { useEffect, useState } from "react";
import { openPathViewer, resolvePathRefCached, type PathResolution } from "../state/pathRefs";
import styles from "./MessageBody.module.css";

// Bridge is imported lazily (not at module scope) — same reason as
// linkUrl.ts's openInlineLinkUrl: MessageBody (which every transcript test
// touches) pulls this component in, and rpc/bridge.ts's own module-load side
// effects (its DEV dev_probe wiring) would otherwise fire in tests that don't
// mock the bridge.
function lazyRpcCall<T = unknown>(method: string, params?: unknown): Promise<T> {
  return import("../rpc/bridge").then(({ rpcCall }) => rpcCall<T>(method, params));
}

// FILE-PATH-LINKS — renders a `path`-kind InlineSpan (ui-state's tokenizer;
// SHAPE only — "looks like a path", not "is a real file"). Resolution against
// the app's registered projects is ASYNC (an fs.read round-trip through the
// daemon), so this can't render as a link synchronously the way a `link` span
// does. It stays PLAIN TEXT — identical to the surrounding prose, no dim/
// pending styling that would flicker on every mount — until resolvePathRefCached
// settles to "resolved"; only then does it upgrade to the same accent/
// clickable styling a bare-URL link gets. This is deliberately the "no dead
// click" design: a span never becomes clickable until its target is already
// known to exist and readable, so a click just opens the (already-fetched)
// viewer, never a second round-trip that could fail. A path outside every
// registered project root, or one that plain doesn't exist, never resolves
// and stays plain text forever.
export function PathLink(props: { text: string; path: string; line: number | null }) {
  return <ResolvedPathLink key={props.path} {...props} />;
}

function ResolvedPathLink({ text, path, line }: { text: string; path: string; line: number | null }) {
  const [resolution, setResolution] = useState<PathResolution>({ status: "unresolved" });

  useEffect(() => {
    let alive = true;
    resolvePathRefCached(path, lazyRpcCall).then((r) => {
      if (alive) setResolution(r);
    });
    return () => {
      alive = false;
    };
  }, [path]);

  if (resolution.status !== "resolved") return <span>{text}</span>;

  const { project, relPath, result } = resolution;
  return (
    <span
      className={`${styles.link} ${styles.linkOpenable}`}
      title={`${project}: ${relPath}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          if (!e.repeat) openPathViewer(project, relPath, result, line);
        }
      }}
      onClick={(e) => {
        e.stopPropagation();
        openPathViewer(project, relPath, result, line);
      }}
    >
      {text}
    </span>
  );
}

// CODE-CHIP-PATHS: a path written the way people actually write one — in backticks. Markdown says
// that is inline CODE, and the parser's path detection only runs over PLAIN TEXT, so
// `PROJ-5678/tasks/` reached the transcript as an unclickable chip while the same path unquoted
// would have been a link. That is backwards: the backticked form is the CORRECT way to write it.
//
// Renders exactly the code chip it replaces until the target is confirmed to exist and be
// readable, then upgrades to clickable — the same "no dead click" contract PathLink has, and the
// reason a chip that is not a path is indistinguishable from before.
export function CodeChip({ text, className }: { text: string; className: string }) {
  const [resolution, setResolution] = useState<PathResolution>({ status: "unresolved" });
  const candidate = looksLikeFileRef(text);

  useEffect(() => {
    if (!candidate) return undefined;
    let alive = true;
    resolvePathRefCached(text, lazyRpcCall).then((r) => { if (alive) setResolution(r); });
    return () => { alive = false; };
  }, [text, candidate]);

  if (resolution.status !== "resolved") return <code className={className}>{text}</code>;
  const { project, relPath, result } = resolution;
  return (
    <code
      className={`${className} ${styles.codePathOpenable}`}
      title={`${project}: ${relPath}`}
      role="button"
      tabIndex={-1}
      onClick={(e) => { e.stopPropagation(); openPathViewer(project, relPath, result, null); }}
      data-code-path={relPath}
    >
      {text}
    </code>
  );
}

/** A cheap LOCAL filter, run before anything is asked of the daemon.
 *
 *  Inline code is the most common span in a technical transcript — every `foo()`, `--flag` and
 *  `null` is one. Resolving each would be a request per chip per message, so a chip only earns a
 *  lookup if it is shaped like a file reference at all: no whitespace, bounded length, and either a
 *  directory separator or a file extension. Everything else is rejected here, for free. */
export function looksLikeFileRef(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 200) return false;
  if (/\s/.test(t)) return false;
  // A URL is already handled as a link; treating it as a path would ask the daemon to read it.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
  const hasSlash = t.includes("/");
  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(t);
  if (!hasSlash && !hasExt) return false;
  // Reject things that are shaped like code rather than a path — a call, an index, a generic.
  if (/[()\[\]{}<>,;'"`|*?]/.test(t)) return false;
  return true;
}
