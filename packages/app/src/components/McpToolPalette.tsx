import { useEffect, useRef, useState } from "react";
import type { UiState } from "@chimera/ui-state";
import { registerOverlay } from "./OverlayOutlet";
import { OverlayCard } from "./OverlayCard";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall } from "../rpc/bridge";
import {
  buildToolParams,
  filterTools,
  MCP_TOOLS,
  systemCommands,
  type McpTool,
} from "../state/commands.system";
import { displayChord } from "../keymap";
import styles from "./McpToolPalette.module.css";

// W6 build item 5 — the MCP TOOL PALETTE (mock showMcpPalette, lines 432-444;
// PARITY WS-F): 620 card at the top, "⚙ query" header + "mcp tools · daemon
// rpc" hint, browse list → enter → args form → invoke. Ported 1:1 from the
// retired TUI's McpToolPalette flow:
// the catalog is the SAME static engine_help mirror (there is no daemon
// engine_help RPC — see commands.system.ts's MCP_TOOLS note), flat tools get
// a field-per-param form, nested-schema tools a raw-JSON field, browse-only
// tools a note; submit dispatches the allowlisted daemon RPC via
// SystemCommands.mcpInvoke and renders the JSON reply below the form.
const RESULT_MAX_LINES = 12;

// Final-acceptance MAJOR 1 (esc tier 0): the palette's esc tiering (args form
// steps BACK to the list before the palette closes) lives in component state,
// so the AgentsScreen esc chain can't reach it through a store write. The
// mounted card parks its tiered onEsc here; the plain-close fallback only
// covers the never-in-practice "open flag set but card not mounted" window.
let escDelegate: (() => void) | null = null;
let resetTransientDelegate: (() => void) | null = null;
export function mcpPaletteEscape(): void {
  if (escDelegate) escDelegate();
  else appStore.dispatch({ type: "mcpPaletteOpen", open: false });
}

function resetMcpPaletteTransientState(): void {
  resetTransientDelegate?.();
}

function McpToolPalette() {
  const open = useStore((s: UiState) => s.mcpPaletteOpen);
  const [stage, setStage] = useState<"list" | "detail">("list");
  const [query, setQuery] = useState("");
  const [listIndex, setListIndex] = useState(0);
  const [toolName, setToolName] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  // TUI parity: a monotonic invocation token fences a SLOW dispatch's reply
  // off a tool the user has since navigated away from.
  const invocation = useRef(0);

  const RAW_KEY = "__raw";
  const filtered = filterTools(MCP_TOOLS, query);
  const clamped = Math.min(listIndex, Math.max(0, filtered.length - 1));
  const selectedTool: McpTool | undefined =
    stage === "detail" ? MCP_TOOLS.find((t) => t.name === toolName) : filtered[clamped];

  const resetTransientState = (): void => {
    setStage("list");
    setQuery("");
    setListIndex(0);
    setToolName(null);
    setValues({});
    setResult(null);
    setError(null);
    setPending(false);
    invocation.current++;
  };

  const closeAll = (): void => {
    appStore.dispatch({ type: "mcpPaletteOpen", open: false });
    resetTransientState();
  };

  const backToList = (): void => {
    invocation.current++;
    setStage("list");
    setResult(null);
    setError(null);
    setPending(false);
  };

  const openDetail = (tool: McpTool): void => {
    invocation.current++;
    setToolName(tool.name);
    setStage("detail");
    setError(null);
    setResult(null);
    setPending(false);
    if (tool.kind === "raw") setValues({ [RAW_KEY]: tool.rawTemplate ?? "{}" });
    else setValues(Object.fromEntries((tool.fields ?? []).map((f) => [f.key, ""])));
  };

  const dispatch = async (rpc: string, params: Record<string, unknown>): Promise<void> => {
    const seq = ++invocation.current;
    setPending(true);
    setResult(null);
    const stale = (): boolean => seq !== invocation.current;
    try {
      const reply = await systemCommands(appStore, rpcCall).mcpInvoke(rpc, params);
      if (stale()) return;
      setResult({ ok: true, text: JSON.stringify(reply, null, 2) });
    } catch (e) {
      if (stale()) return;
      const msg = typeof e === "object" && e !== null && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e);
      setResult({ ok: false, text: msg });
    } finally {
      if (!stale()) setPending(false);
    }
  };

  const submitFlat = (): void => {
    if (pending || !selectedTool) return;
    const built = buildToolParams(selectedTool, values);
    if (built.error) { setError(built.error); return; }
    setError(null);
    void dispatch(selectedTool.rpc!, built.params ?? {});
  };

  const submitRaw = (): void => {
    if (pending || !selectedTool) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(values[RAW_KEY] ?? "");
    } catch (e) {
      setError(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError("params must be a JSON object");
      return;
    }
    setError(null);
    void dispatch(selectedTool.rpc!, parsed as Record<string, unknown>);
  };

  // esc: detail steps BACK to the list, list closes (TUI parity) — OverlayCard
  // routes its captured esc through this one handler.
  const onEsc = (): void => {
    if (stage === "detail") backToList();
    else closeAll();
  };

  // Park the tiered esc handler for mcpPaletteEscape (MAJOR 1 above). No deps
  // on purpose: `stage` lives in component state, so the delegate must be the
  // FRESH closure after every render. Runs unconditionally (hooks rule) — the
  // early return below moved beneath it, from before closeAll, for exactly this.
  useEffect(() => {
    escDelegate = onEsc;
    resetTransientDelegate = resetTransientState;
    return () => {
      escDelegate = null;
      resetTransientDelegate = null;
    };
  });

  if (!open) return null;

  const kindTag = (t: McpTool): string => (t.kind === "flat" ? "form" : t.kind === "raw" ? "json" : "browse");

  return (
    <OverlayCard ariaLabel="MCP tools" width={620} align="top" onClose={onEsc}>
      <div className={styles.queryRow}>
        <span className={styles.gear}>⚙</span>
        {stage === "list" ? (
          <input
            className={styles.queryInput}
            value={query}
            autoFocus
            spellCheck={false}
            onChange={(e) => { setQuery(e.target.value); setListIndex(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") { e.preventDefault(); setListIndex(Math.max(0, clamped - 1)); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setListIndex(Math.min(Math.max(0, filtered.length - 1), clamped + 1)); }
              else if (e.key === "Enter") { e.preventDefault(); const t = filtered[clamped]; if (t) openDetail(t); }
              else if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); closeAll(); }
            }}
            data-mcp-input
          />
        ) : (
          <span className={styles.toolTitle}>{selectedTool?.name}</span>
        )}
        <span className={styles.headHint}>mcp tools · daemon rpc</span>
      </div>

      {stage === "list" ? (
        <>
          <div className={styles.list} data-mcp-list>
            {filtered.length === 0 ? (
              <div className={styles.emptyRow}>no matching tools</div>
            ) : (
              filtered.slice(0, 12).map((t, i) => (
                <div
                  key={t.name}
                  className={i === clamped ? styles.rowSel : styles.row}
                  onMouseEnter={() => setListIndex(i)}
                  onClick={() => openDetail(t)}
                  data-mcp-row={t.name}
                >
                  {t.name} <span className={styles.tag}>[{kindTag(t)}]</span>{" "}
                  <span className={styles.desc}>{t.description}</span>
                </div>
              ))
            )}
          </div>
          <div className={styles.footer}>↑↓ select · enter → args formu · esc close</div>
        </>
      ) : (
        <>
          <div className={styles.detail} data-mcp-detail>
            <div className={error ? styles.error : styles.desc}>{error ?? selectedTool?.description}</div>
            {selectedTool?.note ? <div className={styles.note}>{selectedTool.note}</div> : null}
            {selectedTool?.kind === "flat" ? (
              (selectedTool.fields ?? []).length === 0 ? (
                <div className={styles.note}>no parameters — enter runs it</div>
              ) : (
                (selectedTool.fields ?? []).map((f, i) => (
                  <div key={f.key} className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>
                      {f.label} {f.hint ? <span className={styles.note}>{f.hint}</span> : null}
                    </span>
                    <input
                      className={styles.fieldInput}
                      value={values[f.key] ?? ""}
                      autoFocus={i === 0}
                      spellCheck={false}
                      onChange={(e) => { setValues((s) => ({ ...s, [f.key]: e.target.value })); setError(null); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); submitFlat(); }
                        else if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); closeAll(); }
                      }}
                      data-mcp-field={f.key}
                    />
                  </div>
                ))
              )
            ) : selectedTool?.kind === "raw" ? (
              <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>params (json)</span>
                <textarea
                  className={styles.rawInput}
                  value={values[RAW_KEY] ?? ""}
                  rows={3}
                  autoFocus
                  spellCheck={false}
                  onChange={(e) => { setValues((s) => ({ ...s, [RAW_KEY]: e.target.value })); setError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.altKey && !e.shiftKey) { e.preventDefault(); submitRaw(); }
                    else if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); closeAll(); }
                  }}
                  data-mcp-raw
                />
              </div>
            ) : null}
            {/* zero-field flat tools: an autoFocus BUTTON so enter genuinely
               runs it (W6 review MAJOR: the list input unmounts on openDetail,
               focus fell to <body> and enter did nothing — a focused button
               makes enter = click natively; the click affordance is the same
               element, mouse=keyboard). */}
            {selectedTool?.kind === "flat" && (selectedTool.fields ?? []).length === 0 ? (
              <button
                type="button"
                className={styles.runChip}
                onClick={submitFlat}
                disabled={pending}
                autoFocus
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); closeAll(); }
                }}
                data-mcp-run
              >
                <span className={styles.runKey}>enter</span>
                <span className={styles.runVerb}> run</span>
              </button>
            ) : null}
            {pending ? <div className={styles.note}>running…</div> : null}
            {result ? (
              <div className={styles.resultBox} data-mcp-result>
                <div className={result.ok ? styles.replyHead : styles.error}>{result.ok ? "reply:" : "error:"}</div>
                <pre className={styles.replyText}>
                  {result.text.split("\n").slice(0, RESULT_MAX_LINES).join("\n")}
                  {result.text.split("\n").length > RESULT_MAX_LINES
                    ? `\n+${result.text.split("\n").length - RESULT_MAX_LINES} more lines`
                    : ""}
                </pre>
              </div>
            ) : null}
          </div>
          <div className={styles.footer}>
            {selectedTool?.kind === "none" ? `esc: back · ${displayChord("mod+j")}: close` : `enter: run · esc: back · ${displayChord("mod+j")}: close`}
          </div>
        </>
      )}
    </OverlayCard>
  );
}

registerOverlay("system.mcpPalette", McpToolPalette, resetMcpPaletteTransientState);
