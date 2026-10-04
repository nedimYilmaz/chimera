import { useEffect } from "react";
import {
  analyzeToolInput, isMcpTool, type PendingPermission, type ToolInputRow, type UiState,
} from "@chimera/ui-state";
import { displayChord, registerActionHandler, runAction } from "../keymap";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { composerLocal, useComposerLocal } from "../state/commands.agents";
import { displayName, formatToolInput } from "../state/selectors";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import styles from "./PermissionCard.module.css";

// PERMISSION-CARD-READABILITY: the default (non-raw) body — analyzeToolInput's
// rows rendered as PLAIN preformatted text, never through a markdown/HTML
// interpreter, so backticks/asterisks/angle-brackets in a command display
// verbatim and can't inject markup. `command` (or whichever field is
// `PRIMARY_KEYS`-flagged) gets the most visual weight since it's the thing
// being approved; `description` (if present) surfaces above it as a plain
// summary line; scalars land in a quiet metadata row at the bottom. Nothing
// here truncates — the surrounding .inputBlock (PermissionCard.module.css)
// is the ONLY thing that scrolls, never clips silently.
function PermissionInputBody({ input }: { input: unknown }) {
  const view = analyzeToolInput(input);
  if (view.kind === "json") {
    return <pre className={styles.rawBlock}>{view.text}</pre>;
  }
  if (view.kind === "listing") {
    return <pre className={styles.rawBlock}>{view.lines.join("\n")}</pre>;
  }
  if (view.rows.length === 0) {
    return <span className={styles.ghost}>(no input)</span>;
  }
  const bodyRows = view.rows.filter((r): r is Exclude<ToolInputRow, { kind: "meta" }> => r.kind !== "meta");
  const metaRows = view.rows.filter((r): r is Extract<ToolInputRow, { kind: "meta" }> => r.kind === "meta");
  return (
    <>
      {bodyRows.map((row, i) => {
        if (row.kind === "summary") return <div key={i} className={styles.summary}>{row.text}</div>;
        if (row.kind === "primary") return <pre key={i} className={styles.primaryBlock}>{row.text}</pre>;
        const text = row.kind === "nested" ? row.lines.join("\n") : row.text;
        return (
          <div key={i} className={styles.textField}>
            <div className={styles.fieldLabel}>{row.label}</div>
            <pre className={styles.fieldValue}>{text}</pre>
          </div>
        );
      })}
      {metaRows.length > 0 ? (
        <div className={styles.metaRow}>
          {metaRows.map((row, i) => (
            <span key={i} className={styles.metaChip}>{row.label}: {row.text}</span>
          ))}
        </div>
      ) : null}
    </>
  );
}

// W4 build item 4 — the ⚠ permission decision card (mock showPermission,
// line 242-255; coverage A3/B6): OverlayCard bottom-aligned, width 640, edge
// --edge-permission, floating above the composer (bottomInset). The FULL
// input renders — PERMISSION-CARD-READABILITY: field-by-field human text
// (PermissionInputBody), never truncated (TUI-015), no JSON syntax anywhere
// in this default view; mod+e flips to the EXACT JSON.stringify ground truth
// (this card's registration shadows the transcript's tool-detail opener on
// the SAME "agents.detail" action id while mounted). mod+y/mod+j (+ bare y/n
// with an empty composer, TUI-001) are
// bound at capture level in AgentsScreen so they work above every other
// overlay (TUI-017); the chips here CLICK the same action ids. The persist
// chips (always allow tool/server) are mouse-only since KEYMAP-REDESIGN
// retired their dedicated hotkey (letter-budget trade, keymap.ts's KEYBINDING
// STANDARD comment) — still reachable by click. esc = "later" (AgentsScreen's
// chain dismisses the card; the request + badge stay pending).
export function PermissionCard({ pending, bottomInset }: {
  pending: PendingPermission;
  bottomInset: number;
}) {
  const raw = useComposerLocal((s) => s.permissionRaw);
  const agent = useStore((s: UiState) => s.agents[pending.agentId]);
  const name = agent ? displayName(agent) : pending.agentId.slice(0, 8);

  // mod+e — pretty/raw toggle while this card is mounted (registry shadow).
  useEffect(() => registerActionHandler("agents.detail", () => {
    composerLocal.set({ permissionRaw: !composerLocal.getState().permissionRaw });
  }), []);

  return (
    <OverlayCard
      width={640}
      align="bottom"
      edge="var(--edge-permission)"
      bottomInset={bottomInset}
      onClose={() => composerLocal.set({
        dismissedPermissions: new Set([...composerLocal.getState().dismissedPermissions, pending.requestId]),
      })}
    >
      <div data-permission-card>
        <OverlayCardHeader
          title="⚠ permission"
          titleColor="var(--warn)"
          meta={`${name} wants to run`}
          hint={pending.toolName}
        />
        <div className={styles.inputBlock} data-permission-input>
          {raw
            ? <pre className={styles.rawBlock}>{formatToolInput(pending.input, false)}</pre>
            : <PermissionInputBody input={pending.input} />}
        </div>
        <div className={styles.footer}>
          <button type="button" className={styles.allowChip} onClick={() => runAction("perm.allow", appStore)} data-perm-allow>
            <span className={styles.allowKey}>{displayChord("mod+y")}</span>
            <span className={styles.chipLabel}> allow</span>
          </button>
          <button type="button" className={styles.denyChip} onClick={() => runAction("perm.deny", appStore)} data-perm-deny>
            <span className={styles.denyKey}>{displayChord("mod+j")}</span>
            <span className={styles.chipLabel}> deny</span>
          </button>
          {/* ALWAYS-ALLOW-UI: persist chips, foreign-MCP asks only (a Bash gate
              has no server key). "tool" scopes to the exact tool; "server" to
              every tool of that MCP server. Persist-then-respond order lives in
              commands.answerPermissionPersist. Mouse-only (no dedicated hotkey,
              KEYMAP-REDESIGN letter budget). */}
          {isMcpTool(pending.toolName) && (
            <>
              <button type="button" className={styles.persistChip} onClick={() => runAction("perm.allowTool", appStore)} data-perm-allow-tool>
                <span className={styles.chipLabel}>always allow tool</span>
              </button>
              <button type="button" className={styles.persistChip} onClick={() => runAction("perm.allowServer", appStore)} data-perm-allow-server>
                <span className={styles.chipLabel}>always allow server</span>
              </button>
            </>
          )}
          <span className={styles.spacer} />
          <span className={styles.hint}>{displayChord("mod+e")} full input · esc later</span>
        </div>
      </div>
    </OverlayCard>
  );
}
