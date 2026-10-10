// W4 — Composer & decision-overlay command layer (PLAN §7-W4). This module is
// the desktop port of the retired TUI store's SEND SEMANTICS (sendToMain/sendToSelected/
// flushOutbox/answer*/spawnAgent) plus the
// app-local composer state the coverage doc marks `ui-state` (target chip,
// draft text, pending images, overlay opens). Everything here is IMPORT-SAFE
// for pure unit tests, mirroring keymap.ts's own rule: it never imports the
// app store or the rpc bridge — components hand both in (appStore + rpcCall).
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ContentBlock, DialogDecision } from "@chimera/protocol";
import { AGENT_MARK_SEEN_MAX_IDS, CONDUCTOR_PLAYBOOK, DEFAULT_SESSION_INSTRUCTIONS, DEFAULT_SESSION_PLACEHOLDER_PROMPT, EffortLevelSchema, type EffortLevel } from "@chimera/protocol";
import {
  encodeQuoteBlock,
  errorToText,
  failureCauseLabel,
  firstPendingDialog,
  firstPendingQuestion,
  mcpServerKey,
  type FailureCause,
  type Image,
  type ImageMediaType,
  type PendingDialog,
  type PendingPermission,
  type TranscriptItem,
  type UiState,
  type UiStore,
} from "@chimera/ui-state";
// WORKFLOW-TASK-VIEW: agentTasksLocal is a plain synchronous data cache (no
// react/rpc-bridge coupling of its own — see its own file header), unlike
// appStore/rpcCall which this module deliberately never imports. Read here
// ONLY to resolve a task-row selection ("task:<id>") to its current live step
// agent for send-target routing — resolveTargetIds/resolveActiveTargets below.
import { agentTasksLocal } from "./commands.agentTasks";
import { liveTaskStepAgentId, taskIdFromRowId } from "./selectors.workflows";
import { displayName } from "./selectors";
import { displayChord } from "../keymap";
import { loadPersistedDraft, persistDraft } from "./persistence";

export type RpcFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;

// DYNAMIC-MODEL-LISTS: the static KNOWN_MODELS array that used to live here is gone. It was a
// copy of the TUI's own hardcoded claude-only list, so BOTH clients showed claude model names
// while spawning a codex or kimi agent, and neither learned about a new model until someone
// edited source. Model lists now come from providers.models, per provider — SpawnCard and
// ModelCard each probe for the provider actually in play.
//
// EFFORT-ONE-SOURCE: this comment used to claim effort is "a CLOSED, provider-neutral vocabulary
// ... not something a provider publishes". It is published — per MODEL, on the initialize
// handshake chimera already consumes — and believing otherwise cost six hand-written copies of the
// list, one of which had lost both `minimal` and `max`. Derived now; effortLevelsFor() is what a
// picker should actually call, since the answer depends on provider and model.
export const KNOWN_EFFORTS: readonly EffortLevel[] = EffortLevelSchema.options;

/** Cycle helper shared by the SpawnCard's model/engine/isolation tab-cycling
 * (ports the TUI SpawnForm's model Tab branch). */
export function cycleValue(list: readonly string[], current: string, reverse = false): string {
  if (list.length === 0) return current;
  const i = list.indexOf(current);
  const delta = reverse ? -1 : 1;
  const next = i === -1 ? (reverse ? list.length - 1 : 0) : (i + delta + list.length) % list.length;
  return list[next]!;
}

// ---------------------------------------------------------------------------
// composer-local state (coverage B5 `ui-state` rows that are APP-local: the
// target chip, draft, pending images, overlay opens). A tiny framework-free
// store so the capture-phase key handlers can read FRESH state without refs.
// ---------------------------------------------------------------------------

// "marked" is the operator's own ad-hoc set (AGENT-MARK), alongside the standing targets. It
// deliberately reuses the existing multi-target send path rather than adding a broadcast of its
// own — "all" and a team already fan out, so a selection is one more way to name a set of ids.
export type ComposeTarget = "main" | "selected" | "all" | "marked" | { team: string };

// F22 (W24) — the custom drag mime an AgentList row carries so the Composer's
// drop target can tell "an agent row" apart from an OS file drop (the
// existing `onDrop`/`onDragOver` pair on the textarea already gates on
// dataTransfer.types — this is just a second type alongside "Files").
export const AGENT_DND_MIME = "application/x-chimera-agent";

/** UI-DRAGDROP-AFFORDANCE: the drop-target verdict for a dragover — the ONE
 * seam Composer's onDragOver and its unit test share. `undefined` types means
 * no dataTransfer at all (never a valid target). dropEffect must be set
 * EXPLICITLY rather than left to the browser's implicit default: AgentList's
 * dragstart allows both copy and move (AgentList.tsx), and some engines
 * keep dropEffect at that effectAllowed-implied value once it's ever been
 * observed, letting the "+" cursor leak onto regions with no drop handling
 * at all. Branching copy/none keeps the "+" scoped to a genuine payload over
 * the composer input and nowhere else. */
export function agentDragOverEffect(types: readonly string[] | undefined): "copy" | "none" {
  return types && (types.includes("Files") || types.includes(AGENT_DND_MIME)) ? "copy" : "none";
}

/** The composer's single quote slot (F22 doc: "{agentId, kind, seq, excerpt}",
 * `ts` added here so the sent blockquote's attribution line reflects when the
 * SOURCE turn was authored, not when the reply is sent). `seq` is the source
 * transcript index (a "turn" quote) or the transcript length at fetch time (a
 * "result" quote, which has no transcript index of its own) — kept for
 * potential future "scroll to source turn" use; not rendered today (no such
 * API exists yet on TranscriptPanel — click-through just selects the agent,
 * same as a spawn-lineage/@mention chip). */
export type QuoteSlot = { agentId: string; kind: "result" | "turn"; seq: number; ts: number; excerpt: string };

export type ToolDetailState = { agentId: string; blockStart: number; call: number };

/** A tool-call strip/card click is a TOGGLE: re-clicking the block that's
 * already open closes it (mirrors the mod+e agents.detail handler); clicking
 * a different block always opens that one, replacing whatever was open. */
export function nextToolDetail(
  cur: ToolDetailState | null,
  agentId: string,
  blockStart: number,
): ToolDetailState | null {
  if (cur && cur.agentId === agentId && cur.blockStart === blockStart) return null;
  return { agentId, blockStart, call: 0 };
}

export type ComposerLocalState = {
  composeText: string;
  // DRAFT-PER-AGENT: what is typed belongs to the agent it is addressed to. One shared buffer
  // meant switching agents carried your half-written message to someone else — and losing it if
  // you sent there by reflex. `draftOwner` is the target key `composeText` currently belongs to;
  // `drafts` holds every OTHER target's parked buffer. In-memory for the session: the reload
  // draft stays the single active one (OUTBOX-SURVIVES-RELOAD), because persisting every parked
  // draft would put each one's base64 attachments in localStorage too.
  draftOwner: string | null;
  drafts: Record<string, ComposerDraft>;
  /** F13: pending attachments riding inline `[▣ #N name]` tags in composeText. */
  pendingImages: PendingImage[];
  /** F13: the next tag number to assign — increments monotonically per message,
   * never reused after a mid-message delete; reset to 1 once the message sends. */
  nextImageNum: number;
  target: ComposeTarget;
  targetMenuOpen: boolean;
  spawnOpen: boolean;
  /** ROLES-TAB S6: the role to prefill SpawnCard's role field with the next
   * time it opens — set by RolesScreen's "spawn session with this role",
   * consumed once on SpawnCard mount then cleared. null = no prefill. */
  spawnPrefillRole: string | null;
  /** esc closed the "/" popup for the CURRENT text; typing reopens it. */
  slashDismissed: boolean;
  slashIndex: number;
  /** requestIds the user esc'd "later" on — the request stays pending. */
  dismissedPermissions: ReadonlySet<string>;
  /** questionIds esc'd (left pending) or expired locally. */
  dismissedQuestions: ReadonlySet<string>;
  toolDetail: ToolDetailState | null;
  /** mod+e toggle on the permission card: pretty (default) vs raw input. */
  permissionRaw: boolean;
  /** AGENT-INFO-PANEL: the TranscriptPanel header's clickable-name inspector
   * — set to the clicked agent's id on open, cleared on close/esc. Scoped by
   * agentId (not a bare boolean) so switching the selected agent implicitly
   * closes it, exactly like toolDetail above. */
  agentDetail: { agentId: string } | null;
  /** F22 (W24): the single active quote-reply slot — drag-drop / q / hover-↳
   * fill it, × or send clears it. null = no active quote. */
  quote: QuoteSlot | null;
};

/** DRAFT-PER-AGENT: one parked compose buffer. */
export type ComposerDraft = { text: string; images: PendingImage[]; nextNum: number };

/** Park the current buffer under its owner and restore `nextOwner`'s, if any.
 *
 *  Pure so the swap can be tested without a composer: this is the operation that decides whether a
 *  half-written message survives a click, and getting it wrong is silent. A no-op when the owner
 *  has not actually changed — re-entering the same agent must not clear what is being typed. */
export function switchDraftTo(state: ComposerLocalState, nextOwner: string | null): Partial<ComposerLocalState> | null {
  if (state.draftOwner === nextOwner) return null;
  // FIRST ADOPTION, not a clear: with no owner yet there is nothing parked, and whatever is in the
  // buffer is the reload-restored draft (OUTBOX-SURVIVES-RELOAD) or something just typed. It
  // belongs to whoever is selected now — wiping it here would make opening the app the one
  // reliable way to lose a draft, which is the bug this whole change exists to prevent.
  if (state.draftOwner === null) return { draftOwner: nextOwner };
  const drafts = { ...state.drafts };
  if (state.draftOwner !== null && (state.composeText.length > 0 || state.pendingImages.length > 0)) {
    drafts[state.draftOwner] = { text: state.composeText, images: state.pendingImages, nextNum: state.nextImageNum };
  } else if (state.draftOwner !== null) {
    // An emptied draft is a DELETED draft — leaving the old one parked would resurrect text the
    // user cleared on purpose the next time they came back.
    delete drafts[state.draftOwner];
  }
  const restored = nextOwner !== null ? drafts[nextOwner] : undefined;
  return {
    drafts,
    draftOwner: nextOwner,
    composeText: restored?.text ?? "",
    pendingImages: restored?.images ?? [],
    nextImageNum: restored?.nextNum ?? 1,
    // A parked draft's slash menu state is not worth restoring; it is derived from the text anyway.
    slashIndex: 0,
    slashDismissed: false,
  };
}

const initialLocal: ComposerLocalState = {
  // OUTBOX-SURVIVES-RELOAD: the typed-but-not-sent draft is the same class of
  // data loss as a queued message, hits the same reload path, and gets the
  // same one-key localStorage treatment (see persistence.ts).
  composeText: loadPersistedDraft(),
  draftOwner: null,
  drafts: {},
  pendingImages: [],
  nextImageNum: 1,
  // Follow the live agent-list selection by default. The existing selected
  // resolver safely falls back to the main conductor when there is no real
  // worker selection (and deliberately does not do so for workflow task rows).
  target: "selected",
  targetMenuOpen: false,
  spawnOpen: false,
  spawnPrefillRole: null,
  slashDismissed: false,
  slashIndex: 0,
  dismissedPermissions: new Set(),
  dismissedQuestions: new Set(),
  toolDetail: null,
  permissionRaw: false,
  agentDetail: null,
  quote: null,
};

export type LocalStore = {
  getState(): ComposerLocalState;
  set(patch: Partial<ComposerLocalState>): void;
  subscribe(fn: () => void): () => void;
  reset(): void;
};

export function createLocalStore(): LocalStore {
  let state = initialLocal;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    reset() {
      state = initialLocal;
      for (const fn of listeners) fn();
    },
  };
}

/** The ONE app-wide composer-local store (module singleton — pure, no IO). */
export const composerLocal: LocalStore = createLocalStore();

// OUTBOX-SURVIVES-RELOAD: persist the draft on every change, same tick (no
// timer) — mirrors the outbox subscribe in store.ts.
let prevDraft = composerLocal.getState().composeText;
composerLocal.subscribe(() => {
  const next = composerLocal.getState().composeText;
  if (next !== prevDraft) {
    prevDraft = next;
    persistDraft(next);
  }
});

/** React binding — same selector discipline as useStore (read existing refs). */
export function useComposerLocal<T>(selector: (s: ComposerLocalState) => T): T {
  return useSyncExternalStore(composerLocal.subscribe, () => selector(composerLocal.getState()));
}

// ---------------------------------------------------------------------------
// F22 (W24) — quote-reply slot builders. quoteFromMessageKey is pure (the `q`
// keydown handler / hover-↳ affordance); quoteFromAgent is RPC-backed (a
// done agent's result isn't in the live AgentView — same on-demand fetch
// shape as commands.system.ts's toggleResult) for the drag-drop path.
// ---------------------------------------------------------------------------

/** `q` / hover-↳ on a specific transcript turn: only an assistant message has
 * something to quote (verbatim, per the F22 doc — no truncation here, unlike
 * the spawn-lineage prompt excerpt). Returns null for a non-assistant/empty
 * turn or a key belonging to a DIFFERENT agent (a stale key from a prior
 * selection — mirrors TranscriptPanel's own rawLookup guard). */
export function quoteFromMessageKey(
  key: string,
  expectedAgentId: string,
  transcript: readonly TranscriptItem[],
): QuoteSlot | null {
  const hash = key.lastIndexOf("#");
  if (hash < 0 || key.slice(0, hash) !== expectedAgentId) return null;
  const idx = Number(key.slice(hash + 1));
  const item = transcript[idx];
  if (!item || item.role !== "assistant") return null;
  const excerpt = item.text.trim();
  if (!excerpt) return null;
  return { agentId: expectedAgentId, kind: "turn", seq: idx, ts: item.ts ?? Date.now(), excerpt };
}

/** MENTION-TERMINAL-AGENTS: agent.result's text is empty for a terminal agent
 * that died with no output (e.g. a spawn-time crash) — the failure reason
 * instead lives on agent.status's `attempts` (AgentSupervisor.result() only
 * echoes {state,text,costUsd}, never the attempt list). Fetched on demand,
 * only for the empty-result case, so the common done-with-output path never
 * pays for a second RPC. Never throws: a status-fetch failure just degrades
 * to the generic "(state — no output)" excerpt below. */
async function terminalFailureExcerpt(rpc: RpcFn, agentId: string, resultState: string): Promise<string> {
  if (resultState === "failed") {
    try {
      const status = await rpc<{ failure?: { cause?: string }; attempts?: Array<{ errorClass?: string }> }>("agent.status", { agentId });
      // F08: the disposition's cause is the operator-facing classification (rate-limited vs
      // credential vs unretryable) — prefer it over the raw errorClass, but keep that fallback
      // for an older daemon that never stamped `failure`.
      if (status.failure?.cause) return `failed: ${failureCauseLabel(status.failure.cause as FailureCause)} (no output)`;
      const last = status.attempts?.[status.attempts.length - 1];
      if (last?.errorClass) return `failed: ${last.errorClass} (no output)`;
    } catch {
      // fall through to the generic message below
    }
    return "failed (no output)";
  }
  return `(${resultState} — no output)`;
}

/** Drag-drop from the agent list: a RUNNING agent quotes its latest assistant
 * turn (mirrors quoteFromMessageKey, scanning back from the transcript tail).
 * Anything else (done/failed/killed/waiting) quotes agent.result's text when
 * present; a TERMINAL agent NEVER silently no-ops even when that text is
 * empty (a crashed-at-spawn FAILED agent has none) — it falls back to
 * terminalFailureExcerpt so it stays mentionable/droppable. The only
 * remaining null case is a RUNNING agent with no assistant turn yet (nothing
 * to quote AT ALL — the caller shows a notice instead of filling the slot). */
export async function quoteFromAgent(rpc: RpcFn, state: UiState, agentId: string): Promise<QuoteSlot | null> {
  const view = state.agents[agentId];
  if (!view) return null;
  if (view.state === "running") {
    for (let i = view.transcript.length - 1; i >= 0; i--) {
      const item = view.transcript[i]!;
      if (item.role !== "assistant") continue;
      const excerpt = item.text.trim();
      if (!excerpt) continue;
      return { agentId, kind: "turn", seq: i, ts: item.ts ?? Date.now(), excerpt };
    }
    return null;
  }
  const result = await rpc<{ state: string; text?: string; costUsd: number }>("agent.result", { agentId });
  const text = (result.text ?? "").trim();
  const excerpt = text || await terminalFailureExcerpt(rpc, agentId, result.state);
  return { agentId, kind: "result", seq: view.transcript.length, ts: Date.now(), excerpt };
}

/** The encoded blockquote a submitted quote-reply is PREPENDED with (F22:
 * "encoded as an attributed markdown blockquote + turn ref line — NO wire/
 * daemon change"). `mention`/`ts` are resolved by the caller (Composer.tsx,
 * which has selectors.ts's displayName/fmtClock already in scope) so this
 * stays a thin, independently-testable wrapper over ui-state's encoder. */
export function buildQuotedPrefix(mention: string, ts: string, quote: Pick<QuoteSlot, "kind" | "excerpt">): string {
  return encodeQuoteBlock(quote.excerpt, mention, quote.kind, ts);
}

export type AgentStatusState = { status: Record<string, unknown> | null; loading: boolean };

/** AGENT-INFO-PANEL: the on-demand `agent.status` fetch backing the
 * TranscriptPanel inspector (cwd/permissionProfile/isolation/instructions/
 * on.permissionRequest — none of which ride the always-live AgentView
 * projection, mirroring PluginsCard/CheckpointStrip's own cwd-via-agent.status
 * precedent). `agentId: null` (the panel closed, or no agent selected) skips
 * the fetch entirely and resets to the initial idle state. A response for an
 * agentId the caller has since moved away from is dropped (the `alive` guard),
 * same discipline as commands.checkpoints.ts's refreshStatus. */
export function useAgentStatus(agentId: string | null, request: RpcFn): AgentStatusState {
  const [state, setState] = useState<AgentStatusState>({ status: null, loading: false });
  useEffect(() => {
    if (!agentId) {
      setState({ status: null, loading: false });
      return undefined;
    }
    let alive = true;
    setState({ status: null, loading: true });
    request<Record<string, unknown>>("agent.status", { agentId })
      .then((rec) => {
        if (alive) setState({ status: rec, loading: false });
      })
      .catch(() => {
        if (alive) setState({ status: null, loading: false });
      });
    return () => {
      alive = false;
    };
  }, [agentId, request]);
  return state;
}

/** MODEL-ACTUAL-SURFACE: providerId -> catalog defaultModel, fetched once (not
 * agent-scoped, unlike useAgentStatus above) so AgentDetailPanel can show
 * "(default: gpt-5.6-sol)" instead of a bare "(provider default model)" for an
 * agent that hasn't reported a live model yet. Best-effort: a failed fetch
 * just leaves the map empty and the panel falls back to the bare placeholder. */
export function useProviderDefaultModels(request: RpcFn): ReadonlyMap<string, string> {
  const [models, setModels] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    request<Array<{ id?: string; defaultModel?: string }>>("providers.list", {})
      .then((rows) => {
        if (!alive || !Array.isArray(rows)) return;
        setModels(new Map(rows.filter((r) => r.id && r.defaultModel).map((r) => [r.id!, r.defaultModel!])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [request]);
  return models;
}

// ---------------------------------------------------------------------------
// slash popup derivations — ported 1:1 from the TUI's SlashPopup.tsx pure
// helpers (slashQuery / filterSlashCommands).
// ---------------------------------------------------------------------------

/** The command-token being typed, or null when the compose value isn't a
 * slash-command-in-progress (must start with "/", single-line, no space yet). */
export function slashQuery(composeText: string): string | null {
  if (!composeText.startsWith("/") || composeText.includes("\n")) return null;
  const rest = composeText.slice(1);
  if (rest.includes(" ")) return null;
  return rest;
}

export type SlashEntry = { name: string; description?: string; keyHint?: string; source: "builtin" | "agent" };

/** Prefix match, case-insensitive ("" matches everything) — TUI parity. */
export function filterSlashEntries(entries: readonly SlashEntry[], query: string): SlashEntry[] {
  const q = query.toLowerCase();
  return entries.filter((e) => e.name.toLowerCase().startsWith(q));
}

// ---------------------------------------------------------------------------
// compose interpretation (A1-2) — the pure "what does Enter mean" resolver,
// ported from the TUI App's handleComposeSubmit decision ladder.
// ---------------------------------------------------------------------------

const EXTENSION_MEDIA_TYPES: ReadonlyArray<readonly [string, ImageMediaType]> = [
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"],
];

/** Media type for an image-extension path, else null (TUI clipboard.ts port). */
export function imagePathMediaType(path: string): ImageMediaType | null {
  const lower = path.toLowerCase();
  for (const [ext, mediaType] of EXTENSION_MEDIA_TYPES) if (lower.endsWith(ext)) return mediaType;
  return null;
}

export function pathBasename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

export type ComposeIntent =
  | { kind: "noop" }
  | { kind: "builtin"; name: string; args: string }
  | { kind: "slash"; name: string; args: string }
  | { kind: "imagePath"; path: string; caption: string; mediaType: ImageMediaType }
  | { kind: "text"; text: string };

/** Interpret a submitted compose buffer (A1-2), mirroring the TUI ladder:
 *  1. leading "/" (not an image path, and NO pending images — a slash command
 *     carries no attachment, TUI parity) → builtin (runs locally) or slash
 *     (routes to the agent verbatim);
 *  2. an image-extension path → attach; the path NEVER reaches the model —
 *     the caption is its basename;
 *  3. empty text + no images → no-op;
 *  4. otherwise plain text ("(image)" placeholder for an image-only send,
 *     since SendParams.text has a locked min(1)). */
export function interpretCompose(
  raw: string,
  opts: { hasPendingImages: boolean; isBuiltin: (name: string) => boolean },
): ComposeIntent {
  const trimmed = raw.trim();
  if (/^\/[^\s/\\]+(?:\s|$)/.test(trimmed) && imagePathMediaType(trimmed) === null && !opts.hasPendingImages) {
    const rest = trimmed.slice(1);
    const sp = rest.indexOf(" ");
    const name = (sp === -1 ? rest : rest.slice(0, sp)).toLowerCase();
    const args = sp === -1 ? "" : rest.slice(sp + 1);
    if (!name) return { kind: "text", text: trimmed };
    return opts.isBuiltin(name) ? { kind: "builtin", name, args } : { kind: "slash", name, args };
  }
  const mediaType = imagePathMediaType(trimmed);
  if (mediaType !== null) return { kind: "imagePath", path: trimmed, caption: pathBasename(trimmed), mediaType };
  if (!trimmed && !opts.hasPendingImages) return { kind: "noop" };
  return { kind: "text", text: trimmed || "(image)" };
}

// ---------------------------------------------------------------------------
// F13 (W13/D9) — inline image tags: an atomic `[▣ #N name]` token embedded as
// literal text in the compose buffer (a plain <textarea> can't render a rich
// inline widget mid-edit — the styled chip in the mock is the SENT-turn
// rendering, done in real React once the message lands in the transcript).
// `num` is per-message and stable (assigned by an ever-incrementing counter,
// never reused after a mid-message delete) so remaining tags never renumber.
// ---------------------------------------------------------------------------

/** A pending attachment riding an inline tag: `Image` + the stable `num` its
 * `[▣ #N name]` token carries + the display `name` (paste caption / basename). */
export type PendingImage = Image & { num: number; name: string };

const IMAGE_TAG_SOURCE = "\\[▣ #(\\d+) ([^\\]\\n]+)\\]";

/** The literal token text inserted at the cursor for image #`num`. */
export function imageTagText(num: number, name: string): string {
  return `[▣ #${num} ${name}]`;
}

export type TagSpan = { start: number; end: number; num: number; name: string };

/** Every `[▣ #N name]` occurrence in `text`, in document order. */
export function findImageTags(text: string): TagSpan[] {
  const re = new RegExp(IMAGE_TAG_SOURCE, "g");
  const spans: TagSpan[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length, num: Number(m[1]), name: m[2]! });
  }
  return spans;
}

/** The tag `pos` sits at/inside the TAIL of (`start < pos <= end`) — the span
 * Backspace/⌥← must treat as one atomic unit, covering both the exact
 * just-after-`]` caret AND a caret a mouse click landed mid-tag. */
export function tagEndingAt(spans: readonly TagSpan[], pos: number): TagSpan | undefined {
  return spans.find((s) => pos > s.start && pos <= s.end);
}

/** The tag `pos` sits at/inside the HEAD of (`start <= pos < end`) — the span
 * Delete/→ must treat as one atomic unit. */
export function tagStartingAt(spans: readonly TagSpan[], pos: number): TagSpan | undefined {
  return spans.find((s) => pos >= s.start && pos < s.end);
}

/** Split a compose buffer containing inline tags into D9's ordered `content[]`
 * blocks (text verbatim, images at their tag positions), the flattened display
 * text (each tag replaced by its caption — the raw path/data never leaks), and
 * the legacy bunched `images[]` (insertion order) for pre-D9 fallback paths. */
/** IMAGE-EDIT-LOSES-IMAGE: rebuild a compose buffer — text plus its inline `[▣ #N name]` tags —
 *  and the PendingImages behind them, from a queued item.
 *
 *  Why this is derivable and was not being derived: a queued item's `text` is the FLATTENED form,
 *  where splitComposeContent has already replaced each tag with the image's filename. Restoring
 *  that text alone put the literal word "image.png" in the buffer with nothing behind it, and
 *  sending it again sent that word instead of the picture. The faithful record was sitting in the
 *  same item all along — `content` carries the text and image blocks in order, image DATA included.
 *
 *  The filename is regenerated from the media type rather than stored: it is a display label, and
 *  the alternative (persisting it a second time) would double the base64 an image message costs in
 *  localStorage to preserve a caption nobody chose. */
export function draftFromOutbox(
  item: { text: string; content?: readonly ContentBlock[] },
  startNum: number,
): { text: string; images: PendingImage[]; nextNum: number } {
  if (!item.content || item.content.length === 0) return { text: item.text, images: [], nextNum: startNum };
  const parts: string[] = [];
  const images: PendingImage[] = [];
  let num = startNum;
  for (const block of item.content) {
    if (block.type === "text") { parts.push(block.text); continue; }
    const name = `image.${block.mediaType.split("/")[1] ?? "png"}`;
    parts.push(imageTagText(num, name));
    images.push({ mediaType: block.mediaType, data: block.data, num, name });
    num++;
  }
  return { text: parts.join(""), images, nextNum: num };
}

export function splitComposeContent(
  text: string,
  pendingImages: readonly PendingImage[],
): { content: ContentBlock[]; flatText: string; images: Image[] } {
  const spans = findImageTags(text);
  const content: ContentBlock[] = [];
  const flatParts: string[] = [];
  let hasText = false;
  let cursor = 0;
  for (const span of spans) {
    const before = text.slice(cursor, span.start);
    if (before.length > 0) { content.push({ type: "text", text: before }); flatParts.push(before); hasText ||= before.trim().length > 0; }
    const img = pendingImages.find((p) => p.num === span.num);
    if (img) {
      content.push({ type: "image", mediaType: img.mediaType, data: img.data });
      flatParts.push(img.name);
    }
    cursor = span.end;
  }
  const tail = text.slice(cursor);
  if (tail.length > 0) { content.push({ type: "text", text: tail }); flatParts.push(tail); hasText ||= tail.trim().length > 0; }
  // Filenames only surface in flatText alongside REAL surrounding text (they
  // read as inline captions there) — an image-only send (no text blocks at
  // all) falls back to the generic "(image)" caption instead of a bare filename.
  const flatText = hasText ? flatParts.join("").trim() : (content.length > 0 ? "(image)" : "");
  const images = pendingImages.map(({ mediaType, data }): Image => ({ mediaType, data }));
  return { content, flatText, images };
}

// ---------------------------------------------------------------------------
// readline editing (B5, darwin chords) — pure text/cursor transforms so the
// Composer's ⌥⌫ / ⌘⌫ / ⌥←→ / ⌘←→ handlers are deterministic + unit-testable.
// ---------------------------------------------------------------------------

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Cursor position one word LEFT of pos (⌥←): skip separators, then the word. */
export function wordLeft(text: string, pos: number): number {
  let i = Math.max(0, Math.min(pos, text.length));
  while (i > 0 && !WORD_CHAR.test(text[i - 1]!)) i--;
  while (i > 0 && WORD_CHAR.test(text[i - 1]!)) i--;
  return i;
}

/** Cursor position one word RIGHT of pos (⌥→). */
export function wordRight(text: string, pos: number): number {
  let i = Math.max(0, Math.min(pos, text.length));
  while (i < text.length && !WORD_CHAR.test(text[i]!)) i++;
  while (i < text.length && WORD_CHAR.test(text[i]!)) i++;
  return i;
}

/** Start of the current (soft) line (⌘←). */
export function lineStart(text: string, pos: number): number {
  const i = text.lastIndexOf("\n", Math.max(0, Math.min(pos, text.length)) - 1);
  return i === -1 ? 0 : i + 1;
}

/** End of the current line (⌘→). */
export function lineEnd(text: string, pos: number): number {
  const i = text.indexOf("\n", Math.max(0, Math.min(pos, text.length)));
  return i === -1 ? text.length : i;
}

export type EditResult = { text: string; pos: number };

/** ⌥⌫ — delete the word left of the cursor. */
export function deleteWordLeft(text: string, pos: number): EditResult {
  const start = wordLeft(text, pos);
  return { text: text.slice(0, start) + text.slice(pos), pos: start };
}

/** ⌘⌫ — delete to the start of the current line. */
export function deleteLineLeft(text: string, pos: number): EditResult {
  const start = lineStart(text, pos);
  return { text: text.slice(0, start) + text.slice(pos), pos: start };
}

// ---------------------------------------------------------------------------
// question countdown (A4-3 / TUI-041) — pure remaining-seconds math; the card
// ticks 1s and drops the card at zero.
// ---------------------------------------------------------------------------

export function remainingSec(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

// ---------------------------------------------------------------------------
// visible-decision selectors — firstPendingQuestion/pendingPermissions[0]
// filtered through the local "esc = later" dismissed sets (badge/pending state
// in ui-state is untouched — only the CARD hides).
// ---------------------------------------------------------------------------

export function visiblePermission(state: UiState, local: Pick<ComposerLocalState, "dismissedPermissions">): PendingPermission | null {
  for (const p of state.pendingPermissions) if (!local.dismissedPermissions.has(p.requestId)) return p;
  return null;
}

export type VisibleQuestion = NonNullable<ReturnType<typeof firstPendingQuestion>>;

// ASK-UNREACHABLE-TARGET-LEAK: mirrors firstPendingQuestion's `q.to === undefined`
// guard — a `to`-targeted question is inter-agent (addressed to another agent via
// answer_question), never the human's to answer, so it must never surface as a card.
export function visibleQuestion(state: UiState, local: Pick<ComposerLocalState, "dismissedQuestions">): VisibleQuestion | null {
  for (const id of state.agentOrder) {
    const q = state.agents[id]?.pendingQuestion;
    if (q && q.to === undefined && !local.dismissedQuestions.has(q.questionId)) return { ...q, agentId: id };
  }
  return null;
}

export type VisibleDialog = PendingDialog & { agentId: string };

/** Native interactive dialog (AskUserQuestion/elicitation) awaiting an answer —
 * a thin alias over firstPendingDialog's cross-agent aggregation. Unlike
 * visiblePermission/visibleQuestion there is no local "esc = later" dismissed
 * set: esc on a dialog answers {behavior:"cancelled"} directly (the CLI-side
 * tool call itself is blocked on this dialog, so there is nothing to leave
 * pending — mirrors the TUI's DLG3 key handling). */
export function visibleDialog(state: UiState): VisibleDialog | null {
  return firstPendingDialog(state);
}

// ---------------------------------------------------------------------------
// esc close-priority chain (build item 10) — ONE ordered resolver, derived
// from the TUI App's esc tiers (App.tsx:2691, highest→lowest: tool-inspect →
// drill-ins → queued-drop → interrupt → clear-compose) merged with the
// coverage contract (A1-1 esc clears a NON-empty composer; B4 esc-interrupt
// only when nothing else claims the key; permission/question esc = "later").
// Final documented order:
//   0. SYSTEM OVERLAYS (final-acceptance MAJOR 1): every W6/W7/W8 card that
//      mounts through the OverlayOutlet floats ABOVE the whole agents screen,
//      so an open one must claim esc before ANY inline tier — the AgentsScreen
//      capture handler otherwise starves OverlayCard's own esc listener and,
//      worst case, falls through to a destructive interrupt on a busy agent.
//      Internal order (only one is ever open in practice — deterministic
//      anyway): palette → mcpPalette → accounts → result → model → plugins →
//      hostTools. mcpPalette/hostTools keep their OWN inner esc tiering
//      (args-form → list, profile-edit → rows) — the chain routes to their
//      exported escape accessors instead of blind-closing.
//   1. help          (built-in W3 tier — a fullscreen overlay)
//   2. toolDetail    (TUI: toolInspect is the highest inline tier)
//   2.5. agentDetail (AGENT-INFO-PANEL: the header-click agent inspector —
//      an in-place TranscriptPanel expand like toolDetail, so it sits right
//      next to it; closes AFTER a still-open toolDetail since that's the
//      more specific/nested card)
//   3. slash popup   (dismiss for the current text; typing reopens)
//   4. target menu
//   5. spawn card
//   5.5. dialog      → answers {behavior:"cancelled"} directly (not "later" —
//      the CLI's blocking tool call needs an answer to unblock; DLG3 parity)
//   6. question      → "later": card hides, question stays pending
//   7. permission    → "later": card hides, request + badge stay pending
//   8. clear compose (text and/or pending images — A1-1; TUI clears last but
//      its queued-drop tier is gated on an EMPTY buffer, so text-clear
//      effectively precedes it — kept explicit here)
//   9. drop last queued item (mock QueuedBar "esc drop")
//  10. interrupt     (B4: only when no overlay/queue/compose text — the same
//      predicate that gates the "esc interrupt" hint, so esc always does
//      exactly what the hint advertises)
// ---------------------------------------------------------------------------

export type EscTier =
  // VOICE-STOP: tier -1, ABOVE every overlay — if the app is speaking at you, that's the thing
  // Esc must stop first; nothing else on screen is as intrusive as audio you can't turn off.
  | "voiceStopSpeaking"
  | "palette" | "mcpPalette" | "accounts" | "result" | "model" | "plugins" | "hostTools"
  | "help" | "toolDetail" | "agentDetail" | "slash" | "targetMenu" | "spawn" | "dialog"
  | "question" | "permission" | "clearCompose" | "dropQueued" | "interrupt";

export type EscSnapshot = {
  voiceSpeaking: boolean;   // voice status === "speaking" (push-to-talk OR conversation mode)
  // system overlays (tier 0) — ui-state's paletteOpen/mcpPaletteOpen/
  // accountsOpen/resultOpen + the W6/W7/W8 local stores (systemLocal.modelOpen,
  // projectsLocal.pluginsOpen, hostCommands.getState().open).
  paletteOpen: boolean;
  mcpPaletteOpen: boolean;
  accountsOpen: boolean;
  resultOpen: boolean;
  modelOpen: boolean;
  pluginsOpen: boolean;
  hostToolsOpen: boolean;
  helpOpen: boolean;
  toolDetailOpen: boolean;
  agentDetailOpen: boolean;
  slashOpen: boolean;
  targetMenuOpen: boolean;
  spawnOpen: boolean;
  dialogVisible: boolean;
  questionVisible: boolean;
  permissionVisible: boolean;
  composeNonEmpty: boolean;
  queuedCount: number;
  canInterrupt: boolean;
};

export function resolveEscTier(s: EscSnapshot): EscTier | null {
  if (s.voiceSpeaking) return "voiceStopSpeaking";
  if (s.paletteOpen) return "palette";
  if (s.mcpPaletteOpen) return "mcpPalette";
  if (s.accountsOpen) return "accounts";
  if (s.resultOpen) return "result";
  if (s.modelOpen) return "model";
  if (s.pluginsOpen) return "plugins";
  if (s.hostToolsOpen) return "hostTools";
  if (s.helpOpen) return "help";
  if (s.toolDetailOpen) return "toolDetail";
  if (s.agentDetailOpen) return "agentDetail";
  if (s.slashOpen) return "slash";
  if (s.targetMenuOpen) return "targetMenu";
  if (s.spawnOpen) return "spawn";
  if (s.dialogVisible) return "dialog";
  if (s.questionVisible) return "question";
  if (s.permissionVisible) return "permission";
  if (s.composeNonEmpty) return "clearCompose";
  if (s.queuedCount > 0) return "dropQueued";
  if (s.canInterrupt) return "interrupt";
  return null;
}

/** The interrupt predicate (B4 "esc interrupt" hint + esc tier 10 — the SAME
 * value, ported from the TUI's canInterruptSelected): a genuinely busy,
 * running selected agent with nothing else for esc to claim first. */
export function canInterruptSelected(state: UiState, local: ComposerLocalState, queuedCount: number): boolean {
  const sel = state.selectedAgentId ? state.agents[state.selectedAgentId] : undefined;
  return (
    !!sel && sel.busy === true && sel.state === "running" &&
    local.toolDetail === null && local.agentDetail === null && !local.spawnOpen && !local.targetMenuOpen &&
    local.composeText === "" && local.pendingImages.length === 0 &&
    queuedCount === 0 &&
    visiblePermission(state, local) === null &&
    visibleQuestion(state, local) === null &&
    visibleDialog(state) === null
  );
}

// ---------------------------------------------------------------------------
// target resolution (B5 row 2, TUI-003) — the chip IS the routing: whatever
// the chip shows is where the message lands.
// ---------------------------------------------------------------------------

/** The concrete agentIds a send to `target` delivers to RIGHT NOW. "main"
 * resolves to mainConductorId (empty ⇒ lazy spawn, A2); "selected" to the
 * current selection (falling back to main when the selection is missing/main
 * itself — the TUI's targetSelected predicate); team/all fan out over running
 * agents. */
export function resolveTargetIds(state: UiState, target: ComposeTarget): { ids: string[]; lazyMain: boolean } {
  if (target === "main") {
    return state.mainConductorId ? { ids: [state.mainConductorId], lazyMain: false } : { ids: [], lazyMain: true };
  }
  if (target === "selected") {
    const selId = state.selectedAgentId;
    // WORKFLOW-TASK-VIEW: a task-row selection never falls back to main — an
    // unresolvable step target means "nothing to send to right now", not
    // "route it to the wrong agent". See liveTaskStepAgentId's doc comment.
    const taskId = selId ? taskIdFromRowId(selId) : null;
    if (taskId) {
      const raw = agentTasksLocal.getState().tasks.find((t) => t["taskId"] === taskId) ?? null;
      const liveId = liveTaskStepAgentId(raw);
      return liveId && state.agents[liveId] ? { ids: [liveId], lazyMain: false } : { ids: [], lazyMain: false };
    }
    const real = !!selId && selId !== state.mainConductorId && !!state.agents[selId];
    if (real && selId) return { ids: [selId], lazyMain: false };
    return state.mainConductorId ? { ids: [state.mainConductorId], lazyMain: false } : { ids: [], lazyMain: true };
  }
  if (target === "marked") {
    // Only agents that still EXIST and are running: a mark on a row that has since finished must
    // not turn a broadcast into a stream of "not running" errors. Filtered on read rather than
    // pruned on change — see the reducer's toggleAgentMark comment.
    const ids = state.markedAgentIds.filter((id) => state.agents[id]?.state === "running" && !state.agents[id]?.shadow);
    return { ids, lazyMain: false };
  }
  if (target === "all") {
    const ids = state.agentOrder.filter((id) => {
      const a = state.agents[id];
      return !!a && a.state === "running" && !a.shadow;
    });
    return { ids, lazyMain: false };
  }
  const ids = state.agentOrder.filter((id) => {
    const a = state.agents[id];
    return !!a && a.state === "running" && !a.shadow && a.membership?.team === target.team;
  });
  return { ids, lazyMain: false };
}

/** The chip's target text ("main" / selected agent's name / "team:X" / "all"). */
export function targetLabel(target: ComposeTarget, selectedName: string | null): string {
  if (target === "main") return "main";
  if (target === "selected") return selectedName ?? "selected";
  if (target === "all") return "all";
  if (target === "marked") return "marked";
  return `team:${target.team}`;
}

// ---------------------------------------------------------------------------
// built-in ⌘ slash commands (build item 3) — each run() dispatches an action /
// command that ALREADY exists; nothing here touches the agent (that's the
// `slash` intent path). Mirrors the TUI's state/commands.ts catalog shape.
// ---------------------------------------------------------------------------

export type BuiltinCtx = {
  store: UiStore;
  commands: AgentCommands;
  openSpawn(): void;
};

export type BuiltinCommand = {
  name: string;
  description: string;
  keyHint?: string;
  run(ctx: BuiltinCtx): void | Promise<void>;
};

export const builtinCommands: readonly BuiltinCommand[] = [
  { name: "status", description: "daemon + account summary", run: (ctx) => ctx.commands.showStatus() },
  // KILL-CONFIRM: agent.kill is irreversible — route through the same
  // ConfirmAction gate the row button / mod+shift+k chord use (AgentsScreen.tsx)
  // instead of killing directly, so the palette/slash entry point can't bypass it.
  {
    name: "kill", description: "kill the selected agent", keyHint: displayChord("mod+shift+k"),
    run: (ctx) => {
      const state = ctx.store.getState();
      const agentId = state.selectedAgentId;
      if (!agentId) return;
      const agent = state.agents[agentId];
      ctx.store.dispatch({ type: "confirm", confirm: { kind: "killAgent", agentId, label: agent ? displayName(agent) : agentId } });
    },
  },
  // CLOSE-CONFIRM: agent.close ends the session irreversibly — route through the
  // same closeAgent ConfirmAction gate the mod+shift+w chord uses (AgentsScreen.tsx)
  // instead of closing directly, so the palette/slash entry point can't bypass it.
  {
    name: "close", description: "close conductor session", keyHint: displayChord("mod+shift+w"),
    run: (ctx) => {
      const state = ctx.store.getState();
      const id = state.mainConductorId;
      if (!id) return;
      const agent = state.agents[id];
      ctx.store.dispatch({ type: "confirm", confirm: { kind: "closeAgent", agentId: id, label: agent ? displayName(agent) : id } });
    },
  },
  { name: "help", description: "keyboard shortcuts", keyHint: "?", run: (ctx) => ctx.store.dispatch({ type: "helpOpen", open: !ctx.store.getState().helpOpen }) },
  { name: "spawn", description: "open the spawn-agent form", keyHint: displayChord("mod+o"), run: (ctx) => ctx.openSpawn() },
  // /new remains the direct default-session command; the list button opens routing choices.
  { name: "new", description: "spawn a new chat session on defaults (no form)", run: (ctx) => { void ctx.commands.spawnDefault(); } },
  { name: "permission", description: "toggle ask ⇄ bypass", keyHint: displayChord("mod+p"), run: (ctx) => ctx.commands.cyclePermissionMode() },
];

export function findBuiltin(name: string): BuiltinCommand | undefined {
  return builtinCommands.find((c) => c.name === name);
}

export function builtinSlashEntries(): SlashEntry[] {
  return builtinCommands.map((c) => ({
    name: c.name,
    description: c.description,
    ...(c.keyHint !== undefined ? { keyHint: c.keyHint } : {}),
    source: "builtin" as const,
  }));
}

// ---------------------------------------------------------------------------
// AgentCommands — the rpc-backed command layer (the TUI ChimeraStore port).
// ---------------------------------------------------------------------------

const isUnknownAgent = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  return code === "protocol" && typeof message === "string" && /unknown agent/.test(message);
};

// Phase-1 daemon probe (ui-state/createStore.ts's classifier, byte-for-byte):
// only a POSITIVE unknown-method flips the MAIN-CONDUCTOR-PERSISTENT adoption
// path back to the pre-existing client-side spawn/adopt dance below.
const isUnknownMethod = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  return code === "protocol" && typeof message === "string" && /unknown method/.test(message);
};

export type SpawnInput = {
  prompt: string;
  cwd: string;
  displayLabel?: string;
  account?: string;
  permissionProfile?: string;
  acknowledgeCodexFullAccessRisk?: boolean;
  // ROLE-PERMISSION-REQUEST-STOMPED: SpawnCard's own read of the picked role's
  // on.permissionRequest — set ONLY when the profile field wasn't an explicit override, so
  // spawnAgent can defer to the role instead of its own hardcoded "tui" default. Never set
  // for a free-text role fallback (older daemon, no role.list) or no role at all.
  permissionRequest?: string;
  // AGENT-AUTONOMY: "full" (no human/orchestrator available) or "ask" (the default, unset).
  autonomy?: string;
  conductor?: boolean;
  session?: boolean;
  isolation?: string;
  provider?: string;
  model?: string;
  deliverTo?: string;
  engine?: string;
  maxBudgetUsd?: number;
  // Ad-hoc sessions design §4: session role name, resolved server-side and merged onto the
  // spec BEFORE the fields above — sent as a sibling RPC param, never inside `spec` itself.
  role?: string;
  // SPAWN-SETTING-SOURCES: the friendly on/off surface for AgentSpec.loadSettings (which
  // resolves to inherit.settingSources ["project","user"] / [] server-side). Omitted (the
  // SpawnCard "auto" chip) defers to the spawn's resolved project's own loadProjectSettings
  // toggle, or the picked role's own value — see AgentSpecSchema's own comment, index.ts.
  loadSettings?: boolean;
  executionMode?: "plan" | "execute" | "auto";
  strictMcpConfig?: boolean;
  // CROSS-PROVIDER-MCP-STORE: the spawn form's own control for AgentSpec.orchestration.allow —
  // previously reachable ONLY via agent_spawn's raw `orchestrationAllow` MCP param or a role
  // template, never from either UI's spawn form (SpawnCard.tsx had zero references to
  // "orchestration" at all). Omitted (the "auto" chip) defers to the picked role's own value, or
  // the schema default (false) with no role — same "only submit the non-default/explicit value"
  // idiom as loadSettings above.
  orchestration?: boolean;
  // SPAWN-ROLE-OVERRIDES: the two RoleSpec fields the spawn form could not reach, so a role
  // could be PICKED but not actually tuned for one run. Both ride the same
  // computeRoleSpecOverrides diff as every other field — a value left equal to the role's own
  // default drops out and stays inherited rather than silently becoming pinned.
  effort?: string;
  // The role's system prompt, prefilled from the picked role so it can be tweaked for this one
  // spawn ("same role, but also check X") without editing the shared library entry.
  instructions?: string;
};

export class AgentCommands {
  // TUI-009 port: the in-flight lazy-spawn promise — a concurrent submit
  // awaits it and re-evaluates instead of double-spawning (TOCTOU guard).
  private mainSpawn: Promise<void> | null = null;
  // Deterministic outbox ids (TUI parity — no Math.random).
  private outboxSeq = 0;
  // Flush re-entrancy guard, per agent (TUI flushOutbox port).
  private flushing = new Set<string>();
  private forcedSends = new Map<string, Promise<void>>();

  private serializeForcedSend(agentId: string, send: () => Promise<void>): Promise<void> {
    // Draining an older outbox item awaits an RPC. Another force-send must not
    // overtake the first in that gap, including sends via the main-conductor route.
    const previous = this.forcedSends.get(agentId);
    const operation = previous ? previous.then(send, send) : send();
    const settled = operation.then(() => {}, () => {});
    this.forcedSends.set(agentId, settled);
    void settled.then(() => { if (this.forcedSends.get(agentId) === settled) this.forcedSends.delete(agentId); });
    return operation;
  }
  // Local-echo timestamps per agent, recorded at userSent dispatch time (the
  // W3 "local echo has no timestamp" gap) — merged by mergeEchoTimestamps.
  private echoTs = new Map<string, number[]>();
  private prev: UiState;

  constructor(private store: UiStore, private rpc: RpcFn) {
    this.prev = store.getState();
    // OUTBOX-SURVIVES-RELOAD: outbox items may already be present at
    // construction time (restored from localStorage by store.ts before this
    // class exists). Seed the counter past the highest restored `q<n>` so a
    // freshly-queued item here can never collide with a restored id.
    for (const item of this.prev.outbox) {
      const m = /^q(\d+)$/.exec(item.id);
      if (m) this.outboxSeq = Math.max(this.outboxSeq, Number(m[1]) + 1);
    }
    // Auto-flush FIFO watcher (the TUI store owns this inside dispatch(); the
    // app store is the shared ui-state createStore, so the watcher rides a
    // plain subscription): for every DISTINCT agentId holding outbox items, a
    // busy true→false transition means its turn just ended — flush the head
    // item. One send per transition; flushOutbox never throws.
    store.subscribe(() => {
      const next = store.getState();
      const prev = this.prev;
      this.prev = next;
      const seen = new Set<string>();
      for (const item of next.outbox) {
        if (seen.has(item.agentId)) continue;
        seen.add(item.agentId);
        if (prev.agents[item.agentId]?.busy === true && next.agents[item.agentId]?.busy === false) {
          void this.flushOutbox(item.agentId);
        }
      }
    });
  }

  echoTimestamps(agentId: string): readonly number[] {
    return this.echoTs.get(agentId) ?? [];
  }

  // Command helpers never reject (TUI guarded() port): a failing RPC surfaces
  // as lastError, never an unhandled rejection out of a key handler.
  private async guarded(run: () => Promise<void>): Promise<void> {
    const before = this.store.getState().lastError;
    try {
      await run();
      const s = this.store.getState();
      if (s.lastError !== null && s.lastError === before) {
        this.store.dispatch({ type: "commandError", message: null });
      }
    } catch (err) {
      const message = typeof err === "object" && err !== null && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
      this.store.dispatch({ type: "commandError", message });
    }
  }

  /** Local echo with a Date.now() stamp (userSent has no ts field — the stamp
   * rides this module's echoTs registry, merged into the transcript's
   * timestamp column by mergeEchoTimestamps). */
  private echo(agentId: string, text: string, images?: Image[], content?: ContentBlock[], forced?: boolean): string {
    const messageId = crypto.randomUUID();
    const list = this.echoTs.get(agentId) ?? [];
    list.push(Date.now());
    this.echoTs.set(agentId, list);
    this.store.dispatch({
      type: "userSent", agentId, text, messageId,
      messageOrigin: { from: "app", source: "operator", engineId: "local" },
      ...(images && images.length > 0 ? { images } : {}),
      ...(content && content.length > 0 ? { content } : {}),
      ...(forced ? { forced: true } : {}),
    });
    return messageId;
  }

  /** The composer's default cwd for lazy/main + form spawns. The webview has
   * no process.cwd(); resolution order: the DEV/test seam → Tauri's homeDir()
   * (core:path, granted by core:default) → "~" (degraded; noted in risks). */
  async defaultCwd(): Promise<string> {
    const seam = (globalThis as Record<string, unknown>)["__CHIMERA_CWD__"];
    if (typeof seam === "string" && seam.length > 0) return seam;
    try {
      const { homeDir } = await import("@tauri-apps/api/path");
      return await homeDir();
    } catch {
      return "~";
    }
  }

  /** Send one composed message to `target` (TUI-003: the chip IS the route).
   * Busy running targets hold in the outbox (A1-4); an empty "main" lazily
   * spawns the conductor (A2). FORCE-SEND-MIDTURN: `force` (opt+enter in the
   * composer) skips the hold — see sendToAgent/sendToMain for the mechanics
   * and the flush-outbox-first ordering rule. */
  // SLASH-IS-THE-SIGNAL: `slash` threads through to sendToAgent, which is where the verbatim
  // delivery is decided. It used to be hardcoded false here, so every slash command routed through
  // the composer lost its flag on the way and arrived behind the "[from app] " prefix.
  sendComposed(target: ComposeTarget, text: string, images?: Image[], content?: ContentBlock[], force = false, slash = false): Promise<void> {
    const state = this.store.getState();
    const { ids, lazyMain } = resolveTargetIds(state, target);
    if (lazyMain && slash) {
      this.store.dispatch({ type: "commandError", message: "Select a running agent before sending a slash command" });
      return Promise.resolve();
    }
    if (lazyMain) return this.sendToMain(text, images, force ? { force: true } : undefined, content);
    if (ids.length === 0) {
      this.store.dispatch({ type: "commandError", message: `no running agent for target "${targetLabel(target, null)}"` });
      return Promise.resolve();
    }
    return Promise.all(ids.map((id) => this.sendToAgent(id, text, images, slash, content, force))).then(() => undefined);
  }

  /** Direct send to one agent: hold-while-busy (outbox) or agent.send + echo.
   * An explicit target that no longer exists fails visibly; its message must
   * never be redirected to a different conversation.
   * FORCE-SEND-MIDTURN: `force` (opt+enter) skips the busy-hold and delivers
   * NOW via `agent.send` with explicit force intent. App-server steers the
   * running turn; exec interrupts and resumes the saved session with queued input.
   * Ordering rule: force never jumps ahead of messages the operator
   * already committed to sending — deliverOneQueued drains this agent's
   * existing outbox FIRST, oldest-first, before the forced message itself. */
  sendToAgent(agentId: string, text: string, images?: Image[], slash = false, content?: ContentBlock[], force = false): Promise<void> {
    const send = () => this.sendToAgentNow(agentId, text, images, slash, content, force);
    return force ? this.serializeForcedSend(agentId, send) : send();
  }

  private sendToAgentNow(agentId: string, text: string, images?: Image[], slash = false, content?: ContentBlock[], force = false): Promise<void> {
    return this.guarded(async () => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const v = this.store.getState().agents[agentId];
      const busy = !!(v && v.busy && v.state === "running");
      if (busy && !force && !(slash && v?.provider === "codex")) {
        this.store.dispatch({
          type: "outboxAdd",
          item: {
            id: `q${this.outboxSeq++}`, agentId, text: trimmed,
            ...(images && images.length > 0 ? { images } : {}),
            ...(content && content.length > 0 ? { content } : {}),
            ...(slash ? { slash: true } : {}),
          },
        });
        return;
      }
      if (busy && force) {
        while (this.store.getState().outbox.some((o) => o.agentId === agentId)) {
          await this.deliverOneQueued(agentId);
        }
      }
      const imgs = images && images.length > 0 ? images : undefined;
      const blocks = content && content.length > 0 ? content : undefined;
      // Echo BEFORE the await (mirrors flushOutbox's A1 ordering): userSent
      // flips busy=true synchronously, so a second rapid send arriving before
      // this RPC's ack resolves reads busy=true and queues instead of ALSO
      // taking this direct-send branch (the two would otherwise race the
      // daemon directly, with one send silently lost — the reported bug).
      const messageId = this.echo(agentId, trimmed, imgs, blocks, busy && force);
      try {
        await this.rpc("agent.send", { agentId, text: trimmed, from: "app", messageId, ...(force ? { force: true } : {}), ...(imgs ? { images: imgs } : {}), ...(blocks ? { content: blocks } : {}), ...(slash ? { slash: true } : {}) });
      } catch (err) {
        if (isUnknownAgent(err)) this.store.dispatch({ type: "agentsRemoved", agentIds: [agentId] });
        throw err;
      }
    });
  }

  /** The TUI store's sendToMain port: hold-while-busy → mid-session send →
   * TOCTOU-guarded lazy conductor spawn {conductor:true, isolation:"none"
   * (CRITICAL, coverage A2), orchestration.allow, permission per ◇/◆}.
   * FORCE-SEND-MIDTURN: `opts.force` skips the busy-hold for a live conductor
   * — see sendToAgent's doc comment for the mechanics and ordering rule. */
  sendToMain(text: string, images?: Image[], opts?: { resumeSessionId?: string; force?: boolean }, content?: ContentBlock[]): Promise<void> {
    const send = () => this.sendToMainNow(text, images, opts, content);
    return opts?.force ? this.serializeForcedSend(this.store.getState().mainConductorId ?? "main:spawn", send) : send();
  }

  private sendToMainNow(text: string, images?: Image[], opts?: { resumeSessionId?: string; force?: boolean }, content?: ContentBlock[]): Promise<void> {
    return this.guarded(async () => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const blocks = content && content.length > 0 ? content : undefined;
      const force = opts?.force === true;

      const sendMidSession = async (agentId: string, forced = false): Promise<void> => {
        const imgs = images && images.length > 0 ? images : undefined;
        // Echo BEFORE the await — same race as sendToAgent's direct-send
        // branch (see its comment): busy must flip synchronously so a second
        // rapid send sees it and queues rather than also going mid-session.
        const messageId = this.echo(agentId, trimmed, imgs, blocks, forced);
        await this.rpc("agent.send", { agentId, text: trimmed, from: "app", messageId, ...(force ? { force: true } : {}), ...(imgs ? { images: imgs } : {}), ...(blocks ? { content: blocks } : {}) });
        if (this.store.getState().notice) this.store.dispatch({ type: "notice", message: null });
      };

      const state = this.store.getState();
      const id = state.mainConductorId;
      const view = id !== null ? state.agents[id] : undefined;
      // Hold-while-busy: a live, WORKING conductor queues the message (A1-4) —
      // unless `force` skips the hold (ordering rule: drain this conductor's
      // existing outbox first, oldest-first, THEN deliver the forced message).
      if (id !== null && view?.busy === true && view.state === "running") {
        if (!force) {
          this.store.dispatch({
            type: "outboxAdd",
            item: { id: `q${this.outboxSeq++}`, agentId: id, text: trimmed, ...(images && images.length > 0 ? { images } : {}), ...(blocks ? { content: blocks } : {}) },
          });
          return;
        }
        while (this.store.getState().outbox.some((o) => o.agentId === id)) {
          await this.deliverOneQueued(id);
        }
        await sendMidSession(id, true);
        return;
      }
      const noLongerRunning = id === null || (view !== undefined && view.state !== "running");
      if (!noLongerRunning && id !== null) {
        try {
          await sendMidSession(id);
          return;
        } catch (err) {
          if (!isUnknownAgent(err)) throw err;
          this.store.dispatch({ type: "mainConductorId", agentId: null });
        }
      }

      // TUI-009 TOCTOU guard: a lazy spawn is already in flight — await IT,
      // then deliver mid-session (the conductor exists once it resolves).
      if (this.mainSpawn) {
        await this.mainSpawn;
        await sendMidSession(this.store.getState().mainConductorId!);
        return;
      }

      const resumeSessionId = opts?.resumeSessionId ?? (id !== null ? this.store.getState().agents[id]?.sessionId : undefined);
      // TUI-011 port: conductor mode needs a claude-provider account.
      const conductorAccount = this.store.getState().accounts.find((a) => a.provider === "claude")?.name;
      const bypass = this.store.getState().permissionMode === "bypass";
      // NOTE (TUI-009): NO await between the `this.mainSpawn` check above and
      // the assignment below — the async cwd resolution happens INSIDE the
      // guarded closure, or two rapid submits could both observe "no spawn in
      // flight" and double-spawn.
      this.mainSpawn = (async () => {
        // ONBOARDING-GATE R3 (MAIN-CONDUCTOR-PERSISTENT): ask the daemon for
        // its ONE canonical, persistent MAIN conductor seat instead of lazily
        // spawning a fresh one — main.conductor.ensure returns the live seat
        // (already spawned daemon-side on the first account, or spawned here
        // on demand), so the compose box adopts THAT agent rather than
        // creating a second ad-hoc conductor. The seat itself is spawned
        // resumeOnly with a placeholder prompt (engine.ts), so this message
        // is always delivered as a genuine mid-session turn. Falls back to
        // the pre-existing client-side adopt/spawn dance only when the
        // daemon doesn't know the RPC yet (older daemon).
        try {
          const record = await this.rpc<{ agentId: string }>("main.conductor.ensure", {});
          this.store.dispatch({ type: "mainConductorId", agentId: record.agentId });
          this.store.dispatch({ type: "selectAgent", agentId: record.agentId });
          this.store.dispatch({ type: "selectTab", tab: "agents" });
          await sendMidSession(record.agentId);
          return;
        } catch (err) {
          if (!isUnknownMethod(err)) throw err;
        }

        // FALLBACK (older daemon, pre MAIN-CONDUCTOR-PERSISTENT) — adopt a
        // re-attached running conductor before spawning a second one (TUI
        // Task RA1 port).
        const live = Object.values(this.store.getState().agents)
          .filter((a) => a.conductor === true && a.state === "running" && a.agentId !== id)
          .sort((a, b) => (b.lastEventTs ?? 0) - (a.lastEventTs ?? 0))[0];
        if (live) {
          this.store.dispatch({ type: "mainConductorId", agentId: live.agentId });
          // Hold-while-busy applies to the ADOPTED conductor too: the guard at
          // the top only saw the old mainConductorId, so an adopted conductor
          // (e.g. surfaced by a restart-resume reconnect before this session set
          // mainConductorId) that is mid-turn must queue, not bypass the outbox.
          // FORCE-SEND-MIDTURN: `force` is NOT honored on this pre-persistent-
          // conductor fallback (only reachable against a daemon predating
          // MAIN-CONDUCTOR-PERSISTENT) — a known, narrow gap rather than risking
          // a rushed fix on a codepath this rare.
          if (live.busy === true && live.state === "running") {
            this.store.dispatch({
              type: "outboxAdd",
              item: { id: `q${this.outboxSeq++}`, agentId: live.agentId, text: trimmed, ...(images && images.length > 0 ? { images } : {}), ...(blocks ? { content: blocks } : {}) },
            });
            return;
          }
          try {
            await sendMidSession(live.agentId);
            return;
          } catch (err) {
            if (!isUnknownAgent(err)) throw err;
            this.store.dispatch({ type: "mainConductorId", agentId: null });
          }
        }

        const cwd = await this.defaultCwd();
        const spec: Record<string, unknown> = {
          prompt: trimmed,
          // D9: an inline-tagged first message threads its content[] straight
          // into the spawn spec (the SDK builds the initial message from these
          // blocks) instead of TUI-019's old spawn-then-follow-up-image-send.
          ...(blocks ? { content: blocks } : {}),
          cwd,
          conductor: true,
          isolation: "none",         // CRITICAL (coverage A2): the conductor works in the REAL repo
          orchestration: { allow: true },
          // CONDUCTOR_PLAYBOOK (protocol): the shared capability map + operating
          // rules every conductor gets — one source of truth with the TUI's
          // conductor and engine.ts's per-project conductor.
          // PROMPT-CACHE-PREFIX: playbook FIRST, session line last. Must stay byte-identical to
          // core's MAIN_CONDUCTOR_INSTRUCTIONS (engine.ts) — the two spawn paths only share a
          // provider prefix cache while these two strings agree exactly.
          instructions: `${CONDUCTOR_PLAYBOOK}\n\nYou are the Chimera MAIN session (the top-level conductor).`,
          on: { permissionRequest: bypass ? "auto" : "tui" },
          permissionProfile: bypass ? "full" : "acceptEdits",
          ...(bypass ? { acknowledgeCodexFullAccessRisk: true } : {}),
          ...(conductorAccount ? { account: conductorAccount } : {}),
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        };
        const result = await this.rpc<{ agentId: string }>("agent.spawn", { spec });
        this.store.dispatch({ type: "mainConductorId", agentId: result.agentId });
        this.store.dispatch({ type: "selectAgent", agentId: result.agentId });
        this.store.dispatch({ type: "selectTab", tab: "agents" });
        // Echo the first message as a "you" turn (TUI-022; reducer upserts).
        this.echo(result.agentId, trimmed, images && images.length > 0 ? images : undefined, blocks);
        // TUI-019: pre-D9 legacy path — a spawn spec with no content[] can't
        // carry images either, so deliver them right after. A spawn that
        // already threaded `blocks` into spec.content above skips this.
        if (!blocks && images && images.length > 0) {
          await this.rpc("agent.send", { agentId: result.agentId, text: "(image)", from: "app", images });
        }
      })();
      try {
        await this.mainSpawn;
      } finally {
        this.mainSpawn = null;
      }
    });
  }

  /** Preserve command intent; the daemon selects native controls or validates
   * the connected SDK's commands. Slash text must never silently become prose. */
  sendSlash(target: ComposeTarget, name: string, args: string): Promise<void> {
    const text = `/${name}${args ? " " + args : ""}`.trim();
    return this.sendComposed(target, text, undefined, undefined, false, true);
  }

  /** mod+u — pop the LAST queued item for `agentId` back into the composer
   * (returns its text; a non-empty current draft is re-queued first, the TUI
   * EDITQUEUE port). null when nothing is queued. A chip CLICK passes the
   * clicked item's id instead (W4 review: clicking chip 1 must edit chip 1,
   * not silently pull the last). */
  /** Pull a queued message back into the composer, swapping in whatever is currently typed.
   *
   *  Returns the full compose STATE, not just text: a queued image message has to come back with
   *  its images, or editing it silently drops them (IMAGE-EDIT-LOSES-IMAGE). `currentDraft` goes
   *  back on the queue with ITS images for the same reason — swapping two drafts must not be a
   *  way to lose one of them. */
  popQueued(
    agentId: string,
    currentDraft: { text: string; images?: Image[]; content?: ContentBlock[] },
    itemId?: string,
  ): { text: string; images: PendingImage[]; nextNum: number } | null {
    const items = this.store.getState().outbox.filter((o) => o.agentId === agentId);
    const picked = itemId ? items.find((o) => o.id === itemId) : items[items.length - 1];
    if (!picked) return null;
    if (currentDraft.text.trim()) {
      this.store.dispatch({
        type: "outboxAdd",
        item: {
          id: `q${this.outboxSeq++}`, agentId, text: currentDraft.text,
          ...(currentDraft.images && currentDraft.images.length > 0 ? { images: currentDraft.images } : {}),
          ...(currentDraft.content && currentDraft.content.length > 0 ? { content: currentDraft.content } : {}),
        },
      });
    }
    this.store.dispatch({ type: "outboxRemove", id: picked.id });
    return draftFromOutbox(picked, 1);
  }

  dropLastQueued(agentId: string): void {
    const items = this.store.getState().outbox.filter((o) => o.agentId === agentId);
    const last = items[items.length - 1];
    if (last) this.store.dispatch({ type: "outboxRemove", id: last.id });
  }

  // Send the HEAD queued item for `agentId` (oldest first), if any. Shared by
  // flushOutbox (one per busy→idle transition) and the FORCE-SEND-MIDTURN
  // ordering rule (drain the whole outbox up front, oldest-first, before a
  // forced message) — a failed send is surfaced + dropped so it is never
  // silently retried forever.
  //
  // A1 (coverage §A1 ordering): the optimistic echo + outboxRemove + busy=true
  // (userSent sets busy) are applied SYNCHRONOUSLY, BEFORE the agent.send await
  // resolves. Were they deferred until the ack, this same message's own turn
  // (streamed back over the SSE subscription) could land assistant tokens /
  // turn_complete in the transcript AHEAD of its own "you" echo — mis-ordering
  // the transcript on a slow ack. Echoing first pins the "you" turn ahead of
  // any reply. On a send failure we reconcile by surfacing the error (the item
  // is already dropped — never silently retried forever).
  private async deliverOneQueued(agentId: string): Promise<void> {
    const item = this.store.getState().outbox.find((o) => o.agentId === agentId);
    if (!item) return;
    const imgs = item.images && item.images.length > 0 ? item.images : undefined;
    const blocks = item.content && item.content.length > 0 ? item.content : undefined;
    // Optimistic ordering: echo the "you" turn + drop the queued item NOW,
    // before the await, mirroring the non-queued send path's local echo.
    const messageId = this.echo(agentId, item.text, imgs, blocks);
    this.store.dispatch({ type: "outboxRemove", id: item.id });
    try {
      await this.rpc("agent.send", { agentId, text: item.text, from: "app", messageId, ...(imgs ? { images: imgs } : {}), ...(blocks ? { content: blocks } : {}), ...(item.slash ? { slash: true } : {}) });
    } catch (err) {
      const message = typeof err === "object" && err !== null && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
      this.store.dispatch({ type: "commandError", message });
    }
  }

  private async flushOutbox(agentId: string): Promise<void> {
    if (this.flushing.has(agentId)) return;
    this.flushing.add(agentId);
    try {
      await this.deliverOneQueued(agentId);
    } finally {
      this.flushing.delete(agentId);
    }
  }

  /** mod+y / mod+j (+ bare y/n, click) → agent.permissionRespond. The card
   * renders visiblePermission (first NON-dismissed), so the answer must target
   * that same request — callers pass its requestId (W4 review MAJOR: answering
   * pendingPermissions[0] while an earlier esc-'later'-dismissed request still
   * sat at [0] responded to the WRONG request). The [0] fallback only serves
   * requestId-less callers, which by construction have no dismissed set. */
  answerPermission(allow: boolean, requestId?: string): Promise<void> {
    return this.guarded(async () => {
      const pending = requestId
        ? this.store.getState().pendingPermissions.find((p) => p.requestId === requestId)
        : this.store.getState().pendingPermissions[0];
      if (!pending) return;
      await this.rpc("agent.permissionRespond", { requestId: pending.requestId, allow });
      this.store.dispatch({ type: "permissionAnswered", requestId: pending.requestId });
    });
  }

  /** ALWAYS-ALLOW-UI — persist THEN answer. host.setPolicy writes the toolPolicy
   * rule (the "*" wildcard row — MCP calls carry no CLI profile) BEFORE the
   * respond, so a second identical MCP call arriving in between can't slip through
   * before the rule lands (and re-ask). scope "tool" = exact tool key
   * (mcp__server__tool); "server" = the server key (governs every tool of that
   * server). Only reachable for MCP asks — the card gates the chips to them. */
  answerPermissionPersist(scope: "tool" | "server", allow: boolean, requestId?: string): Promise<void> {
    return this.guarded(async () => {
      const pending = requestId
        ? this.store.getState().pendingPermissions.find((p) => p.requestId === requestId)
        : this.store.getState().pendingPermissions[0];
      if (!pending) return;
      const key = scope === "server" ? mcpServerKey(pending.toolName) : pending.toolName;
      await this.rpc("host.setPolicy", { tool: key, profile: "*", mode: allow ? "allow" : "deny" });
      await this.rpc("agent.permissionRespond", { requestId: pending.requestId, allow });
      this.store.dispatch({ type: "permissionAnswered", requestId: pending.requestId });
    });
  }

  /** enter on the QuestionCard → agent.answerQuestion {questionId, answer};
   * explicit agentId/questionId so the VISIBLE (possibly not first) question
   * is the one answered — cross-agent per TUI-004. */
  answerQuestion(agentId: string, questionId: string, answer: { optionIds?: string[]; text?: string }): Promise<void> {
    return this.guarded(async () => {
      await this.rpc("agent.answerQuestion", { questionId, answer });
      this.store.dispatch({ type: "questionAnswered", agentId, questionId });
    });
  }

  /** DialogCard submit/cancel → agent.answerDialog {dialogId, decision}. Unlike
   * answerQuestion this carries no agentId (the reducer's "dialogAnswered"
   * case finds whichever agent's pendingDialog matches the id — DLG3 parity
   * with the TUI's store.answerDialog). */
  answerDialog(dialogId: string, decision: DialogDecision): Promise<void> {
    return this.guarded(async () => {
      await this.rpc("agent.answerDialog", { dialogId, decision });
      this.store.dispatch({ type: "dialogAnswered", dialogId });
    });
  }

  /** SpawnCard submit — only the FILLED fields reach the spec (B6). The spec
   * also records the CURRENT ◇/◆ mode (A3-5: "spawn formu da o anki modu
   * spec'e yazar"); isolation defaults "none" (TUI-002 CRITICAL). */
  spawnAgent(input: SpawnInput): Promise<void> {
    return this.guarded(async () => {
      const bypass = this.store.getState().permissionMode === "bypass";
      // READONLY-BASH-NO-PROMPT: on.permissionRequest used to key off `bypass` (the
      // session-wide toggle) ONLY, independent of the profile actually being sent for THIS
      // spawn — so picking permissionProfile "full" for one agent while the global toggle
      // stayed off (the normal case) silently kept routing every tool call to a card,
      // defeating "full"'s documented no-prompts promise. Derive from the SAME effective
      // profile decided below instead.
      const effectiveProfile = input.permissionProfile ?? (bypass ? "full" : undefined);
      // ROLE-PERMISSION-REQUEST-STOMPED: the gap READONLY-BASH-NO-PROMPT left open — a role
      // picked with the profile field left blank has no explicit signal in effectiveProfile
      // either, yet used to get `on: {permissionRequest: "tui"}` stamped unconditionally,
      // discarding the role's own declared value (e.g. "auto"). SpawnCard.tsx now reads the
      // picked role's own on.permissionRequest and threads it through as
      // input.permissionRequest whenever the profile field wasn't an explicit override (same
      // gate computeRoleSpecOverrides already uses for permissionProfile itself) — an
      // explicit profile (typed by the operator) or the bypass toggle still wins via
      // effectiveProfile, exactly as before; only the "no explicit signal" gap now defers to
      // the role instead of a hardcoded "tui".
      const spec: Record<string, unknown> = {
        prompt: input.prompt,
        cwd: input.cwd,
        ...(input.displayLabel ? { displayLabel: input.displayLabel } : {}),
        on: { permissionRequest: effectiveProfile ? (effectiveProfile === "full" ? "auto" : "tui") : (input.permissionRequest ?? "tui") },
        isolation: input.isolation ?? "none",
        ...(input.account ? { account: input.account } : {}),
        ...(effectiveProfile ? { permissionProfile: effectiveProfile } : {}),
        // Operator full/bypass is an explicit unsandboxed choice, including
        // auto-account resolution. Never infer this from autonomy or a role's
        // hidden defaults; retain the daemon guard for non-UI/API callers.
        ...(effectiveProfile === "full" || !effectiveProfile && input.acknowledgeCodexFullAccessRisk === true ? { acknowledgeCodexFullAccessRisk: true } : {}),
        ...(input.autonomy ? { autonomy: input.autonomy } : {}),
        ...(input.conductor ? { conductor: true } : {}),
        ...(input.session ? { session: true } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...(input.deliverTo ? { deliverTo: input.deliverTo } : {}),
        ...(input.maxBudgetUsd != null ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
        ...(input.loadSettings !== undefined ? { loadSettings: input.loadSettings } : {}),
        ...(input.executionMode ? { executionMode: input.executionMode } : {}),
        ...(input.strictMcpConfig !== undefined ? { strictMcpConfig: input.strictMcpConfig } : {}),
        ...(input.orchestration !== undefined ? { orchestration: { allow: input.orchestration } } : {}),
        // AGENT-GROUPS Phase 1: a spawn triggered while a group box is focused silently
        // inherits it — no mandatory picker on the spawn form (that would defeat the
        // zero-friction path spawnDefault below protects). Explicit spawn-time picker is
        // Phase 2.
        ...(this.store.getState().activeGroupId ? { groups: [this.store.getState().activeGroupId] } : {}),
      };
      await this.rpc("agent.spawn", {
        spec,
        ...(input.engine ? { engine: input.engine } : {}),
        ...(input.role ? { role: input.role } : {}),
      });
    });
  }

  /** Open a fresh, idle session with quick-spawn defaults and optional routing choices.
   * resumeOnly avoids sending a synthetic first turn; orchestration enables rename_self. */
  spawnDefault(selection: { provider?: string; account?: string; model?: string } = {}): Promise<void> {
    return this.guarded(async () => {
      const cwd = await this.defaultCwd();
      const bypass = this.store.getState().permissionMode === "bypass";
      const spec: Record<string, unknown> = {
        prompt: DEFAULT_SESSION_PLACEHOLDER_PROMPT,
        cwd,
        ...(selection.provider ? { provider: selection.provider } : {}),
        ...(selection.account ? { account: selection.account } : {}),
        ...(selection.model ? { model: selection.model } : {}),
        isolation: "none",
        session: true,
        // Quick-spawn sessions need room for sustained work without changing
        // the operator's separate permission/sandbox profile.
        autonomy: "full",
        compactionThreshold: 500_000,
        maxTurns: 120,
        orchestration: { allow: true },
        // Interactive sessions need the operator's native plugins alongside our
        // injected Chimera server; settings alone would still be masked by lean MCP mode.
        loadSettings: true,
        strictMcpConfig: false,
        instructions: DEFAULT_SESSION_INSTRUCTIONS,
        on: { permissionRequest: bypass ? "auto" : "tui" },
        ...(bypass ? { permissionProfile: "full", acknowledgeCodexFullAccessRisk: true } : {}),
        resume: null,
        resumeOnly: true,
        // AGENT-GROUPS Phase 1: same inheritance as spawnAgent above.
        ...(this.store.getState().activeGroupId ? { groups: [this.store.getState().activeGroupId] } : {}),
      };
      const result = await this.rpc<{ agentId: string }>("agent.spawn", { spec });
      this.store.dispatch({ type: "selectAgent", agentId: result.agentId });
      this.store.dispatch({ type: "selectTab", tab: "agents" });
    });
  }

  killSelected(): Promise<void> {
    return this.guarded(async () => {
      const agentId = this.store.getState().selectedAgentId;
      if (!agentId) return;
      await this.killOrDismiss(agentId);
    });
  }

  /** OPERATOR-RENAME: rename any agent, any number of times. The daemon's one-shot guard is for
   * an agent naming ITSELF (rename_self) — it protects the operator's choice from the agent, so
   * it must not apply to the operator, who otherwise could never correct a name a quick-spawned
   * agent gave itself. Omitting `self` is what says "a person is asking". */
  renameAgent(agentId: string, displayLabel: string): Promise<void> {
    const name = displayLabel.trim();
    return this.guarded(async () => {
      if (name.length === 0) return;
      await this.rpc("agent.rename", { agentId, displayLabel: name });
      // The daemon re-emits a `status` event carrying the new label, so the roster updates
      // itself — no refetch, matching how setGroups/jobName already propagate.
    });
  }

  /** AGENT-RESUME-UI: pick a finished agent back up where it stopped.
   *
   *  agent.resume has existed as an RPC and an MCP tool since terminal agents did, but nothing in
   *  the app called it — so an operator coming back to a fleet that finished overnight could see
   *  every agent and restart none of them without dropping to the command palette's raw-RPC form.
   *
   *  The daemon owns every refusal (not terminal, workdir gone), so this deliberately pre-checks
   *  nothing: a guess here would either duplicate that logic or contradict it. The daemon's own
   *  message is what surfaces, which is the one that knows why.
   *
   *  A resume needs a BRIEF — it continues the session with new instructions, it does not replay
   *  the old prompt — so the caller supplies one. */
  async resumeAgent(agentId: string, prompt: string): Promise<boolean> {
    try {
      await this.rpc("agent.resume", { agentId, prompt });
      return true;
    } catch (err) {
      this.store.dispatch({ type: "notice", message: `resume failed: ${err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err)}` });
      return false;
    }
  }

  /** Release ONE held agent — the paused half of "resume". Shares agent.release with the batch
   *  path (it has always taken an array), so there is one release, not two. */
  async releaseAgent(agentId: string): Promise<boolean> {
    return this.batch("agent.release", { agentIds: [agentId] }, "released");
  }

  /** AGENT-MARK batch ops. One shape for all of them, because they differ only in the RPC.
   *
   *  Every batch RPC answers {requested, succeeded, failed[]} rather than throwing on the first
   *  refusal — partial success is the NORMAL outcome of a fan-out (one agent finished, another is
   *  already held), and a caller told only "it failed" would not know which of the rest went
   *  through. The notice reports both halves for the same reason. */
  private async batch(rpc: string, params: Record<string, unknown>, verb: string): Promise<boolean> {
    try {
      const res = await this.rpc<{
        succeeded?: string[]; failed?: Array<{ agentId: string; error: string }>;
        held?: string[]; released?: string[]; skipped?: Array<{ agentId: string; state: string }>;
      }>(rpc, params);
      // TWO RESULT SHAPES, deliberately read here rather than normalised in the daemon: killMany
      // and resumeMany answer {succeeded, failed[{error}]}, while hold and release — which predate
      // them — answer {held|released, skipped[{state}]}. Reading only the first would have made
      // every hold report "0 agents" while quietly working, which is worse than an error.
      const ok = (res?.succeeded ?? res?.held ?? res?.released ?? []).length;
      const bad = res?.failed ?? (res?.skipped ?? []).map((sk) => ({ agentId: sk.agentId, error: sk.state }));
      this.store.dispatch({
        type: "notice",
        message: bad.length === 0
          ? `${verb} ${ok} agent${ok === 1 ? "" : "s"}`
          // Name the FIRST refusal rather than only counting them: "3 failed" sends the operator
          // hunting, and the reasons in a fan-out are usually all the same one.
          : `${verb} ${ok}, ${bad.length} refused — ${bad[0]!.error}`,
      });
      return bad.length === 0;
    } catch (err) {
      this.store.dispatch({ type: "notice", message: `${verb} failed: ${err instanceof Error ? err.message : String(err)}` });
      return false;
    }
  }

  /** Operator-requested retry of an unconfirmed prompt. Check the daemon's current
   *  delivery before repeating it: missing output does not prove missing input. */
  async resendStalledPrompt(agentId: string): Promise<boolean> {
    const stall = this.store.getState().agents[agentId]?.promptStall;
    if (!stall) {
      this.store.dispatch({ type: "notice", message: "no unacknowledged prompt on this agent" });
      return false;
    }
    if (!stall.text) {
      // Never synthesize a message on the operator's behalf — say so and let them type one.
      this.store.dispatch({ type: "notice", message: "original prompt text unavailable — type a nudge instead" });
      return false;
    }
    // The badge may be stale by the time the operator clicks it. A late start
    // must not turn that click into a duplicate prompt plus a forced interruption.
    try {
      const current = await this.rpc<{ promptStall?: { deliveryId: string } | null }>("agent.status", { agentId });
      if (!current.promptStall || current.promptStall.deliveryId !== stall.deliveryId) {
        this.store.dispatch({ type: "notice", message: "this prompt is no longer waiting for start confirmation — not resent" });
        return false;
      }
    } catch {
      this.store.dispatch({ type: "notice", message: "could not verify the pending prompt — not resent" });
      return false;
    }
    await this.sendToAgent(agentId, stall.text, undefined, false, undefined, true);
    this.store.dispatch({ type: "notice", message: `resent to ${agentId.slice(0, 8)} — repeated the unconfirmed prompt` });
    return true;
  }

  /** Apply one operation to every MARKED agent. The mark set is cleared only for the operations
   *  that end an agent's life — after a kill the rows are gone, so keeping them ticked would leave
   *  a selection pointing at nothing; after a hold or a send the same set is usually wanted again. */
  async runOnMarked(op: "kill" | "hold" | "release" | "resume", prompt?: string): Promise<void> {
    const agentIds = [...this.store.getState().markedAgentIds];
    if (agentIds.length === 0) {
      this.store.dispatch({ type: "notice", message: "nothing marked — tick some agents first" });
      return;
    }
    switch (op) {
      case "kill":
        await this.batch("agent.killMany", { agentIds }, "killed");
        this.store.dispatch({ type: "clearAgentMarks" });
        return;
      case "hold": await this.batch("agent.hold", { agentIds }, "held"); return;
      case "release": await this.batch("agent.release", { agentIds }, "released"); return;
      case "resume":
        await this.batch("agent.resumeMany", { agentIds, prompt: prompt?.trim() || "Continue where you left off." }, "resumed");
        return;
    }
  }

  killAgent(agentId: string): Promise<void> {
    return this.guarded(async () => {
      await this.killOrDismiss(agentId);
    });
  }

  /** DISMISS-A-FINISHED-AGENT: ✕ means "make this row go away". For a live agent that is a kill.
   * For one that has already finished it cannot be — `agent.kill` on a terminal record is an
   * honest no-op — and that left a finished SESSION row permanently undismissable: the sessions
   * bucket is exempt from the hide-done filter until the row reaches `killed`
   * (filterOrderForActive), which a session that ended on its own can never do. The only state
   * that would hide it was one it could no longer reach. So ✕ on a terminal agent FORGETS that
   * one record instead — the same terminal-only sweep the "clean up finished" button runs,
   * narrowed to a single id. Running/paused agents never take this path. */
  private async killOrDismiss(agentId: string): Promise<void> {
    const agent = this.store.getState().agents[agentId];
    const terminal = agent !== undefined && (agent.state === "done" || agent.state === "failed" || agent.state === "killed");
    if (!terminal) {
      await this.rpc("agent.kill", { agentId });
      // Reconcile from the daemon after kill, even if the event stream is delayed.
      // Keep history; the active-list filter hides killed records.
      const sinceSeq = this.store.getState().lastSeq;
      const records = await this.rpc<unknown[]>("agent.list", { lite: true });
      if (Array.isArray(records)) this.store.dispatch({ type: "agentRecords", records: records as never, sinceSeq });
      if (this.store.getState().selectedAgentId === agentId) this.store.dispatch({ type: "selectAgent", agentId: null });
      return;
    }
    try {
      await this.rpc("agent.forget", { agentIds: [agentId] });
    } catch (err) {
      if (isUnknownMethod(err)) {
        this.store.dispatch({
          type: "commandError",
          message: "this daemon predates dismissing a finished agent — restart chimerad to pick it up",
        });
        return;
      }
      throw err;
    }
    const sinceSeq = this.store.getState().lastSeq;
    const records = await this.rpc<unknown[]>("agent.list", { lite: true });
    this.store.dispatch({ type: "agentRecords", records: records as never, sinceSeq });
  }

  /** Ad-hoc sessions design §6 "close all sessions" — leaves project conductors untouched
   * (filters strictly on `session === true`, never touches an agent without the marker). */
  /** PURGE-TERMINAL-SESSIONS: the cleanup counterpart of closeAllSessions — that one ENDS live
   * sessions, this one FORGETS finished ones and reclaims their disk. Terminal-only server-side;
   * nothing here needs to filter, and nothing here can widen it. */
  purgeTerminalSessions(): Promise<void> {
    return this.guarded(async () => {
      try {
        await this.rpc("agent.purgeTerminal", {});
      } catch (err) {
        // OLDER-DAEMON-TOLERANCE: the app can be rebuilt while the daemon is still running the
        // previous build, and then this button reports a raw `unknown method` — which reads as a
        // broken feature rather than a stale daemon. Say what it actually is. Same
        // isUnknownMethod probe the store's own Phase-2 tolerance uses.
        if (isUnknownMethod(err)) {
          this.store.dispatch({
            type: "commandError",
            message: "this daemon predates 'clean up finished' — restart chimerad to pick it up",
          });
          return;
        }
        throw err;
      }
      const sinceSeq = this.store.getState().lastSeq;
      const records = await this.rpc<unknown[]>("agent.list", { lite: true });
      this.store.dispatch({ type: "agentRecords", records: records as never, sinceSeq });
    });
  }

  /** F47: mark agents read — the ONLY writer of reviewedAt. No agent.list refetch: the daemon
   * emits a status event per marked agent carrying the new reviewedAt, which the reducer folds,
   * so a refetch would only race the stream it duplicates. */
  markSeen(agentIds: string[], opts: { skipUnknown?: boolean } = {}): Promise<void> {
    return this.guarded(async () => {
      if (agentIds.length === 0) return;
      // MARK-SEEN-CHUNKING: "mark all seen" sweeps the whole fleet, but the RPC validates
      // all-or-nothing at AGENT_MARK_SEEN_MAX_IDS — one oversized call is rejected whole and
      // stamps NOTHING, so the biggest fleets are exactly the ones the button would fail on.
      let marked = 0;
      for (let i = 0; i < agentIds.length; i += AGENT_MARK_SEEN_MAX_IDS) {
        const chunk = agentIds.slice(i, i + AGENT_MARK_SEEN_MAX_IDS);
        try {
          await this.rpc("agent.markSeen", {
            agentIds: chunk,
            ...(opts.skipUnknown === true ? { skipUnknown: true } : {}),
          });
        } catch (err) {
          // OLDER-DAEMON-TOLERANCE, same shape as purgeTerminalSessions: a stale daemon must read
          // as stale, not as a broken badge.
          if (isUnknownMethod(err)) {
            this.store.dispatch({
              type: "commandError",
              message: "this daemon predates seen state — restart chimerad to pick it up",
            });
            return;
          }
          // F47.FIX M-2: the sweep is chunked, so it is NOT atomic — chunk N failing leaves
          // 1..N-1 stamped with no rollback. Retry ONLY the failed chunk, and only when we asked
          // for `skipUnknown`: a daemon predating that param rejects the call on its strict
          // schema (as an unknown KEY, not an unknown method), and the plain call is what it
          // understands. If that fails too, report the boundary — a bare error here would read as
          // "nothing got marked", which is false and sends the operator hunting the wrong bug.
          if (opts.skipUnknown === true) {
            try {
              await this.rpc("agent.markSeen", { agentIds: chunk });
              marked += chunk.length;
              continue;
            } catch { /* fall through to the boundary report below */ }
          }
          throw new Error(`marked ${marked} of ${agentIds.length} agents, then failed: ${errorToText(err)}`);
        }
        marked += chunk.length;
      }
    });
  }

  /** F22.UI — worktree.leaseHandoff/leaseRelease succeed SILENTLY: the daemon emits no event
   * for either, and the desktop app fetches agent.list exactly once at bootstrap, so without the
   * client-local transcript line below the operator would take a worktree away from a running
   * agent and see nothing at all happen. The failure is written to the transcript too (not just
   * the transient error bar), because "did my handoff land?" must stay answerable in scrollback. */
  worktreeLeaseHandoff(agentId: string, workdirKey: string, toAgentId: string, toLabel: string): Promise<void> {
    return this.guarded(async () => {
      try {
        await this.rpc("worktree.leaseHandoff", { workdirKey, toAgentId });
      } catch (err) {
        this.store.dispatch({ type: "agentSystemLine", agentId,
          text: `⌂ worktree lease handoff FAILED — ${workdirKey} → ${toLabel}: ${err instanceof Error ? err.message : String(err)}` });
        throw err;
      }
      this.store.dispatch({ type: "agentSystemLine", agentId,
        text: `⌂ worktree lease handed off — ${workdirKey} → ${toLabel} (this agent's next write here is refused)` });
      this.store.dispatch({ type: "agentLeaseHeld", agentId, held: false });
    });
  }

  worktreeLeaseRelease(agentId: string, workdirKey: string, force: boolean): Promise<void> {
    return this.guarded(async () => {
      try {
        await this.rpc("worktree.leaseRelease", { workdirKey, force });
      } catch (err) {
        this.store.dispatch({ type: "agentSystemLine", agentId,
          text: `⌂ worktree lease release FAILED — ${workdirKey}: ${err instanceof Error ? err.message : String(err)}` });
        throw err;
      }
      this.store.dispatch({ type: "agentSystemLine", agentId,
        text: `⌂ worktree lease released — ${workdirKey}${force ? " (forced)" : ""} · the next agent to write there takes it` });
      this.store.dispatch({ type: "agentLeaseHeld", agentId, held: false });
    });
  }

  closeAllSessions(): Promise<void> {
    return this.guarded(async () => {
      const state = this.store.getState();
      const ids = Object.values(state.agents)
        .filter((a) => a.session && (a.state === "running" || a.state === "paused"))
        .map((a) => a.agentId);
      if (ids.length === 0) return;
      await this.rpc("agent.killMany", { agentIds: ids });
    });
  }

  /** mod+shift+w (DESTROY — ending the session isn't casually undoable) —
   * agent.close(main); the NEXT enter lazily respawns (A2-3). */
  closeMain(): Promise<void> {
    return this.guarded(async () => {
      const id = this.store.getState().mainConductorId;
      if (!id) return;
      await this.rpc("agent.close", { agentId: id });
      this.store.dispatch({ type: "mainConductorId", agentId: null });
    });
  }

  /** esc tier 10 — non-destructive turn interrupt of the selected agent. */
  interruptSelected(): Promise<void> {
    return this.guarded(async () => {
      const agentId = this.store.getState().selectedAgentId;
      if (!agentId) return;
      await this.rpc("agent.interrupt", { agentId });
    });
  }

  /** Fleet actions snapshot and de-duplicate targets before the first await,
   * so a concurrent selection change can never retarget an operation. */
  bulkInterrupt(agentIds: readonly string[]): Promise<void> {
    const ids = [...new Set(agentIds)].filter((id) => this.store.getState().agents[id]?.state === "running");
    return this.guarded(async () => {
      if (ids.length === 0) return;
      const result = await this.rpc<{ failed?: unknown[] }>("agent.interruptMany", { agentIds: ids });
      const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
      if (failed) throw new Error(`${failed} of ${ids.length} interrupts failed`);
    });
  }

  /** OPERATOR-HOLD: hold the selected agents — abort the in-flight turn, requeue that turn's own
   * input, park the session. Held agents stop and stay stopped: mail does not wake them, the idle
   * reaper leaves them alone, and nothing is lost. Release resumes each session with full context
   * and delivers what queued, so the aborted turn runs again.
   *
   * This used to just call bulkInterrupt and drop the liveboard lane, under the name "pause" —
   * which aborted the turn and then let the agent carry straight on. The button said hold and the
   * fleet kept working. */
  bulkPause(agentIds: readonly string[]): Promise<void> {
    const ids = [...new Set(agentIds)].filter((id) => this.store.getState().agents[id]?.state === "running");
    return this.guarded(async () => {
      if (ids.length === 0) return;
      for (const agentId of ids) this.store.dispatch({ type: "liveboardLaneFollow", agentId, follow: false });
      const r = await this.rpc<{ held?: string[]; skipped?: unknown[] }>("agent.hold", { agentIds: ids });
      const held = r?.held?.length ?? 0;
      this.store.dispatch({
        type: "notice",
        message: held === ids.length
          ? `held ${held} agent(s) — release to resume; nothing is lost`
          : `held ${held} of ${ids.length} (the rest were not running)`,
      });
      await this.refreshAgents();
    });
  }

  /** The other half: resume every held agent in the selection. */
  bulkRelease(agentIds: readonly string[]): Promise<void> {
    const ids = [...new Set(agentIds)].filter((id) => {
      const a = this.store.getState().agents[id];
      return a?.state === "paused";
    });
    return this.guarded(async () => {
      if (ids.length === 0) return;
      const r = await this.rpc<{ released?: string[] }>("agent.release", { agentIds: ids });
      const released = r?.released?.length ?? 0;
      this.store.dispatch({
        type: "notice",
        message: released === ids.length
          ? `released ${released} agent(s) — resuming with full context`
          : `released ${released} of ${ids.length} (the rest were paused for another reason and were left alone)`,
      });
      await this.refreshAgents();
    });
  }

  /** Shared by the hold pair: re-read the roster so the held/released state lands immediately
   * rather than at the next poll. */
  private async refreshAgents(): Promise<void> {
    const sinceSeq = this.store.getState().lastSeq;
    const records = await this.rpc<unknown[]>("agent.list", { lite: true });
    this.store.dispatch({ type: "agentRecords", records: records as never, sinceSeq });
  }

  /** mod+p (A3-5, FC-1 port): flip the NEXT-spawn ◇/◆ flag AND live-apply the
   * new mode to the RUNNING chip target via agent.setPermission. */
  cyclePermissionMode(target: ComposeTarget = "main"): Promise<void> {
    return this.guarded(async () => {
      const prevMode = this.store.getState().permissionMode;
      const mode = prevMode === "bypass" ? "ask" : "bypass";
      this.store.dispatch({ type: "permissionMode", mode });
      const state = this.store.getState();
      const { ids } = resolveTargetIds(state, target);
      const agentId = ids[0];
      const view = agentId ? state.agents[agentId] : undefined;
      if (agentId && view && view.state === "running") {
        const params = mode === "bypass"
          ? { agentId, permissionRequest: "auto", permissionProfile: "full" }
          : { agentId, permissionRequest: "tui", permissionProfile: "acceptEdits" };
        await this.rpc("agent.setPermission", params);
        this.store.dispatch({ type: "notice", message: `permission mode → ${mode} (applied to ${agentId.slice(0, 8)})` });
      }
    });
  }

  /** /status — daemon + account summary onto the notice channel. */
  showStatus(): Promise<void> {
    return this.guarded(async () => {
      const s = await this.rpc<{
        protocolVersion: number;
        agents: Record<string, number>;
        accounts?: Array<{ name: string; provider: string }>;
      }>("daemon.status", {});
      const counts = Object.entries(s.agents ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(" · ") || "no agents";
      const accounts = (s.accounts ?? []).map((a) => `${a.name}:${a.provider}`).join(" · ") || "no accounts";
      this.store.dispatch({ type: "notice", message: `chimerad v${s.protocolVersion} · ${counts} · ${accounts}` });
    });
  }
}

// Module singleton, constructed by the FIRST component that needs it (with the
// app store + bridge rpc handed in — this module never imports either).
let instance: AgentCommands | null = null;
export function agentCommands(store: UiStore, rpc: RpcFn): AgentCommands {
  if (!instance) instance = new AgentCommands(store, rpc);
  return instance;
}
export function createAgentCommands(store: UiStore, rpc: RpcFn): AgentCommands {
  return new AgentCommands(store, rpc);
}
