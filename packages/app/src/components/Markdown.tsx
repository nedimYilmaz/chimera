import { PathLink } from "./PathLink";
import { type ReactNode } from "react";
import { trimAutolinkTrailing } from "@chimera/ui-state";
import { isOpenableLinkUrl, openInlineLinkUrl, localLinkTarget } from "./linkUrl";
import styles from "./Markdown.module.css";

// W4 build item 9 — MINIMAL markdown for assistant/result bodies (mock shows
// accent inline code + commit refs, bold emphasis, paragraph rhythm). Renders
// React elements only — NO dangerouslySetInnerHTML, NO remote fetches; links
// render as accent TEXT (title carries the url), never a navigable <a>.
// Supported: **bold**, `inline code`, [text](url), bare http(s) URLs (BARE-URL-
// AUTOLINK), \n\n paragraphs, \n breaks.

// Bold is the only nesting form (INLINE-SPANS-DO-NOT-NEST, mirrors
// @chimera/ui-state's markdown.ts) — its content is re-tokenized so a link
// inside **…** renders as a link, not raw text. code/link stay flat: code's
// content is literal, and a link's display text is a terminal label. Bold
// can't contain another bold: the capture group `[^*]+` bars any `*`, so a
// captured bold's content can never itself contain `**` — recursion is
// bounded to exactly one extra level regardless of input.
type Tok = { kind: "text"; text: string } | { kind: "bold"; toks: Tok[] } | { kind: "code" | "link"; text: string; url?: string };

/** Tokenize one paragraph's inline markup. Pure + exported for tests. */
export function tokenizeInline(text: string): Tok[] {
  const out: Tok[] = [];
  // Four inline forms; earliest match wins each step. The bare-URL form is
  // LAST so it never shadows `[text](url)` — that form starts at `[`, always
  // an earlier scan position than the `http` inside its own `(url)` tail.
  // trimAutolinkTrailing (shared with @chimera/ui-state's identical tokenizer)
  // trims the greedy raw capture back to the real URL; matchLen shortens to
  // match so trimmed characters flow back into the surrounding text.
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\((<[^<>\r\n]+>|[^)\s]+)\))|(https?:\/\/\S+)/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    let matchLen = m[0]!.length;
    if (m[2] !== undefined) out.push({ kind: "bold", toks: tokenizeInline(m[2]) });
    else if (m[4] !== undefined) out.push({ kind: "code", text: m[4] });
    else if (m[6] !== undefined) out.push({ kind: "link", text: m[6], url: m[7] ?? "" });
    else if (m[8] !== undefined) {
      const url = trimAutolinkTrailing(m[8]);
      out.push({ kind: "link", text: url, url });
      matchLen = url.length;
    }
    last = m.index + matchLen;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

function RenderToks({ toks }: { toks: Tok[] }) {
  return (
    <>
      {toks.map((t, i): ReactNode => {
        if (t.kind === "bold") return <b key={i}><RenderToks toks={t.toks} /></b>;
        if (t.kind === "code") return <code key={i} className={styles.code}>{t.text}</code>;
        if (t.kind === "link") {
          const url = t.url ?? "";
          const local = localLinkTarget(url);
          if (local) return <PathLink key={i} text={t.text} path={local.path} line={local.line} />;
          const openable = isOpenableLinkUrl(url);
          return (
            <span
              key={i}
              className={`${styles.link}${openable ? ` ${styles.linkOpenable}` : ""}`}
              title={url}
              role={openable ? "button" : undefined}
              tabIndex={openable ? -1 : undefined}
              onClick={openable ? (e) => { e.stopPropagation(); openInlineLinkUrl(url); } : undefined}
            >
              {t.text}
            </span>
          );
        }
        return <span key={i}>{t.text}</span>;
      })}
    </>
  );
}

/** Blank-line paragraphs render as 6px-gapped divs (the mock's body rhythm);
 * single newlines stay hard breaks via pre-wrap (mirrors W3's Paragraphs). */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <>
      {text.split("\n\n").map((para, i) => (
        <div key={i} className={[styles.para, i > 0 ? styles.paraGap : "", className ?? ""].filter(Boolean).join(" ")}>
          <RenderToks toks={tokenizeInline(para)} />
        </div>
      ))}
    </>
  );
}
