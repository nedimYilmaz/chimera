import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ImageMediaType, SlashCommandView, UiState } from "@chimera/ui-state";
import { chordOf, displayChord, keyLabel, registerActionHandler, resolveChord, runAction, shouldForwardComposerChord } from "../keymap";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall } from "../rpc/bridge";
import {
  AGENT_DND_MIME,
  agentCommands,
  agentDragOverEffect,
  builtinSlashEntries,
  buildQuotedPrefix,
  composerLocal,
  deleteLineLeft,
  deleteWordLeft,
  filterSlashEntries,
  findBuiltin,
  findImageTags,
  imagePathMediaType,
  imageTagText,
  interpretCompose,
  lineEnd,
  lineStart,
  pathBasename,
  quoteFromAgent,
  slashQuery,
  splitComposeContent,
  switchDraftTo,
  tagEndingAt,
  tagStartingAt,
  targetLabel,
  useComposerLocal,
  wordLeft,
  wordRight,
  type AgentCommands,
  type ComposeTarget,
  type SlashEntry,
} from "../state/commands.agents";
import { agentTasksLocal, useAgentTasksLocal } from "../state/commands.agentTasks";
import { liveTaskStepAgentId, taskIdFromRowId } from "../state/selectors.workflows";
import { autosizeInput, displayName, fmtClock, shortId } from "../state/selectors";
import { isReplayActive, useReplayActive } from "../state/commands.system"; // B7: inputs disabled during replay
import { projectsLocal } from "../state/commands.projects";           // W7: see buildSlashMatches
import { projectCommandEntries } from "../state/selectors.projects";  // W7: see buildSlashMatches
import { ArtifactsStrip } from "./ArtifactsStrip";
import { CheckpointStrip } from "./CheckpointStrip";
import { PushToTalkControl } from "./PushToTalkControl";
import { NativeVoiceControl } from "./NativeVoiceControl";
import { QueuedBar } from "./QueuedBar";
import { QuoteBand } from "./QuoteBand";
import { SlashPopup } from "./SlashPopup";
import styles from "./Composer.module.css";
import { markerRuns } from "../state/composerMarkers";

// W4 build item 1 — the composer band: SlashPopup (A7-1) + QueuedBar (A1-4)
// + the strip itself (mock line 482-488): ❯ accent bold, the TargetChip
// "→ ◇|◆ <target> ▾" (click → target menu; mod+p toggles the mode AND
// live-applies agent.setPermission — A3-5; with target "selected" the chip
// live-follows list navigation — TUI-003), a controlled multi-row input
// (F13 + P0 autosize fix: grows 1→8 rows incl. soft-wrapped lines, then
// scrolls internally), darwin readline chords
// (B5), placeholder-only key hints (F13 v7 fix — no more static right-side
// label colliding with typed text). Enter routes through interpretCompose
// (A1-2); esc lives in AgentsScreen's ONE close-priority chain
// (commands.agents.ts resolveEscTier). F13: ctrl+v / drag-drop / a pasted
// image path insert an atomic `[▣ #N name]` tag at the cursor (see the
// F13 block above onKeyDown + insertImageAtCursor below) — the styled chip
// in the mock is the SENT-turn rendering (TranscriptPanel's InlineContent);
// the live textarea can only show its literal bracket text.

// F13 (W13) + P0 fix: 1→8 lines auto-grow, then the textarea scrolls
// internally. MAX_ROWS bumped 6→8 alongside the scrollHeight-based autosize
// below (was a `rows` count of explicit "\n"s only — a long SOFT-WRAPPED
// single line never grew the box and hid its own top rows). autosizeInput
// itself lives in selectors.ts (pure arithmetic, unit-tested there — this
// component's vitest config is node-env/no-DOM, so a component-level test
// can't mock scrollHeight; see selectors.test.ts's "autosizeInput" block).
const MAX_ROWS = 8;

/** Slash-match derivation shared by the render memo AND the esc chain's
 * imperative snapshot (slashOpen tier).
 * W7 (coverage B13, narrow grant on THIS function only): PROJECT COMMANDS —
 * ".claude/commands/*.md" for the selected agent's cwd, from the plugins.list
 * cache PluginsCard keeps fresh in projectsLocal — join the catalog as
 * agent-scope entries (enabled rows only, per the Stage-2 deferral ledger's
 * client-side filter; deduped against names the agent already advertises via
 * system/init). Extending the SOURCE (not the popup) keeps the ↑↓/enter
 * cursor, the open-gate ("/dep" opens on /deploy) and executeSlashEntry's
 * agent.send routing identical for these rows — the mouse=keyboard rule. */
export function buildSlashMatches(
  advertised: readonly SlashCommandView[] | undefined,
  composeText: string,
  dismissed: boolean,
): SlashEntry[] {
  if (dismissed) return [];
  const q = slashQuery(composeText);
  if (q === null) return [];
  const agentEntries = (advertised ?? [])
    .filter((c) => c.source !== "builtin")
    .map((c): SlashEntry => ({
      name: c.name,
      ...(c.description !== undefined ? { description: c.description } : {}),
      source: "agent" as const,
    }));
  const projectEntries = projectCommandEntries(
    projectsLocal.getState().commandsForAgent?.rows ?? [],
    "",
    agentEntries.map((e) => e.name),
  ).map((r): SlashEntry => ({ name: r.name, description: r.source, source: "agent" as const }));
  const catalog: SlashEntry[] = [...builtinSlashEntries(), ...agentEntries, ...projectEntries];
  return filterSlashEntries(catalog, q);
}

/** Imperative variant over a full UiState snapshot (esc chain / tests). */
export function slashMatchesFor(state: UiState, composeText: string, dismissed: boolean): SlashEntry[] {
  const advertised = state.selectedAgentId ? state.agents[state.selectedAgentId]?.slashCommands : undefined;
  return buildSlashMatches(advertised, composeText, dismissed);
}

/** The concrete agentIds the QueuedBar/mod+u/esc-drop act on for the current
 * chip target (resolveTargetIds minus the lazy-spawn branch). */
export function resolveActiveTargets(state: UiState, target: ComposeTarget): string[] {
  if (target === "main") return state.mainConductorId ? [state.mainConductorId] : [];
  if (target === "selected") {
    const selId = state.selectedAgentId;
    // WORKFLOW-TASK-VIEW: mirrors resolveTargetIds' task-row branch — never
    // falls back to main for an unresolvable step target.
    const taskId = selId ? taskIdFromRowId(selId) : null;
    if (taskId) {
      const raw = agentTasksLocal.getState().tasks.find((t) => t["taskId"] === taskId) ?? null;
      const liveId = liveTaskStepAgentId(raw);
      return liveId && state.agents[liveId] ? [liveId] : [];
    }
    const real = !!selId && selId !== state.mainConductorId && !!state.agents[selId];
    if (real && selId) return [selId];
    return state.mainConductorId ? [state.mainConductorId] : [];
  }
  if (target === "all") return state.agentOrder.filter((id) => state.agents[id]?.state === "running" && !state.agents[id]?.shadow);
  // AGENT-MARK: the operator's ad-hoc set, filtered to what is still live — same rule as "all",
  // and the same one resolveTargetIds applies, so the chip's count never disagrees with what a
  // send actually reaches.
  if (target === "marked") return state.markedAgentIds.filter((id) => state.agents[id]?.state === "running" && !state.agents[id]?.shadow);
  return state.agentOrder.filter((id) => {
    const a = state.agents[id];
    return !!a && a.state === "running" && !a.shadow && a.membership?.team === target.team;
  });
}

/** VOICE-STOP-ALWAYS: what ⌥Space does, as a decision with no side effects.
 *
 *  The ordering here IS the fix. Stopping must not consult the target: the no-target guard exists
 *  so a conversation is never STARTED with nowhere to send its transcript, but applied to the
 *  toggle as a whole it also blocked the only way to turn voice OFF — and this chord is the only
 *  affordance, there is no stop button anywhere in the UI. An operator whose target stopped
 *  resolving mid-conversation (the agent finished, or the composer chip moved to something with no
 *  live agents) was left with an open microphone and no way to close it short of restarting.
 *  stopConversation() uses the agentId captured at START, so it never needed the current one. */
export function voiceToggleDecision(active: boolean, agentId: string | null): "stop" | "start" | "none" {
  if (active) return "stop";
  return agentId ? "start" : "none";
}

/** Run one slash entry — the ONE seam the popup's enter AND a row click share
 * (mouse=keyboard parity): ⌘ built-ins run locally, agent commands route via
 * sendSlash (slash:true when advertised — agent.send semantics). */
export function executeSlashEntry(commands: AgentCommands, entry: SlashEntry, args: string): void {
  if (entry.source === "builtin") {
    const cmd = findBuiltin(entry.name);
    if (cmd) void cmd.run({ store: appStore, commands, openSpawn: () => composerLocal.set({ spawnOpen: true }) });
  } else {
    void commands.sendSlash(composerLocal.getState().target, entry.name, args);
  }
  composerLocal.set({ composeText: "", slashIndex: 0, slashDismissed: false });
}

export function Composer() {
  const commands = agentCommands(appStore, rpcCall);
  const local = useComposerLocal((s) => s);
  const permissionMode = useStore((s: UiState) => s.permissionMode);
  const selected = useStore((s: UiState) => (s.selectedAgentId ? s.agents[s.selectedAgentId] : undefined));
  const agents = useStore((s: UiState) => s.agents);
  const selectedId = useStore((s: UiState) => s.selectedAgentId);
  const mainId = useStore((s: UiState) => s.mainConductorId);
  const outbox = useStore((s: UiState) => s.outbox);
  const advertised = useStore((s: UiState) => (s.selectedAgentId ? s.agents[s.selectedAgentId]?.slashCommands : undefined));
  const teams = useStore((s: UiState) => s.teams);
  const connected = useStore((s: UiState) => s.connected);
  const replayActive = useReplayActive();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // COMPOSER-MARKDOWN-PREVIEW: the mirror layer, scrolled in step with the textarea above it.
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  // F13: chains multiple images landing in ONE paste/drop event — each insert
  // updates this to its own tag's end so the next lands right after it instead
  // of every image racing for the textarea's (now-stale) original caret.
  const insertCursorRef = useRef<number | null>(null);

  const matches = useMemo(
    () => buildSlashMatches(advertised, local.composeText, local.slashDismissed),
    [advertised, local.composeText, local.slashDismissed],
  );
  const slashOpen = matches.length > 0;
  const slashIndexClamped = Math.min(local.slashIndex, Math.max(0, matches.length - 1));

  const outboxItems = useMemo(() => {
    const ids = resolveActiveTargets(appStore.getState(), local.target);
    return outbox.filter((o) => ids.includes(o.agentId));
  }, [outbox, local.target, mainId, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // F22 (W24): the quote band's live source-agent view (state dot color) —
  // read directly (not via useStore's selector form) since `local.quote` is
  // itself app-store-independent local state; a stale/gone agentId just
  // renders the QuoteBand's shortId fallback (QuoteBand.tsx).
  const quoteAgent = useStore((s: UiState) => (local.quote ? s.agents[local.quote.agentId] : undefined));
  // F22 (W24): the "@name" a quote-reply attributes to — the live agent's
  // displayName when still known, else its shortId (an agent can't vanish
  // from state.agents mid-session today, but this stays defensive rather
  // than crash a send on a stale id).
  const mentionFor = (agentId: string): string => {
    const view = appStore.getState().agents[agentId];
    return view ? displayName(view) : shortId(agentId);
  };

  // B5 row 2 (TUI-003): with target "selected" the chip live-follows the list
  // and names the concrete destination. This uses the same resolver as send/
  // queued actions, so a missing/main selection honestly reads "main" while a
  // workflow task row names its live step agent (and keeps its no-main-fallback).
  const resolvedTargetId = local.target === "selected"
    ? resolveActiveTargets(appStore.getState(), local.target)[0]
    : undefined;
  const resolvedTarget = resolvedTargetId ? agents[resolvedTargetId] : undefined;
  const selectedTaskTarget = selectedId ? taskIdFromRowId(selectedId) : null;
  const resolvedSelectedLabel = resolvedTarget
    ? displayName(resolvedTarget)
    : selectedTaskTarget
      ? null
      : "main";
  const chipTarget = targetLabel(local.target, resolvedSelectedLabel);
  const modeGlyph = permissionMode === "ask" ? "◇" : "◆";

  const setText = (composeText: string): void => {
    composerLocal.set({ composeText, slashDismissed: false, slashIndex: 0 });
  };

  // mod+u (no id → last) and a QueuedBar chip click (that chip's id) share
  // this ONE edit path (W4 review: clicking chip 1 used to pull the last).
  // DRAFT-PER-AGENT: what is typed belongs to the agent it is addressed to. Keyed on the RESOLVED
  // targets rather than on the selection, so a fan-out draft is its own draft and does not
  // overwrite the single-agent one you were writing a moment ago.
  const draftOwner = useMemo(
    () => resolveActiveTargets(appStore.getState(), local.target).join(",") || null,
    // Recomputed when the selection or the explicit target moves — the two inputs
    // resolveActiveTargets actually reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [local.target, selectedId, mainId],
  );
  useEffect(() => {
    const patch = switchDraftTo(composerLocal.getState(), draftOwner);
    if (patch) composerLocal.set(patch);
  }, [draftOwner]);

  const popIntoDraft = (itemId?: string): void => {
    const state = appStore.getState();
    const l = composerLocal.getState();
    const targetIds = resolveActiveTargets(state, l.target);
    const holder = itemId
      ? state.outbox.find((o) => o.id === itemId && targetIds.includes(o.agentId))
      : [...state.outbox].reverse().find((o) => targetIds.includes(o.agentId));
    if (!holder) return;
    // IMAGE-EDIT-LOSES-IMAGE: hand over the CURRENT draft's images too, not just its text — the
    // draft being displaced goes back on the queue, and dropping its attachments there is the same
    // loss in the other direction.
    const outgoing = l.pendingImages.length > 0
      ? splitComposeContent(l.composeText, l.pendingImages)
      : { flatText: l.composeText, images: undefined, content: undefined };
    const restored = commands.popQueued(
      holder.agentId,
      { text: outgoing.flatText, ...(outgoing.images ? { images: outgoing.images } : {}), ...(outgoing.content ? { content: outgoing.content } : {}) },
      holder.id,
    );
    if (restored !== null) {
      composerLocal.set({
        composeText: restored.text,
        pendingImages: restored.images,
        nextImageNum: restored.nextNum,
        slashDismissed: false, slashIndex: 0,
      });
      inputRef.current?.focus();
    }
  };

  // NativeVoiceControl owns Alt+Space; the composer keeps its text-input rows.
  useEffect(() => {
    const offs = [
      registerActionHandler("composer.permissions", () => {
        void commands.cyclePermissionMode(composerLocal.getState().target);
      }),
      registerActionHandler("composer.commands", () => {
        const cur = composerLocal.getState().composeText;
        if (!cur.startsWith("/")) composerLocal.set({ composeText: "/" + cur, slashDismissed: false, slashIndex: 0 });
        else composerLocal.set({ slashDismissed: false });
        inputRef.current?.focus();
      }),
      registerActionHandler("composer.popQueued", () => popIntoDraft()),
    ];
    return () => { for (const off of offs) off(); };
  }, [commands]);

  // Auto-size the textarea to its content (incl. soft-wrapped lines) on every
  // composeText change, up to MAX_ROWS then inner-scroll: reset height to
  // "auto" so the browser lays out the TRUE scrollHeight (a shrink needs this
  // too, not just growth), read the live line-height (honors a token/font
  // change), then set the box height from autosizeInput's pure arithmetic.
  // `rows` here is display-only (the "N/8 lines" hint) — the box's real
  // height rides the imperative style.height set below, not this state.
  const [rows, setRows] = useState(1);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const parsed = parseFloat(getComputedStyle(el).lineHeight);
    const { heightPx, scroll, rows: r } = autosizeInput(el.scrollHeight, parsed, MAX_ROWS);
    el.style.height = `${heightPx}px`;
    el.style.overflowY = scroll ? "auto" : "hidden";
    setRows(r);
  }, [local.composeText]);

  // FORCE-SEND-MIDTURN: `force` (opt+enter) bypasses the busy-hold outbox and
  // delivers straight through agent.send even mid-turn — see
  // commands.agents.ts's sendToAgent/sendToMain doc comments for the mechanics
  // and the ordering rule. Scoped to the plain-text/content send path below;
  // slash commands and the imagePath intent keep their normal (queue-while-
  // busy) behavior — forcing a slash command mid-turn is a narrower case this
  // pass doesn't cover.
  const submit = (force = false): void => {
    // Coverage B7 ("replay'de send/kill çalışmaz" — W6 review MAJOR): while a
    // replay is active NOTHING leaves the composer; the textarea is also
    // rendered disabled below, this guards the keymap/enter path.
    if (isReplayActive()) return;
    if (slashOpen) {
      const entry = matches[slashIndexClamped];
      if (entry) {
        executeSlashEntry(commands, entry, "");
        return;
      }
    }
    const intent = interpretCompose(local.composeText, {
      hasPendingImages: local.pendingImages.length > 0,
      isBuiltin: (name) => findBuiltin(name) !== undefined,
    });
    if (intent.kind === "noop") return;
    if (intent.kind === "builtin") {
      const cmd = findBuiltin(intent.name);
      if (cmd) void cmd.run({ store: appStore, commands, openSpawn: () => composerLocal.set({ spawnOpen: true }) });
      composerLocal.set({ composeText: "", slashIndex: 0 });
      return;
    }
    if (intent.kind === "slash") {
      void commands.sendSlash(local.target, intent.name, intent.args);
      composerLocal.set({ composeText: "", slashIndex: 0 });
      return;
    }
    if (intent.kind === "imagePath") {
      // A1-2: the raw path must NEVER reach the model. The webview has no fs
      // read; attach via the DEV/test seam when present, else surface a clear
      // error instead of leaking the path as prompt text (pasted images are
      // the first-class desktop attach path).
      const read = (globalThis as Record<string, unknown>)["__CHIMERA_READIMAGE__"] as
        | ((path: string) => { mediaType: string; data: string } | null)
        | undefined;
      const img = read ? read(intent.path) : null;
      if (img) {
        void commands.sendComposed(local.target, intent.caption, [{ mediaType: intent.mediaType, data: img.data }]);
        composerLocal.set({ composeText: "", pendingImages: [], nextImageNum: 1, slashIndex: 0 });
      } else {
        appStore.dispatch({ type: "commandError", message: "image paths can't be read from the webview — paste the image (ctrl+v) instead" });
      }
      return;
    }
    // F22 (W24): an active quote-reply is PREPENDED as an attributed markdown
    // blockquote (encodeQuoteBlock/buildQuotedPrefix, @chimera/ui-state) — no
    // wire/daemon change, any client sees legible markdown; the Tauri
    // renderer (MessageBody's `quote` block) lifts it back into a linked
    // excerpt block. Scoped to a genuine plain-text send (not builtin/slash/
    // imagePath above) — those aren't really "replies".
    const quote = local.quote;
    const quotedPrefix = quote ? buildQuotedPrefix(mentionFor(quote.agentId), fmtClock(quote.ts), quote) : null;
    // F13: split the buffer at its inline `[▣ #N name]` tags into D9's ordered
    // content[] blocks + a flattened display text (no pendingImages → plain text,
    // unchanged from before this feature).
    if (local.pendingImages.length > 0) {
      const { content, flatText, images } = splitComposeContent(local.composeText, local.pendingImages);
      const finalText = quotedPrefix ? `${quotedPrefix}\n\n${flatText}` : flatText;
      const finalContent = quotedPrefix ? [{ type: "text" as const, text: `${quotedPrefix}\n\n` }, ...content] : content;
      void commands.sendComposed(local.target, finalText, images, finalContent, force);
    } else {
      void commands.sendComposed(local.target, quotedPrefix ? `${quotedPrefix}\n\n${intent.text}` : intent.text, undefined, undefined, force);
    }
    composerLocal.set({ composeText: "", pendingImages: [], nextImageNum: 1, slashIndex: 0, quote: null });
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const el = ev.currentTarget;
    const pos = el.selectionStart ?? local.composeText.length;
    const apply = (r: { text: string; pos: number }): void => {
      setText(r.text);
      requestAnimationFrame(() => { el.setSelectionRange(r.pos, r.pos); });
    };
    const setCaret = (p: number): void => {
      ev.preventDefault();
      el.setSelectionRange(p, p);
    };

    // F13: atomic inline image tags — Backspace/Delete drop the WHOLE tag +
    // its attachment as one unit; a bare ←→ skips over it as one unit too
    // (the darwin word/line chords below still walk char-by-char through a
    // tag's own bracket text — only PLAIN arrows/backspace/delete atomize it).
    if (local.pendingImages.length > 0) {
      const spans = findImageTags(local.composeText);
      if (spans.length > 0) {
        const dropTag = (tag: { start: number; end: number; num: number }): void => {
          ev.preventDefault();
          apply({ text: local.composeText.slice(0, tag.start) + local.composeText.slice(tag.end), pos: tag.start });
          composerLocal.set({ pendingImages: local.pendingImages.filter((p) => p.num !== tag.num) });
        };
        if (ev.key === "Backspace" && !ev.altKey && !ev.metaKey) {
          const tag = tagEndingAt(spans, pos);
          if (tag) { dropTag(tag); return; }
        }
        if (ev.key === "Delete" && !ev.altKey && !ev.metaKey) {
          const tag = tagStartingAt(spans, pos);
          if (tag) { dropTag(tag); return; }
        }
        if (ev.key === "ArrowLeft" && !ev.altKey && !ev.metaKey && !ev.ctrlKey) {
          const tag = tagEndingAt(spans, pos);
          if (tag) { setCaret(tag.start); return; }
        }
        if (ev.key === "ArrowRight" && !ev.altKey && !ev.metaKey && !ev.ctrlKey) {
          const tag = tagStartingAt(spans, pos);
          if (tag) { setCaret(tag.end); return; }
        }
      }
    }

    if (slashOpen) {
      if (ev.key === "ArrowUp") { ev.preventDefault(); composerLocal.set({ slashIndex: Math.max(0, slashIndexClamped - 1) }); return; }
      if (ev.key === "ArrowDown") { ev.preventDefault(); composerLocal.set({ slashIndex: Math.min(matches.length - 1, slashIndexClamped + 1) }); return; }
      if (ev.key === "Tab") {
        ev.preventDefault();
        const name = matches[slashIndexClamped]?.name;
        if (name) setText("/" + name + " ");
        return;
      }
    }
    if (ev.key === "Enter") {
      // FORCE-SEND-MIDTURN: opt+enter (alt+enter) now force-sends instead of
      // inserting a newline — newline moves to shift+enter, which already
      // inserted one via the textarea's native default (nothing below calls
      // preventDefault for it), so nothing about that path actually changes;
      // only the ADVERTISED chord does (see the placeholder hint below).
      if (ev.altKey) {
        ev.preventDefault();
        submit(true);
        return;
      }
      if (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
        ev.preventDefault();
        submit();
        return;
      }
      return;
    }
    // darwin readline chords (B5): ⌥⌫ word · ⌘⌫ line · ⌥←→ word · ⌘←→ line.
    if (ev.key === "Backspace" && ev.altKey && !ev.metaKey) { ev.preventDefault(); apply(deleteWordLeft(local.composeText, pos)); return; }
    if (ev.key === "Backspace" && ev.metaKey) { ev.preventDefault(); apply(deleteLineLeft(local.composeText, pos)); return; }
    if (ev.key === "ArrowLeft" && ev.altKey && !ev.metaKey && !ev.shiftKey) { setCaret(wordLeft(local.composeText, pos)); return; }
    if (ev.key === "ArrowRight" && ev.altKey && !ev.metaKey && !ev.shiftKey) { setCaret(wordRight(local.composeText, pos)); return; }
    if (ev.key === "ArrowLeft" && ev.metaKey && !ev.shiftKey) { setCaret(lineStart(local.composeText, pos)); return; }
    if (ev.key === "ArrowRight" && ev.metaKey && !ev.shiftKey) { setCaret(lineEnd(local.composeText, pos)); return; }
    // COMPOSER-ARROW-STEALS-AGENT: ↑↓ = agent-list navigation (B5, the chip
    // live-follows when target=selected — TUI-003), but ONLY when the
    // composer is genuinely EMPTY. The original guard was "draft has no
    // newline", which handed arrows to agent-nav for ANY single-line draft —
    // including the ordinary case of editing an in-progress one-line message,
    // where an operator pressing ↑ expects the caret to move (or a wrapped
    // textarea to scroll to its prior visual row), not the selected agent to
    // change underneath them. Matches the empty-buffer ←→ fold/call-walk tier
    // just below and commands.agents.ts's `composeNonEmpty` esc-tier gate
    // (also a plain non-trim emptiness check) — same "field wins whenever it
    // has real text" convention used throughout this handler. A non-empty
    // draft NEVER falls to agent-nav, even with the caret already at position
    // 0: that "smart" case is more clever than predictable, and predictable
    // is what was asked for. Option/cmd+SHIFT+arrow bails from the word/line
    // jump above so the textarea's native selection-extend runs instead of
    // collapsing the caret via setCaret.
    if ((ev.key === "ArrowUp" || ev.key === "ArrowDown") && local.composeText === "") {
      ev.preventDefault();
      runAction(ev.key === "ArrowUp" ? "agents.up" : "agents.down", appStore);
      return;
    }
    // empty-buffer ←→ = fold / tool-detail call-walking (TUI always-on-input
    // parity: the caret has nowhere to move, so the pane gets the keys).
    if ((ev.key === "ArrowLeft" || ev.key === "ArrowRight") && local.composeText === "" && !ev.altKey && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault();
      runAction(ev.key === "ArrowLeft" ? "agents.foldLeft" : "agents.foldRight", appStore);
      return;
    }
    // Forward ctrl/meta chords to the ONE keymap table (parity while the
    // composer owns focus). Never plain keys (typing), never a native editing
    // chord (BUG A — Cmd/Ctrl+A/C/V/X/Z must run select-all/copy/paste/cut/
    // undo/redo natively, not open Accounts/the MCP palette), never ctrl+y/n
    // (the capture-phase permission handler owns them).
    if (shouldForwardComposerChord(ev)) {
      const row = resolveChord(chordOf(ev.nativeEvent), appStore.getState().activeTab);
      if (row) {
        ev.preventDefault();
        runAction(row.action, appStore);
        return;
      }
    }
  };

  // F13: insert one image's tag at the CURSOR (reads fresh state, not a stale
  // render closure — file reads finish async and several can land in one
  // paste/drop). `insertCursorRef` chains a multi-image event so image #2's
  // tag lands right after image #1's, not both racing for the same spot.
  const insertImageAtCursor = (mediaType: ImageMediaType, data: string, name: string): void => {
    const st = composerLocal.getState();
    const pos = insertCursorRef.current ?? inputRef.current?.selectionStart ?? st.composeText.length;
    const num = st.nextImageNum;
    const tag = imageTagText(num, name);
    const text = st.composeText.slice(0, pos) + tag + st.composeText.slice(pos);
    const newPos = pos + tag.length;
    composerLocal.set({
      composeText: text,
      pendingImages: [...st.pendingImages, { mediaType, data, num, name }],
      nextImageNum: num + 1,
      slashDismissed: false,
    });
    insertCursorRef.current = newPos;
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(newPos, newPos));
  };

  const readImageFiles = (files: readonly File[]): void => {
    insertCursorRef.current = null; // first insert of this event reads the real caret
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result ?? "");
        const comma = url.indexOf(",");
        const data = comma >= 0 ? url.slice(comma + 1) : "";
        const mediaType = (file.type || "image/png") as ImageMediaType;
        if (data) insertImageAtCursor(mediaType, data, file.name || `image.${mediaType.split("/")[1] ?? "png"}`);
      };
      reader.readAsDataURL(file);
    }
  };

  const onPaste = (ev: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = ev.clipboardData?.items;
    const images = items ? [...items].filter((it) => it.kind === "file" && it.type.startsWith("image/")) : [];
    if (images.length > 0) {
      ev.preventDefault();
      readImageFiles(images.map((it) => it.getAsFile()).filter((f): f is File => f !== null));
      return;
    }
    // A pasted image-file PATH (not bytes) — convert it into an inline tag too
    // (same "path never reaches the model, caption = basename" rule as A1-2's
    // typed-path fallback, just applied at paste time instead of at submit).
    const text = ev.clipboardData?.getData("text/plain")?.trim() ?? "";
    const mediaType = text && !text.includes("\n") ? imagePathMediaType(text) : null;
    if (!mediaType) return; // plain text pastes natively
    ev.preventDefault();
    const read = (globalThis as Record<string, unknown>)["__CHIMERA_READIMAGE__"] as
      | ((path: string) => { mediaType: string; data: string } | null)
      | undefined;
    const img = read ? read(text) : null;
    if (img) {
      insertCursorRef.current = null;
      insertImageAtCursor(img.mediaType as ImageMediaType, img.data, pathBasename(text));
    } else {
      appStore.dispatch({ type: "commandError", message: "image paths can't be read from the webview — paste the image (ctrl+v) instead" });
    }
  };

  // Drag-drop (mirrors paste for real OS files — dragDropEnabled:false in
  // tauri.conf.json lets the webview's own HTML5 DnD fire here with real File
  // blobs, same as a plain browser gate).
  // UI-DRAGDROP-AFFORDANCE: dropEffect is set EXPLICITLY (agentDragOverEffect,
  // commands.agents.ts) rather than left to the browser's implicit default —
  // AgentList's dragstart sets effectAllowed to "copy", and some engines keep
  // dropEffect at that effectAllowed-implied value once observed, letting the
  // "+" cursor leak onto regions with no drop handling at all.
  const onDragOver = (ev: React.DragEvent<HTMLTextAreaElement>): void => {
    const dt = ev.dataTransfer;
    const effect = agentDragOverEffect(dt?.types ? [...dt.types] : undefined);
    if (dt) dt.dropEffect = effect;
    if (effect === "copy") ev.preventDefault();
  };
  // F22 (W24): dragging an AgentList row here fills the quote slot — a done
  // agent quotes agent.result (RPC), a running one its latest turn
  // (quoteFromAgent, commands.agents.ts). A second drop REPLACES the slot
  // (+toast, per the doc); the first fill is silent.
  const applyQuoteFromAgent = async (agentId: string): Promise<void> => {
    const hadQuote = composerLocal.getState().quote !== null;
    const slot = await quoteFromAgent(rpcCall, appStore.getState(), agentId);
    if (!slot) {
      // Only a RUNNING agent with no assistant turn yet reaches here (every
      // terminal agent always yields a slot, MENTION-TERMINAL-AGENTS) — a
      // notice beats a silent no-op drop.
      appStore.dispatch({ type: "notice", message: `nothing to quote yet from @${mentionFor(agentId)}` });
      return;
    }
    composerLocal.set({ quote: slot });
    if (hadQuote) appStore.dispatch({ type: "notice", message: `quote replaced — now quoting @${mentionFor(agentId)}` });
  };
  const onDrop = (ev: React.DragEvent<HTMLTextAreaElement>): void => {
    const agentId = ev.dataTransfer?.getData(AGENT_DND_MIME);
    if (agentId) {
      ev.preventDefault();
      void applyQuoteFromAgent(agentId);
      return;
    }
    const files = [...(ev.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    ev.preventDefault();
    readImageFiles(files);
  };

  // F13: a click/selection landing INSIDE a tag's bracket text snaps the caret
  // to whichever end is nearer — keeps the tag atomic against mouse clicks
  // (keyboard nav never lands inside one; see the ←→ skip-over above) and
  // against a stray character typed while the caret sat mid-tag.
  const onSelect = (ev: React.SyntheticEvent<HTMLTextAreaElement>): void => {
    const el = ev.currentTarget;
    const pos = el.selectionStart;
    if (pos == null || pos !== el.selectionEnd || composerLocal.getState().pendingImages.length === 0) return;
    const hit = findImageTags(composerLocal.getState().composeText).find((s) => pos > s.start && pos < s.end);
    if (!hit) return;
    const snapped = pos - hit.start <= hit.end - pos ? hit.start : hit.end;
    requestAnimationFrame(() => el.setSelectionRange(snapped, snapped));
  };

  // AGENT-MARK: how many marked agents a send would actually REACH — the same live filter
  // resolveActiveTargets applies, so the chip's number can never promise more than it delivers.
  const markedCount = useStore((st: UiState) => resolveActiveTargets(st, "marked").length);

  // Target menu options: main / selected / team:X / marked / all (coverage B5 row 2).
  const menuOptions = useMemo((): Array<{ key: string; label: string; target: ComposeTarget }> => {
    const opts: Array<{ key: string; label: string; target: ComposeTarget }> = [
      { key: "main", label: "main", target: "main" },
      { key: "selected", label: `selected${selected ? ` · ${displayName(selected)}` : ""}`, target: "selected" },
    ];
    for (const t of teams.items) {
      const name = typeof t["name"] === "string" ? (t["name"] as string) : null;
      if (name) opts.push({ key: `team:${name}`, label: `team:${name}`, target: { team: name } });
    }
    // AGENT-MARK: offered only once something IS marked. An always-present "marked (0)" would be
    // a target that silently sends nowhere, and the standing targets above already cover the
    // "everything" and "one team" cases this exists to sit between.
    if (markedCount > 0) opts.push({ key: "marked", label: `marked · ${markedCount}`, target: "marked" });
    opts.push({ key: "all", label: "all", target: "all" });
    return opts;
  }, [teams, selected, markedCount]);

  const activeKey = typeof local.target === "string" ? local.target : `team:${local.target.team}`;

  // COMPOSER-TARGET-MENU-CLIPPED: the menu opens UPWARD from the chip, so it reaches past the top
  // of the composer band — and that band is `overflow: hidden` (AgentsScreen.module.css `.band`,
  // a deliberate ceiling so a tall composer cannot push the transcript off screen). An absolutely
  // positioned box is still clipped by an overflow ancestor of its containing block, so the menu
  // was cut away entirely rather than drawn over the transcript. Reported as the agent-select list
  // ending up BEHIND the transcript: nothing appeared when the chip was clicked.
  //
  // Portaled to <body> and placed from the chip's own rect — ImageChip's precedent for escaping a
  // trapping ancestor, narrowed from a full-screen overlay to an anchored one. Fixing it here
  // rather than by dropping the band's overflow keeps that ceiling intact, which is load-bearing:
  // it is the only thing stopping a composer with several strips open from covering the transcript.
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!local.targetMenuOpen) {
      setMenuAnchor(null);
      return undefined;
    }
    // `bottom` rather than `top`: the menu grows upward from the chip, so pinning its BOTTOM edge
    // keeps it anchored while its height changes with the option count (teams come and go, and
    // "marked · N" only exists once something is marked).
    const measure = (): void => {
      const rect = chipRef.current?.getBoundingClientRect();
      if (rect) setMenuAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
    };
    measure();
    // A resize moves the chip without re-rendering this component, which would strand an open menu
    // at the old coordinates.
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [local.targetMenuOpen]);

  const queuedLabel = chipTarget;

  // WORKFLOW-TASK-VIEW: a task-row selection (TranscriptPanel's `workflow` mode) has no
  // single "agent" — the composer targets whichever step agent is CURRENTLY
  // live, and disables itself with a hint when the task is between steps or
  // settled (no live step to send to).
  const tasksLocal = useAgentTasksLocal((s) => s.tasks);
  const selectedTaskId = selectedId ? taskIdFromRowId(selectedId) : null;
  const taskLiveAgentId = useMemo(() => {
    if (!selectedTaskId) return null;
    const raw = tasksLocal.find((t) => t["taskId"] === selectedTaskId) ?? null;
    return liveTaskStepAgentId(raw);
  }, [selectedTaskId, tasksLocal]);
  const taskBlocked = local.target === "selected" && !!selectedTaskId && !taskLiveAgentId;

  return (
    <>
      {slashOpen ? (
        <SlashPopup
          matches={matches}
          selectedIndex={slashIndexClamped}
          onRun={(entry) => executeSlashEntry(commands, entry, "")}
        />
      ) : null}
      {outboxItems.length > 0 ? <QueuedBar items={outboxItems} targetLabel={queuedLabel} onEdit={popIntoDraft} /> : null}
      {local.quote ? <QuoteBand quote={local.quote} agent={quoteAgent} onClear={() => composerLocal.set({ quote: null })} /> : null}
      <CheckpointStrip />
      <ArtifactsStrip />
      <div className={styles.strip} data-composer>
        <div className={styles.row}>
          <span className={styles.prompt}>❯</span>
          <span className={styles.chipWrap}>
            <button
              ref={chipRef}
              type="button"
              className={styles.targetChip}
              data-target-chip
              title={`permission: ${permissionMode} — ${displayChord("mod+p")} toggles (◆ bypass / ◇ ask). Spawning in bypass authorizes Codex without its sandbox or Chimera tool-policy guards.`}
              onClick={() => composerLocal.set({ targetMenuOpen: !local.targetMenuOpen })}
            >
              → <span className={permissionMode === "ask" ? styles.modeAsk : styles.modeBypass}>{modeGlyph}</span>{" "}
              {chipTarget} <span className={styles.chipCaret}>▾</span>
            </button>
            {local.targetMenuOpen && menuAnchor
              ? createPortal(
                  <div
                    className={styles.targetMenu}
                    style={{ left: menuAnchor.left, bottom: menuAnchor.bottom }}
                    data-target-menu
                  >
                    {menuOptions.map((o) => (
                      <button
                        key={o.key}
                        type="button"
                        className={[styles.targetOption, o.key === activeKey ? styles.targetOptionActive : ""].filter(Boolean).join(" ")}
                        onClick={() => composerLocal.set({ target: o.target, targetMenuOpen: false })}
                      >
                        → {o.label}
                      </button>
                    ))}
                  </div>,
                  document.body,
                )
              : null}
          </span>
          {/* COMPOSER-MARKDOWN-PREVIEW: a mirror painted BEHIND the textarea, marking code spans as
              you type them. It carries no text of its own colour — the real characters you see are
              still the textarea's — so selection, the caret and IME are untouched; the mirror only
              supplies the background behind a run. It wraps identically because it shares the
              textarea's font, size, line-height, width and wrapping rules, which holds only while
              nothing in it changes glyph metrics (see composerMarkers.ts). */}
          <span className={styles.inputWrap}>
            <div className={styles.inputMirror} ref={mirrorRef} aria-hidden="true">
              {markerRuns(local.composeText).map((r, i) =>
                r.code ? <span key={i} className={styles.mirrorCode}>{r.text}</span> : <span key={i}>{r.text}</span>,
              )}
              {/* A buffer ending in a newline would otherwise lose its last (empty) line here but
                  not in the textarea, so the two would disagree about the scroll height. */}
              {"\n"}
            </div>
          <textarea
            ref={inputRef}
            className={styles.input}
            value={local.composeText}
            // F13: placeholder-ONLY hints — dim, shown by the browser exactly
            // while the buffer is empty, gone the instant text (or a tag)
            // exists. Replaces the old static right-side hint label, which
            // collided with typed text (the v7 screenshot-report fix).
            placeholder={
              taskBlocked
                ? "no running step agent for this task — waiting for the next step"
                : `type a message — enter send · alt+enter force-send · shift+enter newline · ctrl+v image · / ${keyLabel("/") ?? "commands"}`
            }
            rows={1}
            disabled={!connected || replayActive || taskBlocked}
            autoFocus
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onSelect={onSelect}
            onScroll={(e) => {
              // Past ~8 lines the textarea scrolls internally; the mirror has to follow or the
              // highlights stay behind on the rows that scrolled away.
              if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
            }}
            data-compose-input
          />
          </span>
          {local.composeText.length > 0 ? (
            <span className={styles.growHint}>{rows}/{MAX_ROWS} lines · grows with content</span>
          ) : null}
          {appStore.getState().agents[resolveActiveTargets(appStore.getState(), local.target)[0] ?? ""]?.provider !== "codex" && <PushToTalkControl
            agentId={resolveActiveTargets(appStore.getState(), local.target)[0] ?? null}
            onSend={(text) => void commands.sendComposed(local.target, text)}
          />}
          <NativeVoiceControl
            agentId={resolveActiveTargets(appStore.getState(), local.target)[0] ?? null}
            onSend={(text) => void commands.sendComposed(local.target, text)}
          />
        </div>
      </div>
    </>
  );
}
