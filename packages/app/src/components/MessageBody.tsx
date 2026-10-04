import { createContext, useContext, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  parseMessageBlocks,
  type ChartPoint,
  type ChartSeries,
  type ChecklistTone,
  type InlineSpan,
  type MermaidEdge,
  type MermaidNode,
  type MessageBlock,
  type StatusTone,
  type TreeBadge,
} from "@chimera/ui-state";
import { toneVar, type MentionInfo } from "../state/selectors";
import { highlightQuery, splitHighlight, subscribeHighlight } from "../state/transcriptHighlight";
import { HIT_ATTR } from "../state/transcriptFind";
import { ExcalidrawBlock } from "./ExcalidrawBlock";
import { isOpenableLinkUrl, openInlineLinkUrl, localLinkTarget } from "./linkUrl";
import { CodeChip, PathLink } from "./PathLink";
import styles from "./MessageBody.module.css";

// F22 (W24): resolves an @mention's bare name (or "studio/name") against
// known agents — null for an unmatched-shape or genuinely unknown name, which
// renders as plain text (F22 acceptance). Kept as a resolver function (not a
// Map prop) so MessageBody stays state-agnostic — TranscriptPanel supplies it,
// same "caller resolves, this component just renders" split as onLinkClick.
export type ResolveMention = (name: string) => MentionInfo | null;

// F12 (W12) — the rich agent-message renderer. Consumes the shared,
// streaming-aware markdown-subset parser from @chimera/ui-state and draws:
// pipe tables (aligned columns, numeric right-aligned, header caption style,
// h-scroll overflow), fenced code (+lang tag), lists, inline code/bold/link,
// and `chart` blocks as labeled token-colored bars. The mock's ?showRichMsg=1
// is the visual law.
//
// v7 extension (W14, Tauri-only) — the ```chart fence grows to accept a
// multi-series form (title?, labels[], series[{name,points[]}]) drawn as an
// in-house SVG bar/line chart with legend + axis labels; the W12 single-series
// {data:[{label,value}]} form stays valid and renders unchanged (additive). A
// new ```mermaid fence renders a flowchart-LR subset (nodes + edges) as a
// node/arrow SVG diagram; unsupported syntax already degraded to a code block
// upstream in the parser. While either fence is still streaming, the raw block
// carries streamingKind and renders a dim placeholder instead of raw JSON —
// unlike table/code, which keep showing raw lines while open.
//
// STREAMING: the parser returns the still-open trailing region as a single
// { type:"raw" } block; closed blocks are byte-stable across a growing stream.
// We KEY every block by its index — because closed blocks keep their index and
// content across deltas, React never remounts or reflows an already-formatted
// block; only the trailing raw block (last index) changes, and its one-time
// swap to a formatted block is the single intended transition. No literal hex
// anywhere (CI guard); chart/series/diagram colors cycle a token palette.

// Token-only bar palette — the mock's two chart bars map exactly to the
// --select-hl and --edge-allow tokens; we cycle those plus account hues so
// wider datasets stay token-colored (no literal hex — CI guard).
const BAR_TOKENS = [
  "var(--select-hl)",
  "var(--edge-allow)",
  "var(--acct-3)",
  "var(--acct-1)",
  "var(--acct-5)",
  "var(--acct-6)",
] as const;

// F22 (W24): the @mention chip — a live state dot + name, dimmed (but still
// clickable — "keeps working") for a finished agent, click routes exactly
// like an agent-list-row click (TranscriptPanel supplies onClick). Exported
// so the spawn-lineage line (TranscriptPanel) renders the SAME chip, not a
// second lookalike implementation.
export function MentionChip({ name, info, onClick }: { name: string; info: MentionInfo; onClick?: (agentId: string) => void }) {
  return (
    <span
      className={`${styles.mention}${info.dimmed ? ` ${styles.mentionDim}` : ""}`}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : -1}
      data-agent-link={info.agentId}
      onKeyDown={onClick ? (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault(); e.stopPropagation(); onClick(info.agentId);
      } : undefined}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(info.agentId); } : undefined}
    >
      <span className={styles.mentionDot} style={{ background: toneVar(info.tone) }} />@{name}
    </span>
  );
}

// MEM-5 (PLAN-MEMORY.md §8): the Memory tab supplies a wiki-link handler so a
// `[[…]]` span in a note body renders as a click-navigable chip; every OTHER
// MessageBody consumer (the transcript) leaves this null, so `[[…]]` there just
// draws a static chip (the display text) with no click. A context — rather than
// prop-drilling through BlockView/list/quote — keeps the render tree untouched.
export type WikiLinkResolution = { resolvedId: string | null; resolvedTitle: string | null };
export type WikiLinkHandlers = {
  resolve: (target: string) => WikiLinkResolution | null;   // null ⇒ unknown (draw plain chip)
  onNavigate: (target: string) => void;
};
const WikiLinkContext = createContext<WikiLinkHandlers | null>(null);
export function WikiLinkProvider({ value, children }: { value: WikiLinkHandlers; children: ReactNode }) {
  return <WikiLinkContext.Provider value={value}>{children}</WikiLinkContext.Provider>;
}

function WikiChip({ target, text }: { target: string; text: string }): ReactNode {
  const wiki = useContext(WikiLinkContext);
  const res = wiki?.resolve(target) ?? null;
  // resolved → live chip; ghost (a [[Title]] with no note) → dim; missing (a
  // [[id]] to an evicted/deleted note) → dim + strike-ish; no handler → plain.
  const status = !wiki ? "plain" : res?.resolvedId ? "resolved" : res?.resolvedTitle ? "ghost" : "missing";
  const cls = status === "resolved" ? styles.wikiLink : status === "ghost" ? styles.wikiGhost : status === "missing" ? styles.wikiMissing : styles.wikiPlain;
  // Only a RESOLVED link navigates — a ghost ([[Title]] with no note yet) and a
  // missing ([[id]] to an evicted note) have nowhere to go, so they render dim and
  // non-clickable rather than as buttons whose click silently no-ops.
  const clickable = status === "resolved";
  return (
    <span
      className={cls}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? -1 : undefined}
      title={status === "missing" ? `${target} (missing)` : status === "ghost" ? `${target} (no note yet)` : target}
      onClick={clickable ? (e) => { e.stopPropagation(); wiki!.onNavigate(target); } : undefined}
    >
      {text}
    </span>
  );
}

/** TRANSCRIPT-HIGHLIGHT: plain text with the active search query marked.
 *
 *  Subscribes here, at the leaf, rather than taking the query as a prop: the alternative is a
 *  parameter threaded through every component between the panel and this span, on the hottest
 *  render path in the app, carrying a value that is empty almost all of the time. When no search
 *  is open this renders exactly the <span> it replaced. */
function Highlighted({ text }: { text: string }): ReactNode {
  const q = useSyncExternalStore(subscribeHighlight, highlightQuery, highlightQuery);
  if (q.length === 0) return <span>{text}</span>;
  const parts = splitHighlight(text, q);
  if (parts.length === 1) return <span>{text}</span>;
  return (
    <span>
      {/* TRANSCRIPT-FIND: the attribute is what makes a mark countable and reachable — the search
          bar steps the cursor over these in document order. */}
      {parts.map((p, i) => (p.hit ? <mark key={i} className={styles.searchHit} {...{ [HIT_ATTR]: "" }}>{p.text}</mark> : p.text))}
    </span>
  );
}

function Inline({ spans, resolveMention, onMentionClick }: { spans: InlineSpan[]; resolveMention?: ResolveMention; onMentionClick?: (agentId: string) => void }): ReactNode {
  return (
    <>
      {spans.map((s, i): ReactNode => {
        if (s.kind === "bold") return <b key={i}><Inline spans={s.spans} resolveMention={resolveMention} onMentionClick={onMentionClick} /></b>;
        // CODE-CHIP-PATHS: a backticked path is how people actually write one, and markdown makes
        // that inline CODE — so the parser's path detection, which only sees plain text, never
        // reached it. CodeChip renders the identical chip until the target is confirmed to exist.
        if (s.kind === "code") return <CodeChip key={i} text={s.text} className={styles.code} />;
        // links render as accent TEXT (title carries the url) — never a live
        // <a> in the webview (parity with Markdown.tsx's rule). A click still
        // routes local files to the confined viewer and http(s) URLs to the OS browser.
        if (s.kind === "link") {
          const local = localLinkTarget(s.url);
          if (local) return <PathLink key={i} text={s.text} path={local.path} line={local.line} />;
          const openable = isOpenableLinkUrl(s.url);
          return (
            <span
              key={i}
              className={`${styles.link}${openable ? ` ${styles.linkOpenable}` : ""}`}
              title={s.url}
              role={openable ? "button" : undefined}
              tabIndex={openable ? -1 : undefined}
              onClick={openable ? (e) => { e.stopPropagation(); openInlineLinkUrl(s.url); } : undefined}
            >
              {s.text}
            </span>
          );
        }
        if (s.kind === "mention") {
          const info = resolveMention?.(s.name) ?? null;
          // unknown name → plain text, "@" included (F22 acceptance).
          if (!info) return <span key={i}>@{s.name}</span>;
          return <MentionChip key={i} name={s.name} info={info} onClick={onMentionClick} />;
        }
        if (s.kind === "wikilink") return <WikiChip key={i} target={s.target} text={s.text} />;
        // FILE-PATH-LINKS: a path-shaped span — PathLink resolves it against
        // the app's registered projects (async, cached) and only THEN renders
        // clickable; see PathLink.tsx for why this can't be inline here.
        if (s.kind === "path") return <PathLink key={i} text={s.text} path={s.path} line={s.line} />;
        // TRANSCRIPT-HIGHLIGHT: plain text is the only span kind that gets marked. A mention chip,
        // a file path or a wikilink is a rendered WIDGET whose text is a label — splitting it to
        // paint part of it a different colour would break the thing itself.
        return <Highlighted key={i} text={s.text} />;
      })}
    </>
  );
}

function TableBlock({ block, resolveMention, onMentionClick }: {
  block: Extract<MessageBlock, { type: "table" }>;
  resolveMention?: ResolveMention;
  onMentionClick?: (agentId: string) => void;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {block.headers.map((h, c) => (
              <th key={c} className={block.align[c] === "right" ? styles.thRight : undefined}>
                <Inline spans={h} resolveMention={resolveMention} onMentionClick={onMentionClick} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td
                  key={c}
                  className={[c === 0 ? styles.tdKey : "", block.align[c] === "right" ? styles.tdRight : ""]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <Inline spans={cell} resolveMention={resolveMention} onMentionClick={onMentionClick} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChartBlock({ block }: { block: Extract<MessageBlock, { type: "chart"; data: ChartPoint[] }> }) {
  // Bars for both bar AND line specs (line degrades to bars — F12). Widths are
  // proportional to the max absolute value; value + optional unit right-aligned.
  const max = Math.max(1, ...block.data.map((d) => Math.abs(d.value)));
  return (
    <div className={styles.chart}>
      {block.data.map((d, i) => (
        <div key={i} className={styles.chartRow}>
          <span className={styles.chartLabel} title={d.label}>{d.label}</span>
          <span className={styles.chartTrack}>
            <span
              className={styles.chartBar}
              style={{ width: `${(Math.abs(d.value) / max) * 100}%`, background: BAR_TOKENS[i % BAR_TOKENS.length] }}
            />
          </span>
          <span className={styles.chartValue}>
            {d.value}
            {block.unit ? <span className={styles.chartUnit}> {block.unit}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// v7 (W14) multi-series chart — in-house SVG bar/line chart with a legend and
// axis labels, no external charting library. Token-colored via BAR_TOKENS
// (same palette as the W12 single-series bars, for series-index parity).
// ---------------------------------------------------------------------------

const SERIES_CHART_W = 480;
const SERIES_CHART_H = 180;
const SERIES_PAD = { top: 10, right: 10, bottom: 22, left: 34 };

// Exported (W21/F19) so the usage & cost card's 7-day trend can reuse this
// in-house SVG line/bar renderer instead of a second implementation — takes
// the chart fields directly (not a MessageBlock) so non-chat callers don't
// need to synthesize one.
export function SeriesChart({
  chartType,
  labels,
  series,
  unit,
  title,
}: {
  chartType: "bar" | "line";
  labels: string[];
  series: ChartSeries[];
  unit?: string;
  title?: string;
}) {
  const plotW = SERIES_CHART_W - SERIES_PAD.left - SERIES_PAD.right;
  const plotH = SERIES_CHART_H - SERIES_PAD.top - SERIES_PAD.bottom;
  const allPoints = series.flatMap((s) => s.points);
  const maxV = Math.max(0, ...allPoints);
  const minV = Math.min(0, ...allPoints);
  const range = maxV - minV || 1;
  const yFor = (v: number): number => SERIES_PAD.top + plotH - ((v - minV) / range) * plotH;
  const xFor = (i: number): number =>
    labels.length > 1 ? SERIES_PAD.left + (i / (labels.length - 1)) * plotW : SERIES_PAD.left + plotW / 2;
  // thin out x-axis labels so they never overlap (at most ~8 shown)
  const labelStep = Math.max(1, Math.ceil(labels.length / 8));
  const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));

  return (
    <div className={styles.seriesChart}>
      {title || unit ? (
        <div className={styles.chartTitle}>
          {title}
          {unit ? <span className={styles.chartUnit}>{title ? " · " : ""}{unit}</span> : null}
        </div>
      ) : null}
      <svg viewBox={`0 0 ${SERIES_CHART_W} ${SERIES_CHART_H}`} className={styles.seriesChartSvg} role="img" aria-label={title ?? "chart"}>
        <line
          x1={SERIES_PAD.left}
          y1={yFor(0)}
          x2={SERIES_PAD.left + plotW}
          y2={yFor(0)}
          className={styles.chartAxisLine}
        />
        {[maxV, (maxV + minV) / 2, minV].map((v, i) => (
          <text key={i} x={SERIES_PAD.left - 6} y={yFor(v)} dy="0.3em" textAnchor="end" className={styles.chartAxisLabel}>
            {fmt(v)}
          </text>
        ))}
        {labels.map((l, i) =>
          i % labelStep === 0 ? (
            <text key={i} x={xFor(i)} y={SERIES_CHART_H - 6} textAnchor="middle" className={styles.chartAxisLabel}>
              {l}
            </text>
          ) : null,
        )}
        {chartType === "line"
          ? series.map((s, si) => (
              <g key={si}>
                <polyline
                  points={s.points.map((v, i) => `${xFor(i)},${yFor(v)}`).join(" ")}
                  className={styles.chartLine}
                  style={{ stroke: BAR_TOKENS[si % BAR_TOKENS.length] }}
                />
                {s.points.map((v, i) => (
                  <circle key={i} cx={xFor(i)} cy={yFor(v)} r={2.5} style={{ fill: BAR_TOKENS[si % BAR_TOKENS.length] }} />
                ))}
              </g>
            ))
          : labels.map((_, i) => {
              const groupW = plotW / labels.length;
              const barW = Math.max(2, (groupW * 0.7) / series.length);
              const groupStart = SERIES_PAD.left + i * groupW + groupW * 0.15;
              return (
                <g key={i}>
                  {series.map((s, si) => {
                    const v = s.points[i] ?? 0;
                    const y0 = yFor(0);
                    const y1 = yFor(v);
                    return (
                      <rect
                        key={si}
                        x={groupStart + si * barW}
                        y={Math.min(y0, y1)}
                        width={Math.max(1, barW - 1)}
                        height={Math.max(1, Math.abs(y1 - y0))}
                        style={{ fill: BAR_TOKENS[si % BAR_TOKENS.length] }}
                      />
                    );
                  })}
                </g>
              );
            })}
      </svg>
      <div className={styles.legend}>
        {series.map((s, i) => (
          <span key={i} className={styles.legendItem}>
            <span className={styles.legendSwatch} style={{ background: BAR_TOKENS[i % BAR_TOKENS.length] }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// v7 (W14) mermaid — flowchart-LR subset (nodes + edges only, per the parser's
// scope guard). Layout: columns by longest-path-from-root (Kahn's algorithm),
// nodes stacked within a column; disconnected/cyclic nodes append after the
// last known column (a graceful fallback layout, never a crash).
// ---------------------------------------------------------------------------

const MERMAID_NODE_W = 96;
const MERMAID_NODE_H = 36;
const MERMAID_COL_GAP = 44;
const MERMAID_ROW_GAP = 14;

function layoutMermaid(nodes: MermaidNode[], edges: MermaidEdge[]): Map<string, { col: number; row: number }> {
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    if (adj.has(e.from) && indeg.has(e.to)) {
      adj.get(e.from)!.push(e.to);
      indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    }
  }
  const col = new Map<string, number>();
  const order: string[] = [];
  for (const n of nodes) {
    if (indeg.get(n.id) === 0) {
      col.set(n.id, 0);
      order.push(n.id);
    }
  }
  const remaining = new Map(indeg);
  const seen = new Set(order);
  for (let head = 0; head < order.length; head++) {
    const id = order[head]!;
    const c = col.get(id)!;
    for (const next of adj.get(id) ?? []) {
      col.set(next, Math.max(col.get(next) ?? 0, c + 1));
      remaining.set(next, (remaining.get(next) ?? 0) - 1);
      if (remaining.get(next) === 0 && !seen.has(next)) {
        seen.add(next);
        order.push(next);
      }
    }
  }
  let nextCol = Math.max(-1, ...[...col.values()]) + 1;
  for (const n of nodes) {
    if (!col.has(n.id)) col.set(n.id, nextCol++);
  }
  const rowInCol = new Map<number, number>();
  const pos = new Map<string, { col: number; row: number }>();
  for (const n of nodes) {
    const c = col.get(n.id)!;
    const row = rowInCol.get(c) ?? 0;
    rowInCol.set(c, row + 1);
    pos.set(n.id, { col: c, row });
  }
  return pos;
}

function MermaidDiagramBlock({ block }: { block: Extract<MessageBlock, { type: "mermaid" }> }) {
  const arrowId = useId();
  const pos = layoutMermaid(block.nodes, block.edges);
  const maxCol = Math.max(0, ...[...pos.values()].map((p) => p.col));
  const rowsByCol = new Map<number, number>();
  for (const p of pos.values()) rowsByCol.set(p.col, Math.max(rowsByCol.get(p.col) ?? 0, p.row + 1));
  const maxRows = Math.max(1, ...[...rowsByCol.values()]);
  const width = (maxCol + 1) * MERMAID_NODE_W + maxCol * MERMAID_COL_GAP + 16;
  const height = maxRows * MERMAID_NODE_H + (maxRows - 1) * MERMAID_ROW_GAP + 16;

  const centerOf = (id: string): { x: number; y: number } => {
    const p = pos.get(id)!;
    const colRows = rowsByCol.get(p.col) ?? 1;
    const colHeight = colRows * MERMAID_NODE_H + (colRows - 1) * MERMAID_ROW_GAP;
    const yOffset = (height - colHeight) / 2;
    return {
      x: 8 + p.col * (MERMAID_NODE_W + MERMAID_COL_GAP),
      y: yOffset + p.row * (MERMAID_NODE_H + MERMAID_ROW_GAP),
    };
  };

  return (
    <div className={styles.mermaidWrap}>
      <svg viewBox={`0 0 ${width} ${height}`} className={styles.mermaidSvg} role="img" aria-label="diagram">
        <defs>
          <marker id={arrowId} markerWidth={8} markerHeight={8} refX={7} refY={4} orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" className={styles.mermaidArrowHead} />
          </marker>
        </defs>
        {block.edges.map((e, i) => {
          if (!pos.has(e.from) || !pos.has(e.to)) return null;
          const from = centerOf(e.from);
          const to = centerOf(e.to);
          const x1 = from.x + MERMAID_NODE_W;
          const y1 = from.y + MERMAID_NODE_H / 2;
          const x2 = to.x;
          const y2 = to.y + MERMAID_NODE_H / 2;
          const midX = (x1 + x2) / 2;
          return (
            <g key={i}>
              <path
                d={`M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`}
                className={styles.mermaidEdge}
                markerEnd={`url(#${arrowId})`}
              />
              {e.label ? (
                <text x={midX} y={(y1 + y2) / 2 - 4} textAnchor="middle" className={styles.mermaidEdgeLabel}>
                  {e.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {block.nodes.map((n) => {
          const { x, y } = centerOf(n.id);
          return (
            <g key={n.id}>
              {n.shape === "diamond" ? (
                <polygon
                  points={`${x + MERMAID_NODE_W / 2},${y} ${x + MERMAID_NODE_W},${y + MERMAID_NODE_H / 2} ${x + MERMAID_NODE_W / 2},${y + MERMAID_NODE_H} ${x},${y + MERMAID_NODE_H / 2}`}
                  className={styles.mermaidNode}
                />
              ) : (
                <rect
                  x={x}
                  y={y}
                  width={MERMAID_NODE_W}
                  height={MERMAID_NODE_H}
                  rx={n.shape === "round" ? MERMAID_NODE_H / 2 : 4}
                  className={styles.mermaidNode}
                />
              )}
              <text x={x + MERMAID_NODE_W / 2} y={y + MERMAID_NODE_H / 2} textAnchor="middle" dy="0.32em" className={styles.mermaidNodeLabel}>
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// F17 (W19): a ```diff fence (an artifact preview's diff snapshot, or any
// agent-message code fence tagged "diff") colors +/- lines the same way
// ToolDetailCard's inline DiffPreview does — the +++/--- file-header lines
// stay uncolored (mirrors countDiffLines' own header-line exclusion).
// Exported (FILEBROWSER-T7) so FileViewer's plain-<pre> fallback (Shiki still
// loading its language chunk, or an extension with no mapped grammar) reuses
// this SAME renderer instead of a second lookalike code block.
export function DiffCodeBlock({ text }: { text: string }) {
  return (
    <div className={styles.codeWrap}>
      <div className={styles.codeLang}>diff</div>
      <pre className={styles.code0}>
        {text.split("\n").map((line, i) => {
          const cls =
            line.startsWith("+++") || line.startsWith("---")
              ? undefined
              : line.startsWith("+")
                ? styles.diffAdd
                : line.startsWith("-")
                  ? styles.diffDel
                  : undefined;
          return (
            <div key={i} className={cls}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

export function CodeBlock({ block }: { block: Extract<MessageBlock, { type: "code" }> }) {
  if (block.lang === "diff") return <DiffCodeBlock text={block.text} />;
  // EXCALIDRAW-DIAGRAMS — a ```excalidraw fence whose body FAILED structural
  // validation arrives here as a code block tagged "excalidraw" (the parser's
  // degrade path). Show the raw JSON plus a one-line note so the reader knows
  // why it didn't draw — never a crashed transcript.
  const invalidExcalidraw = block.lang === "excalidraw";
  return (
    <div className={styles.codeWrap}>
      {block.lang ? <div className={styles.codeLang}>{block.lang}</div> : null}
      <pre className={styles.code0}>{block.text}</pre>
      {invalidExcalidraw ? <div className={styles.excalidrawInvalid}>invalid excalidraw scene</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// F21 (W23) — the 12 output components. Every list caps at ~14 visible rows
// (internal scroll beyond that, the F21 width/scroll rule) and stays inside
// the ~580px message-width cap via styles.component's max-width. Token colors
// only (CI hex guard) — ok/done/add → --success, warn/flag/modify → --warn,
// fail/delete → --danger, everything else → --muted/--faint.
// ---------------------------------------------------------------------------

const MAX_VISIBLE_ROWS = 14;
const scrollCls = (n: number): string => (n > MAX_VISIBLE_ROWS ? ` ${styles.scroll}` : "");

const STATUS_GLYPH: Record<StatusTone, string> = { ok: "✓", warn: "⚠", fail: "✗" };
const STATUS_TONE_CLASS: Record<StatusTone, string> = { ok: styles.toneOk!, warn: styles.toneWarn!, fail: styles.toneFail! };

function StatusBlock({ block }: { block: Extract<MessageBlock, { type: "status" }> }) {
  return (
    <div className={`${styles.component}${scrollCls(block.items.length)}`}>
      {block.items.map((it, i) => (
        <div key={i} className={styles.statusRow}>
          <span className={STATUS_TONE_CLASS[it.tone]}>{STATUS_GLYPH[it.tone]}</span>
          <span>{it.name}</span>
          {it.meta ? <span className={styles.dim}>· {it.meta}</span> : null}
        </div>
      ))}
    </div>
  );
}

const CHECKLIST_GLYPH: Record<ChecklistTone, string> = { done: "●", pending: "○", flagged: "⚠" };
const CHECKLIST_TONE_CLASS: Record<ChecklistTone, string> = {
  done: styles.toneOk!,
  pending: styles.faint!,
  flagged: styles.toneWarn!,
};

function ChecklistBlock({ block }: { block: Extract<MessageBlock, { type: "checklist" }> }) {
  const done = block.items.filter((it) => it.tone === "done").length;
  return (
    <div className={`${styles.component}${scrollCls(block.items.length)}`}>
      <div className={styles.checklistHeader}>
        {done}/{block.items.length}
      </div>
      {block.items.map((it, i) => (
        <div key={i} className={styles.statusRow}>
          <span className={CHECKLIST_TONE_CLASS[it.tone]}>{CHECKLIST_GLYPH[it.tone]}</span>
          <span className={it.tone === "done" ? styles.checklistDone : undefined}>{it.text}</span>
          {it.note ? <span className={styles.dim}>— {it.note}</span> : null}
        </div>
      ))}
    </div>
  );
}

function KvBlock({ block }: { block: Extract<MessageBlock, { type: "kv" }> }) {
  return (
    <div className={`${styles.kv}${scrollCls(block.items.length)}`}>
      {block.items.map((it, i) => (
        <div key={i} className={styles.kvRow}>
          <span className={styles.kvKey}>{it.key}</span>
          <span className={styles.kvValue}>{it.value}</span>
        </div>
      ))}
    </div>
  );
}

function DiffstatBlock({ block }: { block: Extract<MessageBlock, { type: "diffstat" }> }) {
  const plus = block.rows.reduce((s, r) => s + r.plus, 0);
  const minus = block.rows.reduce((s, r) => s + r.minus, 0);
  return (
    <div className={`${styles.component}${scrollCls(block.rows.length)}`}>
      {block.rows.map((r, i) => (
        <div key={i} className={styles.statusRow}>
          <span className={styles.diffstatPath}>{r.path}</span>
          <span className={styles.diffAdd}>+{r.plus}</span>
          <span className={styles.diffDel}>−{r.minus}</span>
        </div>
      ))}
      <div className={styles.diffstatFooter}>
        <span className={styles.diffAdd}>+{plus}</span> <span className={styles.diffDel}>−{minus}</span>
      </div>
    </div>
  );
}

function TimelineBlock({ block }: { block: Extract<MessageBlock, { type: "timeline" }> }) {
  return (
    <div className={`${styles.component}${scrollCls(block.items.length)}`}>
      {block.items.map((it, i) => (
        <div key={i} className={styles.statusRow}>
          <span className={styles.timelineTime}>{it.time}</span>
          <span>{it.event}</span>
        </div>
      ))}
    </div>
  );
}

const TREE_BADGE_CLASS: Record<TreeBadge, string> = { A: styles.toneOk!, M: styles.toneWarn!, D: styles.toneFail! };

function TreeBlock({ block }: { block: Extract<MessageBlock, { type: "tree" }> }) {
  return (
    <div className={`${styles.component} ${styles.mono}${scrollCls(block.entries.length)}`}>
      {block.entries.map((e, i) => (
        <div key={i} className={styles.treeRow} style={{ paddingLeft: `${e.depth * 14}px` }}>
          <span>{e.name}</span>
          {e.badge ? <span className={TREE_BADGE_CLASS[e.badge]}> {e.badge}</span> : null}
        </div>
      ))}
    </div>
  );
}

// `links` (F21 → F17): an artifact-labeled link deep-links to the in-app
// preview via onLinkClick (resolved by the caller against the agent's
// artifact list — MessageBody itself stays artifact-agnostic); an
// unresolvable label (onLinkClick a no-op for it, or omitted entirely) just
// renders as plain text, same row shape either way.
function LinksBlock({
  block,
  onLinkClick,
}: {
  block: Extract<MessageBlock, { type: "links" }>;
  onLinkClick?: (label: string, kind: string) => void;
}) {
  return (
    <div className={`${styles.component}${scrollCls(block.items.length)}`}>
      {block.items.map((it, i) =>
        onLinkClick ? (
          <button key={i} type="button" className={styles.linkRow} onClick={() => onLinkClick(it.label, it.kind)}>
            <span className={styles.link}>{it.label}</span> <span className={styles.dim}>({it.kind})</span>
          </button>
        ) : (
          <div key={i} className={styles.linkRow}>
            <span>{it.label}</span> <span className={styles.dim}>({it.kind})</span>
          </div>
        ),
      )}
    </div>
  );
}

function ProgressBlock({ block }: { block: Extract<MessageBlock, { type: "progress" }> }) {
  return (
    <div className={`${styles.component}${scrollCls(block.items.length)}`}>
      {block.items.map((it, i) => (
        <div key={i} className={styles.progressRow}>
          <span className={styles.progressTrack}>
            <span className={styles.progressBar} style={{ width: `${Math.min(100, Math.max(0, it.pct))}%` }} />
          </span>
          <span className={styles.progressPct}>{it.pct}%</span>
          {it.step ? <span className={styles.dim}>· step {it.step}</span> : null}
          {it.eta ? <span className={styles.dim}>· eta {it.eta}</span> : null}
        </div>
      ))}
    </div>
  );
}

const CALLOUT_CLASS: Record<string, string> = {
  info: styles.calloutInfo!,
  success: styles.calloutSuccess!,
  warn: styles.calloutWarn!,
  error: styles.calloutError!,
};
const CALLOUT_GLYPH: Record<string, string> = { info: "◆", success: "✓", warn: "⚠", error: "✗" };

function CalloutBlock({ block }: { block: Extract<MessageBlock, { type: "callout" }> }) {
  return (
    <div className={`${styles.callout} ${CALLOUT_CLASS[block.tone]}`}>
      <span className={styles.calloutGlyph}>{CALLOUT_GLYPH[block.tone]}</span>
      <span>{block.text}</span>
    </div>
  );
}

function MetricBlock({ block }: { block: Extract<MessageBlock, { type: "metric" }> }) {
  return (
    <div className={styles.metricGrid}>
      {block.items.map((it, i) => (
        <div key={i} className={styles.metricCard}>
          <div className={styles.metricLabel}>{it.label}</div>
          <div className={styles.metricValue}>{it.value}</div>
          {it.delta !== undefined ? (
            <div className={it.good === undefined ? styles.dim : it.good ? styles.toneOk : styles.toneFail}>
              {it.dir === "down" ? "▼" : it.dir === "up" ? "▲" : ""} {it.delta}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TestReportBlock({ block }: { block: Extract<MessageBlock, { type: "test-report" }> }) {
  const { pass, fail, skip, duration, failures } = block.report;
  const total = Math.max(1, pass + fail + skip);
  return (
    <div className={styles.component}>
      <div className={styles.testReportSummary}>
        <span className={styles.toneOk}>{pass} pass</span>
        <span className={styles.toneFail}>{fail} fail</span>
        <span className={styles.dim}>{skip} skip</span>
        <span className={styles.dim}>· {duration}</span>
      </div>
      <div className={styles.testReportBar}>
        <span className={styles.testReportPass} style={{ width: `${(pass / total) * 100}%` }} />
        <span className={styles.testReportFail} style={{ width: `${(fail / total) * 100}%` }} />
        <span className={styles.testReportSkip} style={{ width: `${(skip / total) * 100}%` }} />
      </div>
      {failures.length > 0 ? (
        <div className={`${styles.testReportFailures}${scrollCls(failures.length)}`}>
          {failures.map((f, i) => (
            <div key={i} className={styles.statusRow}>
              <span className={styles.toneFail}>✗</span>
              <span>{f.name}</span>
              {f.note ? <span className={styles.dim}>— {f.note}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CompareBlock({ block }: { block: Extract<MessageBlock, { type: "compare" }> }) {
  const { options, criteria, pick, reason } = block.compare;
  return (
    <div className={styles.compareWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th />
            {options.map((o, i) => (
              <th key={i}>
                {o}
                {o === pick ? <span className={styles.pickBadge}> ★ pick</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {criteria.map((c, i) => (
            <tr key={i}>
              <td className={styles.tdKey}>{c.name}</td>
              {c.values.map((v, j) => (
                <td key={j} className={options[j] === pick ? styles.comparePickCell : undefined}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {reason ? <div className={styles.compareReason}>{reason}</div> : null}
    </div>
  );
}

// UI-QUOTE-COLLAPSE — a quoted block long enough to dominate the transcript
// (either dimension) collapses to a short preview by default; short quotes
// are unaffected (isLong is false, `shown` is just `text` verbatim).
const QUOTE_COLLAPSE_MAX_LINES = 3;
const QUOTE_COLLAPSE_MAX_CHARS = 200;

function isLongQuoteText(text: string): boolean {
  return text.length > QUOTE_COLLAPSE_MAX_CHARS || text.split("\n").length > QUOTE_COLLAPSE_MAX_LINES;
}

function collapseQuoteText(text: string): string {
  const preview = text.split("\n").slice(0, QUOTE_COLLAPSE_MAX_LINES).join("\n");
  return preview.length > QUOTE_COLLAPSE_MAX_CHARS ? `${preview.slice(0, QUOTE_COLLAPSE_MAX_CHARS)}…` : `${preview}…`;
}

// F22 (W24) — a quote-reply's excerpt block: left-rule (mirrors the mock's
// user-message gutter treatment), a header row when `ref` parsed (chip + kind
// + ts, the whole header is a backlink that routes to the source agent —
// there is no scroll-to-turn API today, same limitation the F16 workflow-step
// "jump" already documents, so this is the closest available "→ source
// turn"), else a plain quoted block with no header (a hand-typed ">" that
// isn't a real quote-reply).
// UI-QUOTE-COLLAPSE: a long excerpt (either the wire-bounded embed from
// encodeQuoteBlock, or a long hand-typed blockquote) renders collapsed to a
// few lines with a "show quoted" toggle instead of full-height by default.
// Exported so a SENT quote-reply (a USER transcript turn, which otherwise
// stays plain-text/Paragraphs — see TranscriptPanel.tsx's splitLeadingQuote
// use) renders the SAME excerpt block an assistant message would, instead of
// a second lookalike implementation.
export function QuoteBlock({ block, resolveMention, onMentionClick }: {
  block: Extract<MessageBlock, { type: "quote" }>;
  resolveMention?: ResolveMention;
  onMentionClick?: (agentId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const info = block.ref ? (resolveMention?.(block.ref.mention) ?? null) : null;
  const isLong = isLongQuoteText(block.text);
  const shown = expanded || !isLong ? block.text : collapseQuoteText(block.text);
  const backlink = info && onMentionClick ? () => onMentionClick(info.agentId) : undefined;
  return (
    <div className={styles.quoteWrap}>
      {block.ref ? (
        <div
          className={`${styles.quoteHeader}${backlink ? ` ${styles.quoteHeaderLink}` : ""}`}
          role={backlink ? "button" : undefined}
          tabIndex={-1}
          onClick={backlink}
        >
          <span className={styles.quoteChevron}>↳</span>
          {info ? (
            <MentionChip name={block.ref.mention} info={info} onClick={onMentionClick} />
          ) : (
            <span>@{block.ref.mention}</span>
          )}
          <span className={styles.dim}>{block.ref.kind} · {block.ref.ts}{backlink ? " · click → source turn" : ""}</span>
        </div>
      ) : null}
      <div className={styles.quoteText}>{shown}</div>
      {isLong ? (
        <button type="button" className={styles.quoteToggle} onClick={() => setExpanded((e) => !e)}>
          {expanded ? "show less" : "show quoted"}
        </button>
      ) : null}
    </div>
  );
}

function BlockView({ block, onLinkClick, resolveMention, onMentionClick }: {
  block: MessageBlock;
  onLinkClick?: (label: string, kind: string) => void;
  resolveMention?: ResolveMention;
  onMentionClick?: (agentId: string) => void;
}): ReactNode {
  switch (block.type) {
    case "paragraph":
      return <div className={styles.para}><Inline spans={block.spans} resolveMention={resolveMention} onMentionClick={onMentionClick} /></div>;
    case "heading": {
      // Rendered as a real <h1>-<h6>, not a styled div: the level is semantic
      // (screen readers, in-page outline), so throwing it away and keeping only
      // the font size would lose the one thing the markdown actually said.
      const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return (
        <Tag className={[styles.heading, styles[`h${block.level}`]].join(" ")}>
          <Inline spans={block.spans} resolveMention={resolveMention} onMentionClick={onMentionClick} />
        </Tag>
      );
    }
    case "list":
      return (
        <ul className={styles.list}>
          {block.items.map((item, i) => (
            <li key={i}><Inline spans={item} resolveMention={resolveMention} onMentionClick={onMentionClick} /></li>
          ))}
        </ul>
      );
    case "quote":
      return <QuoteBlock block={block} resolveMention={resolveMention} onMentionClick={onMentionClick} />;
    case "code":
      return <CodeBlock block={block} />;
    case "table":
      return <TableBlock block={block} resolveMention={resolveMention} onMentionClick={onMentionClick} />;
    case "chart":
      return "series" in block
        ? <SeriesChart chartType={block.chartType} labels={block.labels} series={block.series} unit={block.unit} title={block.title} />
        : <ChartBlock block={block} />;
    case "mermaid":
      return <MermaidDiagramBlock block={block} />;
    case "excalidraw":
      return <ExcalidrawBlock scene={block.scene} elementCount={block.elementCount} />;
    case "status":
      return <StatusBlock block={block} />;
    case "checklist":
      return <ChecklistBlock block={block} />;
    case "kv":
      return <KvBlock block={block} />;
    case "diffstat":
      return <DiffstatBlock block={block} />;
    case "timeline":
      return <TimelineBlock block={block} />;
    case "tree":
      return <TreeBlock block={block} />;
    case "links":
      return <LinksBlock block={block} onLinkClick={onLinkClick} />;
    case "progress":
      return <ProgressBlock block={block} />;
    case "callout":
      return <CalloutBlock block={block} />;
    case "insight":
      return (
        <aside className={styles.insight}>
          <div className={styles.insightTitle}>{block.title}</div>
          <div className={styles.insightBody}>
            {block.blocks.map((b, i) => (
              <BlockView key={i} block={b} onLinkClick={onLinkClick} resolveMention={resolveMention} onMentionClick={onMentionClick} />
            ))}
          </div>
        </aside>
      );
    case "metric":
      return <MetricBlock block={block} />;
    case "test-report":
      return <TestReportBlock block={block} />;
    case "compare":
      return <CompareBlock block={block} />;
    case "raw":
      // The still-streaming tail. A still-open chart/mermaid/component fence
      // shows a dim placeholder instead of raw JSON/lines (v7/F21); every
      // other block keeps showing raw lines — the no-flicker guarantee: this
      // is the ONLY block that changes across deltas.
      if (block.streamingKind) {
        const label =
          block.streamingKind === "chart"
            ? "chart"
            : block.streamingKind === "mermaid" || block.streamingKind === "excalidraw"
              ? "diagram"
              : block.streamingKind;
        return <div className={styles.streamingPlaceholder}>{label} streaming…</div>;
      }
      return <div className={styles.raw}>{block.text}</div>;
  }
  // EXHAUSTIVE-BLOCK-SWITCH: `ReactNode` admits `undefined`, so before this a
  // MessageBlock variant nobody added a case for type-checked cleanly and
  // rendered NOTHING — silently dropping the block instead of degrading. This
  // makes the next unhandled variant a compile error at the point it is added.
  const unhandled: never = block;
  return <div className={styles.raw}>{JSON.stringify(unhandled)}</div>;
}

const isRichBlock = (b: MessageBlock): boolean =>
  b.type === "table" ||
  b.type === "code" ||
  b.type === "list" ||
  b.type === "chart" ||
  b.type === "mermaid" ||
  b.type === "excalidraw" ||
  b.type === "status" ||
  b.type === "checklist" ||
  b.type === "kv" ||
  b.type === "diffstat" ||
  b.type === "timeline" ||
  b.type === "tree" ||
  b.type === "links" ||
  b.type === "progress" ||
  b.type === "callout" ||
  b.type === "metric" ||
  b.type === "test-report" ||
  b.type === "compare" ||
  b.type === "quote";

export function MessageBody({
  text,
  done,
  rawView,
  className,
  onLinkClick,
  resolveMention,
  onMentionClick,
}: {
  text: string;
  done: boolean;
  rawView: boolean;
  // F21 (W23): resolves a `links` block's label against the caller's own
  // artifact scope and opens the F17 preview — kept out of this pure renderer
  // so it stays artifact-agnostic (TranscriptPanel supplies it).
  onLinkClick?: (label: string, kind: string) => void;
  // F22 (W24): resolves an @mention / quote-ref's bare name against known
  // agents (null ⇒ plain text) and routes a chip click — same artifact-
  // agnostic split as onLinkClick, TranscriptPanel supplies both.
  resolveMention?: ResolveMention;
  onMentionClick?: (agentId: string) => void;
  className?: string;
}) {
  const blocks = parseMessageBlocks(text, done);
  const rich = blocks.some(isRichBlock);

  // Raw view (per-message `v` toggle): show the verbatim markdown source. The
  // DOM text now equals the source, so a selection copy here is trivially raw.
  if (rawView) {
    return (
      <div className={className}>
        <pre className={styles.rawFull}>{text}</pre>
        <div className={styles.hint}>raw markdown · v formatted view · copy = raw markdown</div>
      </div>
    );
  }

  return (
    <div className={className}>
      {blocks.map((block, i) => (
        // key = block index: closed blocks keep their index+content across the
        // stream, so React never remounts/reflows them (F12 no-flicker rule).
        <BlockView key={i} block={block} onLinkClick={onLinkClick} resolveMention={resolveMention} onMentionClick={onMentionClick} />
      ))}
      {rich ? (
        <div className={styles.hint}>md auto-format: tables · code · lists · charts · diagrams · components · v raw view · copy = raw markdown</div>
      ) : null}
    </div>
  );
}
