import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { AgentView, TranscriptItem, UiState } from "@chimera/ui-state";
import type { NormalizedEvent } from "@chimera/protocol";
import { displayChord, isEditableTarget, registerActionHandler, runAction } from "../keymap";
import { openArtifactSnapshot, openArtifactUrl, rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { agentCommands, composerLocal, nextToolDetail, useComposerLocal, type QuoteSlot } from "../state/commands.agents";
import { artifactsLocal, useArtifacts } from "../state/commands.artifacts";
import { isPreviewableKind, type ArtifactRow } from "../state/selectors.artifacts";
import { copiedNotice, installCopyOnSelect, selectionMsgKey, writeClipboard } from "../state/copyOnSelect";
import { isOpenableLinkUrl } from "./linkUrl";
import { msgKey, richView, useRawView } from "../state/richMessages";
import {
  agentMentions,
  agentName,
  displayName,
  derivedState,
  stateVisual,
  fmtClock,
  groupTranscriptBlocks,
  isNearBottom,
  isNearTop,
  mergeEchoTimestamps,
  scrollHintCounts,
  spawnLineageMap,
  summarizeToolRun,
  toolRunTurns,
  transcriptTimestamps,
  type MentionInfo,
  type ScrollHint,
  type SpawnLineageEntry,
  type TranscriptBlock,
} from "../state/selectors";
import { ImageChip } from "./ImageChip";
import { Markdown } from "./Markdown";
import { MentionChip, MessageBody, QuoteBlock, type ResolveMention } from "./MessageBody";
import { ToolDetailCard } from "./ToolDetailCard";
import { splitLeadingQuote } from "@chimera/ui-state";
import { errorText } from "../state/errorText";
import { signalHeadline } from "../state/selectors.hooks";
import styles from "./TranscriptPanel.module.css";

// WORKFLOW-UI-3 — extracted from TranscriptPanel so the SAME Block renderer
// (tool strips, mod+e detail, images, @mentions, spawn-lineage, thinking/
// StreamGlow, deliverTo) drives both the single-agent transcript AND every
// step section of StitchedTranscriptPanel's workflow body. A caller renders
// ONE <TranscriptSegment> per agent it needs blocks for — normal mode mounts
// exactly one; a multi-agent workflow mounts one per step section — so every
// per-agent hook below (tsList, lineageMap, artifacts/mentions, tool-detail)
// runs as its OWN hook call, never inside a loop.

// Per-block intrinsic-size estimate for `content-visibility: auto` — see
// TranscriptPanel's original note (native virtualization, no JS window math).
export const EST_BLOCK_H = 48;

/** The transcript-window key for a block: identical to its React render key,
 * and the value stamped as data-bkey so measurement and the height cache agree.
 *
 * TRANSCRIPT-SCROLL-JUMP: keyed by a per-segment ORIGIN offset applied to the
 * block's forward array index — NEITHER a bare forward index NOR distance-
 * from-tail (TRANSCRIPT-TAIL-FIRST's scheme, merge b9cdeb72). That scheme
 * (`total - 1 - index`) is invariant under a head-prepend but NOT under a
 * tail append: appending one item grows `total` by 1, so `total-1-index`
 * changes for every PRE-EXISTING block the instant new output starts
 * streaming — React sees every block's key change at once and unmounts/
 * remounts the whole pane, losing both the native CSS scroll-anchor (needs
 * the SAME DOM node to stay put) and the content-visibility height cache
 * (TranscriptPanel.module.css's `.bodyInner > [data-block]` comment). Forward
 * index alone has the mirror-image problem (stable under append, broken
 * under prepend) — the two positional schemes are mutually exclusive.
 *
 * `origin` (tracked across renders by useBlockKeyOrigin/nextBlockKeyOrigin
 * below) is what makes `index + origin` invariant under BOTH: an append or
 * an in-place mutation (a streaming delta, a tool status flip) never shifts
 * any existing item's index, so origin stays put; a prepend of K items shifts
 * every existing index up by K, so origin moves down by K to exactly cancel
 * it. Only genuinely new blocks get a value nothing else has used. */
export function blockKeyOf(block: TranscriptBlock, origin: number): string {
  return block.kind === "tools" ? `t${block.startIndex + origin}` : `s${block.index + origin}`;
}

/** Pure step function behind useBlockKeyOrigin — given the previous render's
 * `items` array + the origin that was correct for it, and this render's
 * `items` array, returns the origin that keeps blockKeyOf's keys unchanged
 * for every item present in both. Exported standalone (no React) so the
 * append/prepend arithmetic is unit-testable without mounting anything.
 * Relies on ELEMENT reference stability, not array reference stability — the
 * reducer shallow-copies `transcript` on every dispatch (so the outer array
 * is a new object almost every render) but only ever replaces the specific
 * element(s) it actually mutates, so unrelated items keep their identity. */
export function nextBlockKeyOrigin(
  prevItems: readonly TranscriptItem[],
  prevOrigin: number,
  items: readonly TranscriptItem[],
): number {
  if (items === prevItems) return prevOrigin;
  // Same slot count: at most an in-place mutation (streaming delta, tool
  // status flip) — possibly even at index 0 — never a prepend (which always
  // grows length), so no existing index moved. Checked BEFORE the items[0]
  // comparison below so a mutated FIRST item isn't mistaken for a prepend.
  if (items.length === prevItems.length) return prevOrigin;
  if (prevItems.length === 0 || items.length < prevItems.length) return 0; // fresh mount / agent switch / shrink
  if (items[0] === prevItems[0]) return prevOrigin; // pure growth at the TAIL (append)
  const grown = items.length - prevItems.length;
  return items[grown] === prevItems[0] ? prevOrigin - grown : 0; // a clean head-prepend of `grown` items
}

/** Tracks the running origin across renders — mirrors useTranscriptScroll's
 * own "setState during render when an input changed" idiom further down this
 * file (safe under StrictMode double-invocation: recompute is idempotent
 * given the same (prevItems, prevOrigin, items) triple). */
function useBlockKeyOrigin(items: readonly TranscriptItem[]): number {
  const [tracked, setTracked] = useState<{ items: readonly TranscriptItem[]; origin: number }>(() => ({ items, origin: 0 }));
  if (tracked.items !== items) {
    const origin = nextBlockKeyOrigin(tracked.items, tracked.origin, items);
    setTracked({ items, origin });
    return origin;
  }
  return tracked.origin;
}

function useTick(active: boolean, intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return tick;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

// ELAPSED-TIMER: anchor the live thinking/streaming counters on the agent's
// turn-start ts (AgentView.busySince, epoch ms, event-derived by the ui-state
// reducer) so a transcript opened mid-turn shows TRUE elapsed. Falls back to
// component-mount time ONLY when busySince is absent — a brand-new turn whose
// first event ts hasn't landed yet (e.g. an optimistic local send), where mount
// ≈ turn start, so the fallback is right. The old bug: this anchored on mount
// UNCONDITIONALLY, so opening an agent thinking 30s reset the counter to ~0.
function useElapsedSec(since?: number): number {
  const mountRef = useRef(Date.now());
  const anchor = since ?? mountRef.current;
  return Math.max(0, Math.floor((Date.now() - anchor) / 1000));
}

export function StreamGlow() {
  return (
    <div className={styles.glowTrack} data-stream-glow>
      <div className={styles.glowComet} />
    </div>
  );
}

// F22 (W24) — a spawn-lineage entry rendered inside its OWN tool block.
function SpawnLineageLine({ ownerName, childName, childInfo, excerpt, onClick }: {
  ownerName: string;
  childName: string;
  childInfo: MentionInfo;
  excerpt: string;
  onClick: (agentId: string) => void;
}) {
  return (
    <div className={styles.spawnLine} onClick={(e) => e.stopPropagation()}>
      <span className={styles.spawnGlyph}>◆</span> {ownerName} spawned{" "}
      <MentionChip name={childName} info={childInfo} onClick={onClick} />
      {excerpt ? <span className={styles.faint}> · "{excerpt}"</span> : null}
    </div>
  );
}

function ToolStrip({ block, hint, onOpen, blockKey, spawnLines }: {
  block: Extract<TranscriptBlock, { kind: "tools" }>;
  hint: boolean;
  onOpen: () => void;
  blockKey: string;
  spawnLines: ReadonlyArray<{ ownerName: string; childName: string; childInfo: MentionInfo; excerpt: string; onClick: (agentId: string) => void }>;
}) {
  const segments = summarizeToolRun(block.items);
  const liveProgress = [...block.items].reverse().find(item => item.status === "called" && item.result)?.result;
  // TURN-COST-VISIBLE: shown only when it adds information — a single call is always one turn, and
  // an unreported run says nothing rather than guessing.
  const turns = toolRunTurns(block.items);
  return (
    <div className={styles.toolStrip} data-block data-bkey={blockKey} role="button" tabIndex={-1} onClick={onOpen} title={`${displayChord("mod+e")} detay`}>
      ⚙{" "}
      {segments.map((s, i) => (
        <span key={i}>
          {i > 0 ? " · " : ""}
          {s.name}
          {s.count > 1 ? ` ×${s.count}` : ""}{" "}
          {s.status === "denied" ? (
            <span className={styles.toneDanger}>✗</span>
          ) : s.status === "called" ? (
            <span className={`${styles.toneWarn} ${styles.pulse}`}>◐</span>
          ) : (
            <span className={styles.toneSuccess}>✓</span>
          )}
        </span>
      ))}
      {turns > 0 && block.items.length > 1 ? (
        <span className={turns > 1 ? styles.turnsSplit : styles.turnsBatched} title={
          turns > 1
            ? `${turns} model turns — the whole context was re-read ${turns} times. Independent calls can share one turn.`
            : "one model turn — these calls shared a single context read"
        }>
          {" · "}{turns} turn{turns > 1 ? "s" : ""}
        </span>
      ) : null}
      {hint ? <span className={styles.ghost}> — {displayChord("mod+e")} detay</span> : null}
      {liveProgress ? <span className={styles.faint} data-tool-progress> · {liveProgress.replace(/\s+/g, " ").slice(-180)}</span> : null}
      {spawnLines.map((l, i) => <SpawnLineageLine key={i} {...l} />)}
    </div>
  );
}

function ImageChips({ item }: { item: Extract<TranscriptItem, { role: "user" }> }) {
  if (!item.images || item.images.length === 0) return null;
  return (
    <div className={styles.imageRow}>
      {item.images.map((img, i) => {
        const ext = img.mediaType.split("/")[1] ?? "img";
        return (
          <ImageChip
            key={i}
            image={img}
            name={`image${item.images!.length > 1 ? `-${i + 1}` : ""}.${ext}`}
          />
        );
      })}
    </div>
  );
}

function InlineContent({ item }: { item: Extract<TranscriptItem, { role: "user" }> }) {
  if (!item.content || item.content.length === 0) return null;
  const total = item.content.filter((b) => b.type === "image").length;
  let seen = 0;
  return (
    <>
      <div className={styles.userText}>
        {item.content.map((block, i) => {
          if (block.type === "text") return <span key={i} className={styles.inlineTextSpan}>{block.text}</span>;
          seen += 1;
          const ext = block.mediaType.split("/")[1] ?? "img";
          return (
            <ImageChip
              key={i}
              image={{ mediaType: block.mediaType, data: block.data }}
              name={`image${total > 1 ? `-${seen}` : ""}.${ext}`}
            />
          );
        })}
      </div>
      <div className={styles.inlineContentHint}>images travel inline at their tag positions · click to view full size</div>
    </>
  );
}

// A2A-UX-OVERHAUL · PART 3: a delivered turn's body, COLLAPSED by default — a
// ~2-line / 200-char preview plus a ▸ expand affordance (the same fold idiom as the
// handoff/task-card blocks), full text on expand. A short delivery (within the
// preview) renders in full with no affordance, so nothing changes for it.
//
// DELIVERY-MD-RENDER: the FULL body (a short delivery, or an expanded long one)
// renders through the SAME MessageBody markdown pipeline an assistant turn uses,
// so an agent's markdown report (## / ** / `code` / tables / lists) formats
// identically instead of as flat plain text. Only the COLLAPSED preview stays a
// plain safe teaser — markdown-rendering a mid-cut truncation would shred a table
// or an unterminated code fence. Raw access is preserved: MessageBody honors the
// per-message `v` raw-view toggle (rawView), and mod+y still copies the raw source.
const DELIVERY_PREVIEW_LINES = 2;
const DELIVERY_PREVIEW_CHARS = 200;
function isLongDelivery(text: string): boolean {
  return text.length > DELIVERY_PREVIEW_CHARS || text.split("\n").length > DELIVERY_PREVIEW_LINES;
}
function DeliveredBody({ text, rawView, onLinkClick, resolveMention, onMentionClick }: {
  text: string;
  rawView: boolean;
  onLinkClick: (label: string, kind: string) => void;
  resolveMention: ResolveMention;
  onMentionClick: (agentId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const full = (
    <MessageBody
      text={text}
      done
      rawView={rawView}
      className={styles.userText!}
      onLinkClick={onLinkClick}
      resolveMention={resolveMention}
      onMentionClick={onMentionClick}
    />
  );
  if (!isLongDelivery(text)) return full;
  const previewLines = text.split("\n").slice(0, DELIVERY_PREVIEW_LINES).join("\n");
  const preview = previewLines.length > DELIVERY_PREVIEW_CHARS ? `${previewLines.slice(0, DELIVERY_PREVIEW_CHARS)}…` : previewLines;
  return (
    <>
      {expanded
        ? full
        : <div className={styles.userText}>{preview}</div>}
      <div
        className={styles.handoffToggle}
        role="button"
        tabIndex={-1}
        data-delivery-toggle={expanded ? "open" : "collapsed"}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? "▾ show less" : "▸ show full message"}
      </div>
    </>
  );
}

// SLASH-COMMAND-IN-FLIGHT: name the command while it runs. "thinking…" is right for a model turn
// and wrong for a command — /compact on a large context runs for a minute or more with nothing on
// screen to say what is taking the time, which is indistinguishable from a wedged agent. Reported
// as "I send a slash command and no output comes, it just says thinking".
function ThinkingLine({ canInterrupt, busySince, command }: { canInterrupt: boolean; busySince?: number; command?: string }) {
  const tick = useTick(true, 120);
  const elapsed = useElapsedSec(busySince);
  return (
    <div className={styles.thinking} data-thinking data-thinking-command={command}>
      {SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}{" "}
      {command ? <><span className={styles.faint}>running</span> {command}</> : "thinking…"}{" "}
      <span className={styles.faint}>{elapsed}s{canInterrupt ? " · esc interrupt" : ""}</span>
    </div>
  );
}

function StreamingLine({ canInterrupt, busySince }: { canInterrupt: boolean; busySince?: number }) {
  const tick = useTick(true, 1000);
  void tick;
  const elapsed = useElapsedSec(busySince);
  return (
    <div className={styles.streamingLine}>
      ▌<span className={styles.streamCaret}>▌</span>{" "}
      <span className={styles.ghost}>
        streaming — bottom border flowing · {elapsed}s{canInterrupt ? " · esc interrupt" : ""}
      </span>
    </div>
  );
}

function Block({
  block,
  blockKey,
  agent,
  msgIndex,
  ts,
  isLast,
  firstToolStrip,
  canInterrupt,
  detailOpen,
  onOpenDetail,
  onLinkClick,
  resolveMention,
  resolveMentionById,
  onMentionClick,
  lineage,
  onQuote,
}: {
  block: TranscriptBlock;
  blockKey: string;
  agent: AgentView;
  // The block's index in the agent's FULL (unwindowed) transcript — msgKey/
  // quote resolution needs this ABSOLUTE index, not the block's index within
  // whatever (possibly time-windowed) slice produced it, so two step sections
  // sharing one agentId (single-agent workflow) never collide on the same key.
  msgIndex: number;
  ts: number | undefined;
  isLast: boolean;
  firstToolStrip: boolean;
  canInterrupt: boolean;
  detailOpen: boolean;
  onOpenDetail: (blockStart: number) => void;
  onLinkClick: (label: string, kind: string) => void;
  resolveMention: ResolveMention;
  resolveMentionById: (agentId: string) => { name: string; info: MentionInfo };
  onMentionClick: (agentId: string) => void;
  lineage: Map<number, SpawnLineageEntry>;
  onQuote: (index: number) => void;
}) {
  const mKey = msgKey(agent.agentId, block.kind === "single" ? msgIndex : -1);
  const rawView = useRawView(mKey);
  if (block.kind === "tools") {
    if (detailOpen) {
      return (
        <ToolDetailCard
          items={block.items}
          blockKey={blockKey}
          call={composerLocal.getState().toolDetail?.call ?? 0}
          onSelectCall={(i) => {
            const cur = composerLocal.getState().toolDetail;
            if (cur) composerLocal.set({ toolDetail: { ...cur, call: i } });
          }}
          onClose={() => composerLocal.set({ toolDetail: null })}
        />
      );
    }
    const ownerName = displayName(agent);
    const spawnLines = block.items.flatMap((_, i) => {
      const entry = lineage.get(block.itemIndices?.[i] ?? block.startIndex + i);
      // Workflow names repeat across runs; resolve the exact run, not the last
      // agent that happened to register the same display name.
      const childInfo = entry ? resolveMentionById(entry.childId).info : null;
      if (!entry || !childInfo) return [];
      return [{ ownerName, childName: entry.childName, childInfo, excerpt: entry.excerpt, onClick: onMentionClick }];
    });
    return <ToolStrip block={block} blockKey={blockKey} hint={firstToolStrip} onOpen={() => onOpenDetail(block.startIndex)} spawnLines={spawnLines} />;
  }
  const item = block.item;
  if (item.role === "system") {
    return (
      <div className={styles.system} data-block data-bkey={blockKey}>
        {item.text.startsWith("result:") ? <Markdown text={item.text} /> : item.text}
      </div>
    );
  }
  // BACKGROUND-TASK-VISIBILITY: a script the agent started and walked away from. Rendered inline
  // where it was started, like a tool call, because from the reader's side it answers the same
  // question — "what is this agent doing right now". The row updates in place, so a long-running
  // script stays one line that changes state instead of a growing list of near-identical rows.
  if (item.role === "task") {
    const running = item.status === "running";
    return (
      <div className={`${styles.taskRow} ${running ? styles.taskRunning : ""}`} data-block data-bkey={blockKey} data-task-status={item.status} role="status" aria-live="polite" aria-atomic="true">
        <span className={styles.taskMark} aria-hidden>{running ? "◐" : item.status === "done" ? "✓" : item.status === "killed" ? "◼" : item.status === "ended" ? "–" : "✕"}</span>
        <span className={styles.taskName}>{item.description}</span>
        <span className={styles.taskState}>
          {running ? "running" : item.status === "done" ? "finished" : item.status === "killed" ? "stopped" : item.status === "ended" ? "ended · result unavailable" : "failed"}
        </span>
        {item.error ? <span className={styles.taskError}>{item.error}</span> : null}
      </div>
    );
  }
  if (item.role === "user") {
    const leadingQuote = !item.content?.length ? splitLeadingQuote(item.text) : null;
    // HOOK-6 (PLAN-HOOKS.md §7): a pushed subscription signal is delivered via the
    // same mailbox/delivered-mail path as an agent turn (from === "chimera", text
    // "[signal:<topic>] …"). Mark it with a distinct ⌁ signal tag instead of the
    // sender mention, but reuse the collapsed-delivery body (DeliveredBody) verbatim.
    const isSignal = !!item.from && item.text.startsWith("[signal:");
    // F46.UI: a bare "⌁ signal" over raw JSON left the operator unable to tell WHY the
    // agent woke. The tag now names the topic in plain words and, for an output match,
    // the matched line is surfaced as its own row above the collapsed body.
    const headline = isSignal ? signalHeadline(item.text) : null;
    return (
      <div
        className={styles.messageUser}
        // OWN-TURN-VISIBILITY: `from` is the discriminator — absent means YOU sent it, present means
        // it was delivered here from another agent (or is a pushed signal). Only the former earns
        // the tinted band; see .messageUser[data-own] in the stylesheet.
        data-own={!item.from || undefined}
        data-block data-bkey={blockKey} data-msg-key={mKey} data-ts={ts} data-seq={item.seq}
      >
        <div className={styles.gutterUser} />
        <div className={styles.messageBody}>
          <div className={styles.headUser}>
            {/* A2A-UX-OVERHAUL · PART 3: a DELIVERED turn's source is a clickable
                "@name" mention (the sender's display name) that navigates to that
                agent's transcript — the same selectAgent the agent list uses. The
                human's own turn keeps the plain "you". */}
            {isSignal ? (
              <span className={styles.signalTag} data-signal-tag title={headline ? `signal:${headline.topic}` : undefined}>
                {headline ? `⌁ signal · ${headline.label}` : "⌁ signal"}
              </span>
            ) : item.from ? (() => { const m = resolveMentionById(item.from); return <MentionChip name={m.name} info={m.info} onClick={onMentionClick} />; })() : "you"}
            {/* FORCE-SEND-MIDTURN: this turn bypassed the busy-hold outbox (opt+enter
                while the target was mid-turn) — tagged distinctly from a queued-then-
                flushed send, which carries no such marker. */}
            {item.forced ? <span className={styles.forcedTag} data-forced-tag title="sent immediately — bypassed the busy queue">⚡ forced</span> : null}
            <span className={styles.spacer} />
            {ts !== undefined && <span className={styles.ts}>{fmtClock(ts)}</span>}
          </div>
          {headline?.detail ? (
            <div className={styles.signalMatch} data-signal-match>{headline.detail}</div>
          ) : null}
          {item.content && item.content.length > 0 ? (
            <InlineContent item={item} />
          ) : item.from ? (
            // A2A-UX-OVERHAUL · PART 3: a delivered body renders COLLAPSED by default
            // (first ~2 lines + a ▸ expand affordance, the app's handoff/task-card
            // fold idiom); full text on expand.
            <>
              <DeliveredBody
                text={item.text}
                rawView={rawView}
                onLinkClick={onLinkClick}
                resolveMention={resolveMention}
                onMentionClick={onMentionClick}
              />
              <ImageChips item={item} />
            </>
          ) : leadingQuote ? (
            <>
              <QuoteBlock block={leadingQuote.quote} resolveMention={resolveMention} onMentionClick={onMentionClick} />
              {leadingQuote.rest ? (
                <MessageBody
                text={leadingQuote.rest}
                done
                rawView={rawView}
                className={styles.userText!}
                onLinkClick={onLinkClick}
                resolveMention={resolveMention}
                onMentionClick={onMentionClick}
              />
              ) : null}
              <ImageChips item={item} />
            </>
          ) : (
            <>
              {/* OWN-TURN-MARKDOWN: your own turn renders through the SAME pipeline as an agent's
                  and as delivered mail (DELIVERY-MD-RENDER above) — it was the last plain-text path
                  left, so a `backtick`, a list or a heading you typed came back unformatted while
                  the identical text from anyone else formatted fine. `done` because a turn you have
                  already sent is complete by definition. */}
              <MessageBody
                text={item.text}
                done
                rawView={rawView}
                className={styles.userText!}
                onLinkClick={onLinkClick}
                resolveMention={resolveMention}
                onMentionClick={onMentionClick}
              />
              <ImageChips item={item} />
            </>
          )}
        </div>
      </div>
    );
  }
  const streamingTail = isLast && item.streaming && agent.busy;
  return (
    <div className={styles.messageAssistant} data-block data-bkey={blockKey} data-msg-key={mKey} data-ts={ts} data-seq={item.seq}>
      <div className={styles.gutterAssistant} />
      <div className={styles.messageBody}>
        <div className={styles.headAssistant}>
          {displayName(agent)}
          <span className={styles.spacer} />
          {block.kind === "single" ? (
            <button
              type="button"
              className={styles.quoteAffordance}
              title="quote this turn (q)"
              onClick={() => onQuote(msgIndex)}
            >
              ↳
            </button>
          ) : null}
          {ts !== undefined && <span className={styles.ts}>{fmtClock(ts)}</span>}
        </div>
        <MessageBody
          text={item.text}
          done={!item.streaming}
          rawView={rawView}
          className={styles.assistantText!}
          onLinkClick={onLinkClick}
          resolveMention={resolveMention}
          onMentionClick={onMentionClick}
        />
        {streamingTail ? <StreamingLine canInterrupt={canInterrupt} busySince={agent.busySince} /> : null}
      </div>
    </div>
  );
}

/** A contiguous-or-not slice of `agent`'s transcript by derived timestamp —
 * mirrors the retired StepTranscript's `sliced` filter (an item with no
 * derivable ts is KEPT rather than dropped: boundary fuzziness is a display
 * nicety, never data loss). `endedAt: null` means "still open" (the live step). */
export type TranscriptWindow = { startedAt: number; endedAt: number | null };

/** Renders ONE agent's transcript (optionally time-windowed) through the
 * real Block pipeline. Every per-agent derived structure below (tsList,
 * lineageMap, artifacts/mentions, tool-detail) is this component's OWN hook
 * call — a multi-agent workflow body mounts one TranscriptSegment per step
 * section instead of loop-calling these hooks itself. */
export function TranscriptSegment({
  agent,
  timeWindow,
  events,
  canInterrupt,
  isLive,
  segmentKey,
  onRegisterTranscript,
  onQuote,
  renderEmpty,
}: {
  agent: AgentView;
  /** Time-window this segment's blocks to one step's [startedAt,endedAt] —
   * omitted renders the agent's whole transcript (normal single-agent mode). */
  timeWindow?: TranscriptWindow;
  /** Override the correlation event stream (StitchedTranscriptPanel's
   * backfilled agent.tail cache) — omitted reads the live event ring. */
  events?: readonly NormalizedEvent[];
  canInterrupt: boolean;
  /** Gates the mod+e tool-detail hotkey + the thinking/StreamGlow line to
   * the CURRENT live step — a click-to-open tool strip still works on any
   * (including historical) segment regardless of this flag. */
  isLive: boolean;
  /** Tool-detail/quote identity — defaults to agent.agentId. Multi-section
   * single-agent workflows pass a per-section key so two sections sharing one
   * agentId never collide on the same open-tool-detail slot. */
  segmentKey?: string;
  onRegisterTranscript?: (agentId: string, transcript: readonly TranscriptItem[]) => void;
  onQuote?: (agentId: string, absIndex: number) => void;
  /** A section with no items in its time window — task mode passes StepEmpty's
   * "loading…"/"no messages in this step" placeholder, single-agent mode passes
   * TranscriptPanel's own TranscriptEmptyBody (TRANSCRIPT-LOADING-STATE:
   * skeleton/empty/failed). Optional/omitted renders nothing — a defensive
   * default, since both of TranscriptPanel's own call sites currently pass one. */
  renderEmpty?: () => ReactNode;
}) {
  const agentKey = agent.agentId;
  const detailKey = segmentKey ?? agentKey;

  const liveEvents = useStore((s: UiState) => s.events);
  const evList = events ?? liveEvents;

  const commands = useMemo(() => agentCommands(appStore, rpcCall), []);
  const fullTsList = useMemo(
    () => mergeEchoTimestamps(transcriptTimestamps(evList, agent.transcript, agentKey), agent.transcript, commands.echoTimestamps(agentKey)),
    [evList, agent, agentKey, commands],
  );

  // Window filter — `origIndex[i]` is the FULL-transcript index that local
  // position `i` (in `items`/`tsList`/`blocks`) came from, the bridge every
  // absolute-index lookup below (lineage, quote, isLast) needs.
  const { items, tsList, origIndex } = useMemo(() => {
    if (!timeWindow) {
      return { items: agent.transcript, tsList: fullTsList, origIndex: agent.transcript.map((_, i) => i) };
    }
    const idx: number[] = [];
    agent.transcript.forEach((_, i) => {
      const t = fullTsList[i];
      if (t === undefined || (t >= timeWindow.startedAt && (timeWindow.endedAt === null || t <= timeWindow.endedAt))) idx.push(i);
    });
    return { items: idx.map((i) => agent.transcript[i]!), tsList: idx.map((i) => fullTsList[i]), origIndex: idx };
  }, [agent, fullTsList, timeWindow]);

  const blocks = useMemo(() => groupTranscriptBlocks(items), [items]);
  const firstToolStripIndex = useMemo(() => blocks.findIndex((b) => b.kind === "tools"), [blocks]);
  const blockKeyOrigin = useBlockKeyOrigin(items);

  const artifacts = useArtifacts({ agentId: agentKey }, liveEvents, rpcCall);
  const artifactByLabel = useMemo(() => {
    const m = new Map<string, ArtifactRow>();
    for (const row of artifacts) m.set(row.label, row);
    return m;
  }, [artifacts]);
  const onLinkClick = useCallback(
    (label: string) => {
      const row = artifactByLabel.get(label);
      if (!row) return;
      if (isPreviewableKind(row.kind)) {
        artifactsLocal.set({ previewId: row.id });
        return;
      }
      // CLICKABLE-LINKS: a "link"-kind artifact's url is agent-supplied (mcp
      // artifact.create) and unvalidated at creation — same allowlist gate as
      // an inline markdown link, so a disallowed scheme can't reach the OS
      // opener through this second path either.
      const opened =
        row.kind === "link" && row.url
          ? isOpenableLinkUrl(row.url)
            ? openArtifactUrl(row.url)
            : Promise.reject(new Error(`cannot open "${row.url}": disallowed url scheme`))
          : openArtifactSnapshot(row.id);
      void opened.catch((err: unknown) =>
        appStore.dispatch({ type: "commandError", message: errorText(err) }),
      );
    },
    [artifactByLabel],
  );

  const agents = useStore((s: UiState) => s.agents);
  const agentOrder = useStore((s: UiState) => s.agentOrder);
  const mentions = useMemo(() => agentMentions({ agents, agentOrder }), [agents, agentOrder]);
  const resolveMention = useCallback<ResolveMention>((name) => mentions.get(name) ?? null, [mentions]);
  const onMentionClick = useCallback((id: string) => appStore.dispatch({ type: "selectAgent", agentId: id }), []);
  // A2A-UX-OVERHAUL · PART 3: resolve a delivered turn's source AGENT ID (item.from)
  // to a { display name, MentionInfo } so the "@name" mention chip navigates to it.
  // Reads the identified record directly; display names can collide across runs.
  // Falls back to a friendly name and a muted chip for a sender outside the roster.
  const resolveMentionById = useCallback((id: string): { name: string; info: MentionInfo } => {
    const a = agents[id];
    if (a) {
      const name = displayName(a);
      const st = derivedState(a);
      return { name, info: { agentId: id, tone: stateVisual(st).tone, dimmed: st === "done" || st === "failed" || st === "killed" } };
    }
    return { name: agentName(id), info: { agentId: id, tone: "muted", dimmed: true } };
  }, [agents]);

  const lineageMap = useMemo(() => {
    const full = spawnLineageMap(agent.transcript, { agents, agentOrder }, agentKey);
    if (!timeWindow) return full;
    const reverse = new Map(origIndex.map((orig, local) => [orig, local]));
    const shifted = new Map<number, SpawnLineageEntry>();
    for (const [k, v] of full) {
      const local = reverse.get(k);
      if (local !== undefined) shifted.set(local, v);
    }
    return shifted;
  }, [agent, agents, agentOrder, agentKey, timeWindow, origIndex]);

  const local = useComposerLocal((s) => s);
  const detail = local.toolDetail;
  const openDetail = (blockStart: number): void => {
    composerLocal.set({ toolDetail: nextToolDetail(composerLocal.getState().toolDetail, detailKey, blockStart) });
  };

  // mod+e — only the LIVE segment owns the "agents.detail" action id
  // (registerActionHandler is last-wins; two live segments never coexist).
  const lastToolsStart = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!;
      if (b.kind === "tools") return b.startIndex;
    }
    return null;
  }, [blocks]);
  const lastToolsStartRef = useRef<number | null>(lastToolsStart);
  lastToolsStartRef.current = lastToolsStart;
  const detailKeyRef = useRef(detailKey);
  detailKeyRef.current = detailKey;
  useEffect(() => {
    if (!isLive) return undefined;
    return registerActionHandler("agents.detail", () => {
      const cur = composerLocal.getState().toolDetail;
      if (cur) { composerLocal.set({ toolDetail: null }); return; }
      const start = lastToolsStartRef.current;
      if (start !== null) composerLocal.set({ toolDetail: { agentId: detailKeyRef.current, blockStart: start, call: 0 } });
    });
  }, [isLive]);

  useEffect(() => {
    onRegisterTranscript?.(agentKey, agent.transcript);
  }, [agentKey, agent.transcript, onRegisterTranscript]);

  const handleQuote = useCallback(
    (localIndex: number) => {
      const abs = origIndex[localIndex];
      if (abs === undefined) return;
      onQuote?.(agentKey, abs);
    },
    [agentKey, origIndex, onQuote],
  );

  const lastItem = items[items.length - 1];
  const lastIsStreamingAssistant = !!lastItem && lastItem.role === "assistant" && lastItem.streaming && !!lastItem.text.trim();
  const showThinking = isLive && agent.busy && !lastIsStreamingAssistant;

  if (blocks.length === 0 && renderEmpty) {
    return <>{renderEmpty()}{showThinking ? <ThinkingLine canInterrupt={isLive && canInterrupt} busySince={agent.busySince} command={agent.pendingCommand} /> : null}</>;
  }

  return (
    <>
      {blocks.map((block, i) => {
        const key = blockKeyOf(block, blockKeyOrigin);
        const absIndex = block.kind === "single" ? origIndex[block.index]! : origIndex[block.startIndex]!;
        return (
          <Block
            key={key}
            block={block}
            blockKey={key}
            agent={agent}
            msgIndex={absIndex}
            ts={block.kind === "single" ? tsList[block.index] : undefined}
            isLast={block.kind === "single" && absIndex === agent.transcript.length - 1}
            firstToolStrip={i === firstToolStripIndex}
            canInterrupt={isLive && canInterrupt}
            detailOpen={
              detail !== null && detail.agentId === detailKey &&
              block.kind === "tools" && block.startIndex === detail.blockStart
            }
            onOpenDetail={openDetail}
            onLinkClick={onLinkClick}
            resolveMention={resolveMention}
            resolveMentionById={resolveMentionById}
            onMentionClick={onMentionClick}
            lineage={lineageMap}
            onQuote={handleQuote}
          />
        );
      })}
      {showThinking ? <ThinkingLine canInterrupt={isLive && canInterrupt} busySince={agent.busySince} command={agent.pendingCommand} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// shared scroll + keyboard machinery — ONE scroller, whether it hosts a
// single TranscriptSegment (TranscriptPanel) or several (StitchedTranscriptPanel).
// ---------------------------------------------------------------------------

/** Native-scroll bookkeeping (follow-tail, "↑ N more" hint, pgup/pgdn) for
 * the shared scroll region. `resetKey` re-pins to the tail when it changes
 * (a freshly-selected agent/task); `content` is any value that changes when
 * new material arrives (the driver for the follow-tail + hint recompute). */
// TRANSCRIPT-EVICT-OLD: `onAtBottomChange`, called ONLY on an actual
// true<->false transition of atBottomRef (never every scroll tick) — the
// reducer-side eviction gate (AgentView.atBottom, dispatched via the
// "transcriptAtBottom" action) needs to know the pin state, not every pixel
// of scroll position, so callers can dispatch straight from this without
// their own dedup.
export function useTranscriptScroll(resetKey: string, content: unknown, onNearTop?: () => void, onAtBottomChange?: (atBottom: boolean) => void) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);
  const atBottomRef = useRef(true);
  const setAtBottom = (next: boolean): void => {
    if (atBottomRef.current === next) return;
    atBottomRef.current = next;
    onAtBottomChange?.(next);
  };
  const [hint, setHint] = useState<ScrollHint>({ above: 0, below: 0 });
  // TRANSCRIPT-LAZY-OLDER: scroll-position ANCHORING across a prepend. Tracked
  // purely by content identity (no external "arm" call needed) — prependHistory
  // (packages/ui-state/src/reducer.ts) always produces `[...olderRows,
  // ...prevRows]`, preserving every previous row's object identity, so "content
  // grew at the front, and the old first row is still present further in" is an
  // unambiguous prepend signature. `prevScrollHeightRef` holds the body's
  // scrollHeight as it stood right after the LAST commit — i.e. exactly the
  // height "before" whatever just changed — so the delta between it and the
  // post-mutation height (read inside useLayoutEffect, after the DOM update but
  // before paint) is precisely the height the prepended rows added. Shifting
  // scrollTop by that same delta keeps whatever the operator was looking at
  // pinned in place instead of jumping. A live tail append while scrolled away
  // from the bottom is deliberately NOT corrected (isPrepend is false for it,
  // and atBottomRef is false too) — the browser's own "leave scrollTop alone"
  // default is already correct there, since the new content lands below the
  // viewport.
  const prevContentRef = useRef<unknown>(content);
  const prevScrollHeightRef = useRef(0);
  // content-visibility: auto (TranscriptPanel.module.css) reserves only a 48px
  // placeholder for each not-yet-rendered block until it paints for real (~300px
  // typical). At the instant the bottom-pin below runs, scrollHeight is computed
  // almost entirely from those placeholders, so `scrollTop = scrollHeight` lands
  // on the bottom of a too-short, fake geometry — nowhere near the true bottom.
  // As blocks near that landing spot resolve to real height, scrollHeight grows,
  // but nothing re-fires the pin (content/viewH are unchanged), so the operator
  // is stranded mid-track. Re-pin, bounded, whenever the CONTENT element's own
  // size changes (not the scroll container's — that never changes here).
  const repinsRef = useRef(0);
  const MAX_REPINS = 60;

  const [scrollResetKey, setScrollResetKey] = useState(resetKey);
  if (scrollResetKey !== resetKey) {
    setScrollResetKey(resetKey);
    atBottomRef.current = true;
    setScrollTop(0);
    setHint({ above: 0, below: 0 });
    prevContentRef.current = content;
    prevScrollHeightRef.current = 0;
    repinsRef.current = 0;
  }

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, [resetKey]);

  const onScroll = (): void => {
    const el = bodyRef.current;
    if (!el) return;
    setAtBottom(isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight));
    setScrollTop(el.scrollTop);
    if (onNearTop && isNearTop(el.scrollTop)) onNearTop();
  };

  useEffect(() => {
    const scrollByLines = (lines: number): void => {
      const el = bodyRef.current;
      if (!el) return;
      const parsed = parseFloat(getComputedStyle(el).lineHeight);
      const lineH = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
      el.scrollTop += lines * lineH;
    };
    const offs = [
      registerActionHandler("agents.scrollUp", () => scrollByLines(-5)),
      registerActionHandler("agents.scrollDown", () => scrollByLines(5)),
    ];
    return () => { for (const off of offs) off(); };
  }, []);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const prevContent = prevContentRef.current;
    const isPrepend = Array.isArray(content) && Array.isArray(prevContent) && prevContent.length > 0
      && content.length > prevContent.length
      && content[content.length - prevContent.length] === prevContent[0];
    prevContentRef.current = content;
    repinsRef.current = 0;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
    } else if (isPrepend) {
      const delta = el.scrollHeight - prevScrollHeightRef.current;
      if (delta !== 0) {
        el.scrollTop += delta;
        setScrollTop(el.scrollTop);
      }
    }
    prevScrollHeightRef.current = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `content` stands in for whatever material changed
  }, [content, resetKey, viewH]);

  useEffect(() => {
    const el = bodyRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner || typeof ResizeObserver === "undefined") return undefined;
    const pin = (): void => {
      if (!atBottomRef.current || repinsRef.current >= MAX_REPINS) return;
      const before = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      if (el.scrollTop !== before) {
        repinsRef.current += 1;
        setScrollTop(el.scrollTop);
      }
    };
    const ro = new ResizeObserver(pin);
    ro.observe(inner);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-observe per agent/task selection; content changes reuse the same DOM node
  }, [resetKey]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const next = scrollHintCounts(el.scrollTop, el.clientHeight, el.scrollHeight, EST_BLOCK_H);
    setHint((h) => (h.above === next.above && h.below === next.below ? h : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [content, viewH, scrollTop, resetKey]);

  return { bodyRef, onScroll, hint };
}

/** mod+y raw-markdown copy / `v` raw-view toggle / `q` quote / pgup·pgdn —
 * generalized over a per-agentId transcript map (TranscriptSegment's
 * onRegisterTranscript) so it resolves correctly regardless of how many
 * segments the shared scroller hosts. */
export function useTranscriptKeyboard(
  bodyRef: RefObject<HTMLDivElement | null>,
  rawLookup: (key: string) => string | undefined,
  resolveQuote: (key: string) => QuoteSlot | null,
  applyQuote: (slot: QuoteSlot) => void,
) {
  useEffect(() => registerActionHandler("agents.rawToggle", () => {
    const pane = bodyRef.current;
    const k = pane ? selectionMsgKey(pane) : null;
    if (k) richView.toggle(k);
  }), [bodyRef]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const pane = bodyRef.current;
      if (!pane) return;
      if ((ev.key === "PageUp" || ev.key === "PageDown") && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        runAction(ev.key === "PageUp" ? "agents.scrollUp" : "agents.scrollDown", appStore);
        return;
      }
      if (ev.repeat) return;
      if (ev.key === "v" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        if (isEditableTarget(ev.target)) return;
        if (!selectionMsgKey(pane)) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        runAction("agents.rawToggle", appStore);
        return;
      }
      if (ev.key === "q" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        if (isEditableTarget(ev.target)) return;
        const k = selectionMsgKey(pane);
        const slot = k ? resolveQuote(k) : null;
        if (!slot) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        applyQuote(slot);
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key === "y") {
        if (appStore.getState().pendingPermissions.length > 0) return;
        const k = selectionMsgKey(pane);
        if (!k) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        const payload = rawLookup(k) ?? window.getSelection()?.toString() ?? "";
        if (payload) {
          void writeClipboard(payload).then((ok) => {
            if (ok) appStore.dispatch({ type: "notice", message: copiedNotice(payload.length) });
          });
        }
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [bodyRef, rawLookup, resolveQuote, applyQuote]);
}

export function useTranscriptCopyOnSelect(
  bodyRef: RefObject<HTMLDivElement | null>,
  active: boolean,
  rawLookup: (key: string) => string | undefined,
) {
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    return installCopyOnSelect(
      el,
      (chars) => appStore.dispatch({ type: "notice", message: copiedNotice(chars) }),
      rawLookup,
    );
  }, [active, rawLookup, bodyRef]);
}

/** Per-agentId transcript registry (TranscriptSegment.onRegisterTranscript) +
 * the rawLookup/resolveQuote pair the shared keyboard hook needs — factored
 * out so both TranscriptPanel (one entry) and StitchedTranscriptPanel (one
 * entry per step agent) build it identically. */
export function useTranscriptRawRegistry() {
  const mapRef = useRef<Map<string, readonly TranscriptItem[]>>(new Map());
  const onRegisterTranscript = useCallback((agentId: string, transcript: readonly TranscriptItem[]) => {
    mapRef.current.set(agentId, transcript);
  }, []);
  const rawLookup = useCallback((key: string): string | undefined => {
    const hash = key.lastIndexOf("#");
    if (hash < 0) return undefined;
    const arr = mapRef.current.get(key.slice(0, hash));
    const item = arr?.[Number(key.slice(hash + 1))];
    return item && (item.role === "assistant" || item.role === "user") ? item.text : undefined;
  }, []);
  const resolveQuote = useCallback((key: string): QuoteSlot | null => {
    const hash = key.lastIndexOf("#");
    if (hash < 0) return null;
    const agentId = key.slice(0, hash);
    const arr = mapRef.current.get(agentId);
    if (!arr) return null;
    const idx = Number(key.slice(hash + 1));
    const item = arr[idx];
    if (!item || item.role !== "assistant") return null;
    const excerpt = item.text.trim();
    if (!excerpt) return null;
    return { agentId, kind: "turn", seq: idx, ts: item.ts ?? Date.now(), excerpt };
  }, []);
  return { onRegisterTranscript, rawLookup, resolveQuote };
}
