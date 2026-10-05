import type { GitTarget } from "@chimera/protocol";
import { WorkingTreeDisclosure } from "../components/WorkingTreePanel";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CodeBlock, MessageBody } from "../components/MessageBody";
import { ImageChip } from "../components/ImageChip";
import type { FsSelectedFile } from "../state/commands.projects";
import { classifyFileView, truncationBannerText } from "../state/selectors.fileviewer";
import { formatArtifactSize } from "../state/selectors.artifacts";
import { HIGHLIGHT_LINE_CLASS } from "./fileHighlightClass";
import styles from "./FileViewer.module.css";

function baseName(path: string): string {
  return path.split("/").pop() || path;
}

// FILE-PATH-LINKS — the no-shiki-available fallback (unmapped extension, or
// the language chunk hasn't loaded yet) for a `path:line` open: CodeBlock's
// plain <pre> has no per-line DOM node to scroll to, so this renders one
// line per <div> instead, purely so the target line has something to
// scrollIntoView against. Used ONLY when a line needs highlighting — every
// other open keeps using the flat CodeBlock <pre> unchanged.
/** MD-FILE-VIEWER: the extensions selectors.fileviewer maps onto the markdown language id. Asked
 *  as a function rather than compared inline so the two call sites cannot drift. */
function isMarkdown(lang: string | null | undefined): boolean {
  return lang === "markdown";
}

function PlainCodeLines({ content, highlightLine }: { content: string; highlightLine: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector(`.${HIGHLIGHT_LINE_CLASS}`)?.scrollIntoView({ block: "center" });
  }, [content, highlightLine]);
  return (
    <div ref={ref} className={styles.plainLines}>
      {content.split("\n").map((line, i) => (
        <div key={i} className={i + 1 === highlightLine ? HIGHLIGHT_LINE_CLASS : undefined}>
          {line.length > 0 ? line : " "}
        </div>
      ))}
    </div>
  );
}

// Renders Shiki's own tokenized HTML once its language chunk resolves;
// CodeBlock's plain <pre> (or, when a line needs highlighting, PlainCodeLines)
// covers both the load gap and an unmapped language (highlightFile resolves
// null for either) — never a blank pane. `highlightLine` (1-based, the
// path:line/path:line:col a PathLink was clicked with) wraps that line in
// HIGHLIGHT_LINE_CLASS via shiki's decorations option and scrolls it into view
// once the highlighted HTML is in the DOM.
export function HighlightedCode({ content, lang, highlightLine }: { content: string; lang: string | null; highlightLine?: number | null }) {
  const [html, setHtml] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    // BUNDLE-STARTUP-COST: shiki is loaded here, on first render of a highlighted file, rather
    // than at module scope. CodeBlock's plain <pre> already covers the gap, so the only visible
    // effect is that the very first file resolves its colours a beat later.
    void import("./fileHighlight").then(({ highlightFile }) => highlightFile(content, lang, highlightLine)).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [content, lang, highlightLine]);
  useEffect(() => {
    if (!html || !highlightLine) return;
    containerRef.current?.querySelector(`.${HIGHLIGHT_LINE_CLASS}`)?.scrollIntoView({ block: "center" });
  }, [html, highlightLine]);
  if (html) return <div ref={containerRef} className={styles.shiki} dangerouslySetInnerHTML={{ __html: html }} />;
  if (highlightLine) return <PlainCodeLines content={content} highlightLine={highlightLine} />;
  return <CodeBlock block={{ type: "code", lang, text: content }} />;
}

export function FileViewer({ selected, onClose, highlightLine, worktree }: { selected: FsSelectedFile; onClose: () => void; highlightLine?: number | null; worktree?: { target: GitTarget; path: string } }) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        ev.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);

  const view = classifyFileView(selected);
  const name = baseName(selected.path);
  // Reset per FILE, not per open: flipping to source on one document should not follow you into
  // the next one you click.
  const [showSource, setShowSource] = useState(false);
  useEffect(() => { setShowSource(false); }, [selected.path]);

  // Portal to <body> (ImageChip.tsx:39 precedent): a fixed overlay mounted
  // inside the project detail pane would be clipped to whatever
  // transformed/contained ancestor hosts it, instead of covering the window.
  return createPortal(
    <div
      className={styles.scrim}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-file-viewer
    >
      <div className={styles.card}>
        <div className={styles.header}>
          <span className={styles.name}>{name}</span>
          <span className={styles.path}>{selected.path}</span>
          <span className={styles.spacer} />
          {/* MD-FILE-VIEWER: only offered for a file that HAS two views. Shown for a line-anchored
              open too, disabled, so the reason the document is not rendered is visible rather than
              leaving someone to wonder why this file looks different from the last one. */}
          {isMarkdown(view.kind === "text" ? view.lang : null) ? (
            <button
              type="button"
              className={styles.rawToggle}
              onClick={() => setShowSource((v) => !v)}
              disabled={highlightLine !== undefined}
              title={highlightLine !== undefined
                ? "opened at a line — the source is shown so the line can be pointed at"
                : "toggle rendered / source"}
              data-file-viewer-raw-toggle
            >
              {showSource || highlightLine !== undefined ? "rendered" : "source"}
            </button>
          ) : null}
          <button type="button" className={styles.close} onClick={onClose} title="close (esc)">
            ✕
          </button>
        </div>
        <div className={styles.body}>
          {worktree && <WorkingTreeDisclosure target={worktree.target} initialPath={worktree.path} />}
          {view.kind === "error" ? (
            <div className={styles.placeholder}>{view.message}</div>
          ) : view.kind === "image" ? (
            <div className={styles.imageWrap}>
              <ImageChip image={{ mediaType: view.mediaType, data: view.data }} name={name} />
            </div>
          ) : view.kind === "binary" ? (
            <div className={styles.placeholder}>
              {name} · {formatArtifactSize(view.sizeBytes)} · binary file — not shown
            </div>
          ) : (
            <>
              {view.truncated ? <div className={styles.banner}>{truncationBannerText(view)}</div> : null}
              {/* MD-FILE-VIEWER: a markdown file was being shown as syntax-highlighted SOURCE —
                  every `#`, `**` and table pipe on screen, which is the one format this app
                  already knows how to render properly. It renders now, with a toggle back to the
                  source, because the source is what you want when you are about to EDIT it.

                  A `path:line` open forces source: a rendered document has no line 42 to scroll
                  to, so honouring the line and rendering are mutually exclusive — the line wins,
                  since it is the more specific request. */}
              {isMarkdown(view.lang) && !highlightLine && !showSource ? (
                <div className={styles.mdArea} data-file-viewer-markdown>
                  {/* done: a file on disk is never mid-stream, so every block is closed and formatted
                      immediately — the streaming contract's "raw until it terminates" rule would
                      otherwise leave the last block unrendered. */}
                  <MessageBody text={view.content} done rawView={false} />
                </div>
              ) : (
                <div className={styles.codeArea}>
                  <HighlightedCode content={view.content} lang={view.lang} highlightLine={highlightLine} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
