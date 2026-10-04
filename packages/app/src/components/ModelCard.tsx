import { useEffect, useRef, useState } from "react";
import type { UiState } from "@chimera/ui-state";
import { registerOverlay } from "./OverlayOutlet";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall } from "../rpc/bridge";
import { cycleValue } from "../state/commands.agents";
import { systemCommands, systemLocal, useSystemLocal } from "../state/commands.system";
import { displayName } from "../state/selectors";
import { overlayTargetAgentId } from "../state/selectors.workflows";
import { displayChord } from "../keymap";
import styles from "./ModelCard.module.css";

// W6 build item 3 — the ModelCard (mock showModelForm, lines 365-386): 560
// card, "change model" header + agent name + "mod+d / esc" hint, a model
// input + the live model chip row (tab/click cycle — the same list
// commands.agents.ts carries), footer [enter apply] + the "takes effect next
// turn" note. Enter → agent.setModel via SystemCommands;
// the B3 transcript chip updates when the respawned agent's agent_started
// (model_changed path) event carries the new model.
export function ModelCard() {
  const open = useSystemLocal((s) => s.modelOpen);
  // WORKFLOW-HEADER-CHIPS-DEAD: a task-row selection is the synthetic `task:<id>` string,
  // never a key in s.agents — resolve to the task's live step agent instead (null once the
  // step ends, matching the composer's own liveTaskStepAgentId gate for the same id shape).
  const agent = useStore((s: UiState) => { const id = overlayTargetAgentId(s); return id ? s.agents[id] : undefined; });
  const [model, setModel] = useState("");
  // DYNAMIC-MODEL-LISTS: chips come from providers.models for THIS AGENT's provider — no static
  // seed. The old seed was a claude-only array, so a codex or kimi agent's card offered claude
  // names until the probe answered (and kept them if it failed). Starting empty means the card
  // briefly shows no chips instead of showing wrong ones; the input is free-text regardless.
  const [modelOptions, setModelOptions] = useState<readonly string[]>([]);
  const [modelLabels, setModelLabels] = useState<Readonly<Record<string, string>>>({});
  const modelFetchSeq = useRef(0);

  // seed the field from the agent's CURRENT model on every open, AND whenever
  // the selected agent changes while the card stays mounted — the AgentList
  // lives in the left rail, outside this overlay's scrim (OverlayCard: "the
  // left rail is never covered"), so a row click while this card is open
  // re-targets `agent` without unmounting the card. Without keying off
  // agent.agentId too, a stale model string from the PREVIOUS agent would
  // apply to the newly selected one on Enter.
  useEffect(() => {
    if (!open) return;
    // Blank, not a hardcoded first-choice: pre-filling another provider's model is how a bad
    // model id gets submitted by someone who just pressed Enter.
    setModel(agent?.model ?? "");
    setModelOptions([]);
    setModelLabels({});
    if (!agent?.provider) return;
    const seq = ++modelFetchSeq.current;
    rpcCall<{
      models: string[]; source: "catalog" | "live" | "cache";
      modelDetails?: Array<{ value: string; displayName?: string; description?: string }>;
    }>("providers.models", {
      provider: agent.provider, ...(agent.account ? { account: agent.account } : {}),
    }).then((res) => {
      if (modelFetchSeq.current !== seq || !Array.isArray(res?.models) || res.models.length === 0) return;
      setModelOptions(res.models);
      setModelLabels(Object.fromEntries(
        (res.modelDetails ?? [])
          .filter((m) => m.displayName && m.displayName !== m.value)
          .map((m) => [m.value, m.displayName as string]),
      ));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agent?.agentId]);

  if (!open || !agent) return null;
  const commands = systemCommands(appStore, rpcCall);
  const close = (): void => systemLocal.set({ modelOpen: false });
  const apply = (): void => {
    if (model.trim()) void commands.applyModel(agent.agentId, model.trim());
  };

  return (
    <OverlayCard width={560} align="center" onClose={close}>
      <OverlayCardHeader title="change model" meta={displayName(agent)} hint={`${displayChord("mod+d")} / esc`} />
      <div className={styles.body}>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>model</span>
          <input
            className={styles.input}
            value={model}
            autoFocus
            spellCheck={false}
            onChange={(e) => setModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                e.preventDefault();
                setModel(cycleValue(modelOptions, model, e.shiftKey));
              } else if (e.key === "Enter") {
                e.preventDefault();
                apply();
              } else if ((e.ctrlKey || e.metaKey) && e.key === "d") {
                e.preventDefault();
                close(); // opener chord re-toggles even while the input owns focus
              }
            }}
            data-model-input
          />
        </div>
        <div className={styles.chips}>
          {modelOptions.map((m) => (
            <span
              key={m}
              className={m === model ? styles.chipActive : styles.chip}
              onClick={() => setModel(m)}
              data-model-chip={m}
            >
              {modelLabels[m] ?? m}
            </span>
          ))}
          <span className={styles.ghost}>tab cycle · click</span>
        </div>
      </div>
      <div className={styles.footer}>
        <span className={styles.applyChip} onClick={apply} data-model-apply>
          <span className={styles.applyKey}>enter</span>
          <span className={styles.applyVerb}> apply</span>
        </span>
        <span className={styles.note}>takes effect next turn</span>
      </div>
    </OverlayCard>
  );
}

registerOverlay("system.model", ModelCard, () => {
  if (systemLocal.getState().modelOpen) systemLocal.set({ modelOpen: false });
});
