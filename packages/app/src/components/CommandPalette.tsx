import { useEffect, useMemo, useRef, useState } from "react";
import type { UiState } from "@chimera/ui-state";
import { registerOverlay } from "./OverlayOutlet";
import { OverlayCard } from "./OverlayCard";
import { desktopKeymap, hasActionHandler, runAction } from "../keymap";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall } from "../rpc/bridge";
import { agentCommands, builtinCommands, composerLocal, findBuiltin } from "../state/commands.agents";
import { MCP_TOOLS } from "../state/commands.system";
import { BLOCKED_TASK_ASSIGNMENT, CommandRegistry, SETTINGS_ENTITIES, entitiesFromState, executePaletteResult, keymapCommands, mergeEntities, searchDaemonEntities, searchPalette, type PaletteEntity, type PaletteMode, type PaletteResult } from "../state/commands.palette";
import { errorText } from "../state/errorText";
import { isSpeakRepliesEnabled, setSpeakRepliesEnabled } from "../voice/ttsGate";
import styles from "./CommandPalette.module.css";

const MODES: readonly PaletteMode[] = ["all", "commands", "entities", "shortcuts"];
const RECENT_KEY = "chimera.palette.recent";
const PIN_KEY = "chimera.palette.pinned";
let resetTransientDelegate: (() => void) | null = null;

function resetCommandPaletteTransientState(): void {
  resetTransientDelegate?.();
}

const readList = (key: string): string[] => {
  try { const value = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []; }
  catch { return []; }
};

import { useKeyboardPreferences } from "../state/keyboardPreferences";

function CommandPalette() {
  const keyboardPreferences = useKeyboardPreferences();
  const open = useStore((s: UiState) => s.paletteOpen);
  const query = useStore((s: UiState) => s.paletteQuery);
  const state = useStore((s: UiState) => s);
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<PaletteMode>("all");
  const [remote, setRemote] = useState<PaletteEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PaletteResult | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [recent, setRecent] = useState<string[]>(() => typeof localStorage === "undefined" ? [] : readList(RECENT_KEY));
  const [pinned, setPinned] = useState<string[]>(() => typeof localStorage === "undefined" ? [] : readList(PIN_KEY));
  const searchSeq = useRef(0);

  const resetTransientState = (): void => {
    searchSeq.current++;
    setIndex(0);
    setMode("all");
    setRemote([]);
    setLoading(false);
    setPending(null);
    setValues({});
  };

  useEffect(() => {
    resetTransientDelegate = resetTransientState;
    return () => { resetTransientDelegate = null; };
  });

  const registry = useMemo(() => {
    const r = new CommandRegistry();
    for (const def of keymapCommands(desktopKeymap())) r.register({ ...def, run: () => { runAction(def.id, appStore); } });
    for (const builtin of builtinCommands) r.register({
      id: `builtin.${builtin.name}`, name: `/${builtin.name}`, description: builtin.description, category: "agents", keyHint: builtin.keyHint,
      availability: (ctx) => ctx.state.activeTab === "agents" ? { available: true } : { available: false, reason: "available on agents" },
      run: () => { const cmd = findBuiltin(builtin.name); if (cmd) return cmd.run({ store: appStore, commands: agentCommands(appStore, rpcCall), openSpawn: () => composerLocal.set({ spawnOpen: true }) }); },
    });
    r.register(BLOCKED_TASK_ASSIGNMENT);
    // F47: the only keyboard reach for seen-state in the app. The keymap's letter budget is spent
    // on the agents scope (rows.agents.ts), and a row marked `unbound` would not help —
    // keymapCommands() drops those, so it would never reach this palette either. Registering
    // directly is the same escape hatch voice.speakReplies.toggle uses below.
    r.register({ id: "agents.markSeen", name: "Mark agent read", description: "Clear the \"new\" badge on the selected agent", category: "agents",
      availability: (ctx) => ctx.state.activeTab !== "agents" ? { available: false, reason: "available on agents" } : ctx.state.selectedAgentId ? { available: true } : { available: false, reason: "select an agent first" },
      run: () => { runAction("agents.markSeen", appStore); } });
    r.register({ id: "agents.markAllSeen", name: "Mark all agents read", description: "Clear every \"new\" badge in the fleet", category: "agents",
      availability: (ctx) => ctx.state.activeTab === "agents" ? { available: true } : { available: false, reason: "available on agents" },
      run: () => { runAction("agents.markAllSeen", appStore); } });
    // F09.UI: the keyboard reach for the row's "not picked up · resend" badge. Availability is
    // gated on the stall itself so the palette says WHY it is unavailable rather than silently
    // running a no-op.
    r.register({ id: "agents.resendPrompt", name: "Resend unacknowledged prompt", description: "Re-deliver the message the selected agent never picked up", category: "agents",
      availability: (ctx) => ctx.state.activeTab !== "agents" ? { available: false, reason: "available on agents" }
        : !ctx.state.selectedAgentId ? { available: false, reason: "select an agent first" }
        : ctx.state.agents[ctx.state.selectedAgentId]?.promptStall ? { available: true } : { available: false, reason: "no unacknowledged prompt" },
      run: () => { runAction("agents.resendPrompt", appStore); } });
    // VOICE-STOP: reach for the Settings switch without leaving the keyboard or the current tab
    // (no new chord — chord choice is the user's call; see rows.voice.ts).
    r.register({ id: "voice.speakReplies.toggle", name: "Toggle spoken agent replies", description: "Mute or unmute text-to-speech for agent replies (Settings → voice engines)", category: "settings", run: () => { setSpeakRepliesEnabled(!isSpeakRepliesEnabled()); } });
    r.register({ id: "workflow.failed", name: "Filter failed workflow nodes", description: "Open a workflow with failed steps only", category: "workflow", arguments: [{ key: "name", label: "Workflow", kind: "string", required: true, placeholder: "workflow name" }], deepLink: (args) => ({ kind: "workflow", name: String(args["name"]), failedOnly: true }) });
    return r;
  }, [keyboardPreferences]);

  const mcpEntities = useMemo(() => MCP_TOOLS.map((tool) => ({ kind: "mcpTool" as const, id: tool.name, name: tool.name, description: tool.description, deepLink: { kind: "mcpTool" as const, name: tool.name } })), []);
  const entities = useMemo(() => mergeEntities(entitiesFromState(state), SETTINGS_ENTITIES, mcpEntities, remote), [state, mcpEntities, remote]);
  const matches = useMemo(() => searchPalette({ query, mode, registry, entities, context: { state, connected: state.connected, hasHandler: hasActionHandler }, pinned: new Set(pinned), recent }), [query, mode, registry, entities, state, pinned, recent]);
  // only matches.slice(0, 12) ever RENDERS (below) — clamp navigation to that same window so
  // ArrowDown can never land the highlight (or Enter) on an off-screen row.
  const visibleMax = Math.min(11, matches.length - 1);
  const clamped = Math.min(index, Math.max(0, visibleMax));

  useEffect(() => {
    if (!open || mode === "commands" || mode === "shortcuts") return;
    const seq = ++searchSeq.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void searchDaemonEntities(rpcCall, query).then((found) => { if (seq === searchSeq.current) setRemote(found); }).finally(() => { if (seq === searchSeq.current) setLoading(false); });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [open, query, mode]);

  if (!open) return null;
  const close = (): void => {
    appStore.dispatch({ type: "paletteOpen", open: false });
    resetTransientState();
  };
  const backOrClose = (): void => { if (pending) { setPending(null); setValues({}); } else close(); };
  const remember = (id: string): void => {
    const next = [id, ...recent.filter((x) => x !== id)].slice(0, 20); setRecent(next); localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  };
  const run = (entry: PaletteResult): void => {
    if (!entry.availability.available) return;
    if (entry.kind === "command" && (entry.command.arguments?.length ?? 0) > 0) {
      setPending(entry); setValues({});
      return;
    }
    void executePaletteResult(entry, {}, { state, connected: state.connected, hasHandler: hasActionHandler }, appStore).then(() => { remember(entry.id); close(); }).catch((e) => appStore.dispatch({ type: "commandError", message: errorText(e) }));
  };
  const submitPending = (): void => {
    if (!pending) return;
    const normalized = pending.kind === "command" ? Object.fromEntries((pending.command.arguments ?? []).map((arg) => {
      const value = values[arg.key];
      return [arg.key, arg.kind === "entities" && typeof value === "string" ? value.split(",").map((x) => x.trim()).filter(Boolean) : value];
    })) : values;
    void executePaletteResult(pending, normalized, { state, connected: state.connected, hasHandler: hasActionHandler }, appStore)
      .then(() => { remember(pending.id); setPending(null); close(); })
      .catch((e) => appStore.dispatch({ type: "commandError", message: errorText(e) }));
  };
  const togglePin = (id: string): void => {
    const next = pinned.includes(id) ? pinned.filter((x) => x !== id) : [id, ...pinned]; setPinned(next); localStorage.setItem(PIN_KEY, JSON.stringify(next));
  };

  return (
    <OverlayCard ariaLabel="Command palette" width={680} align="top" onClose={backOrClose}>
      <div className={styles.queryRow}>
        <span className={styles.prompt}>❯</span>
        <input className={styles.queryInput} value={pending ? pending.name : query} autoFocus={!pending} spellCheck={false} readOnly={!!pending}
          onChange={(e) => { appStore.dispatch({ type: "paletteQuery", query: e.target.value }); setIndex(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") { e.preventDefault(); setIndex(Math.max(0, clamped - 1)); }
            else if (e.key === "ArrowDown") { e.preventDefault(); setIndex(Math.min(visibleMax, clamped + 1)); }
            else if (e.key === "Enter") { e.preventDefault(); const entry = matches[clamped]; if (entry) run(entry); }
            else if (e.key === "Tab") { e.preventDefault(); setMode(MODES[(MODES.indexOf(mode) + (e.shiftKey ? MODES.length - 1 : 1)) % MODES.length]!); setIndex(0); }
            else if (e.key === "Escape" && pending) { e.preventDefault(); setPending(null); setValues({}); }
            else if ((e.ctrlKey || e.metaKey) && e.key === "b") { e.preventDefault(); close(); }
          }} data-palette-input />
        <span className={styles.headHint}>{loading ? "searching…" : `${matches.length} results`}</span>
      </div>
      {!pending && <div className={styles.modes}>{MODES.map((m) => <button key={m} className={m === mode ? styles.modeActive : styles.mode} onClick={() => { setMode(m); setIndex(0); }}>{m}</button>)}</div>}
      {pending?.kind === "command" ? <div className={styles.detail} data-palette-arguments>
        <div className={styles.preview}><span className={styles.kind}>preview</span>{pending.description}</div>
        {(pending.command.arguments ?? []).map((arg, i) => <label className={styles.field} key={arg.key}>
          <span>{arg.label}{arg.required ? " *" : ""}</span>
          {arg.kind === "boolean" ? <input type="checkbox" checked={values[arg.key] === true} onChange={(e) => setValues((v) => ({ ...v, [arg.key]: e.target.checked }))} />
            : arg.kind === "enum" ? <select autoFocus={i === 0} value={String(values[arg.key] ?? "")} onChange={(e) => setValues((v) => ({ ...v, [arg.key]: e.target.value }))}><option value="">select…</option>{arg.options.map((o) => <option key={o}>{o}</option>)}</select>
            : <input autoFocus={i === 0} placeholder={arg.kind === "string" ? arg.placeholder : arg.kind === "entities" ? "comma-separated ids" : `${arg.entityKind} id`} value={String(values[arg.key] ?? "")} onChange={(e) => setValues((v) => ({ ...v, [arg.key]: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitPending(); } else if (e.key === "Escape") { e.preventDefault(); setPending(null); setValues({}); } }} />}
        </label>)}
        <button className={styles.runButton} onClick={submitPending}>run command</button>
      </div> : <div className={styles.list} data-palette-list>
        {matches.length === 0 ? <div className={styles.emptyRow}>no matching commands or entities</div> : matches.slice(0, 12).map((m, i) => (
          <div key={m.id} className={`${i === clamped ? styles.rowSel : styles.row} ${!m.availability.available ? styles.disabled : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => run(m)} data-palette-row={m.id}>
            <button className={styles.pin} onClick={(e) => { e.stopPropagation(); togglePin(m.id); }} aria-label={pinned.includes(m.id) ? "unpin" : "pin"}>{pinned.includes(m.id) ? "★" : "☆"}</button>
            <span className={styles.kind}>{m.kind === "entity" ? m.entityKind : m.command.category}</span> {m.name}{" "}
            <span className={styles.desc}>{m.availability.available ? m.description : m.availability.reason}{m.kind === "command" && m.keyHint ? ` · ${m.keyHint}` : ""}</span>
          </div>
        ))}
      </div>}
      <div className={styles.footer}>{pending ? "enter run · esc back" : "↑↓ select · tab mode · enter run · esc close"}</div>
    </OverlayCard>
  );
}

registerOverlay("system.palette", CommandPalette, resetCommandPaletteTransientState);
