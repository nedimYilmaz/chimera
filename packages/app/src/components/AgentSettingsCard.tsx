import { useEffect, useRef, useState } from "react";
import { effortLevelsFor } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { useStore } from "../state/useStore";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { AgentRealtimeSetting } from "./AgentRealtimeSetting";
import styles from "./SpawnCard.module.css";
import own from "./AgentSettingsCard.module.css";

// AGENT-RECONFIGURE: every setting of a LIVE agent, in one place, applied on save.
//
// The header's model/effort/account chips already did this for three settings, one chip at a
// time — and one at a time is the problem: each is a respawn, so adjusting three settings meant
// three restarts, each interrupting whatever turn was running. This sends one patch and costs one
// respawn for however many fields moved.
//
// The two sections are not decoration. They are the honest cost split: the top group restarts the
// process (the conversation survives, the SDK simply cannot change a running session's model or
// system prompt in place), the bottom group does not touch it at all. An operator about to fix a
// typo in a name should be able to see that it is free.

type Live = { permissionProfile?: string; permissionRequest?: string; displayLabel?: string };

// DYNAMIC-MODEL-LISTS / EFFORT-ONE-SOURCE: both lists used to be written out here. The model one
// was claude-only, so a codex or kimi agent's settings offered claude names; the effort one had
// lost BOTH ends of the vocabulary — low/medium/high/xhigh, with `minimal` and `max` simply
// unreachable from the card whose whole job is changing effort. Both now come from the provider
// (providers.models, the same probe ModelCard uses) with effortLevelsFor() deciding what to offer.
const PROFILES = ["readOnly", "acceptEdits", "full"];
const REQUESTS = ["auto", "poke:caller", "tui"];

export function AgentSettingsCard({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const agent = useStore((s) => s.agents[agentId]);
  const accounts = useStore((s) => s.accounts);
  const [patch, setPatch] = useState<Record<string, string>>({});
  const targetAccount = patch["account"] || agent?.account;
  const targetProvider = accounts.find((a) => a.name === targetAccount)?.provider ?? agent?.provider;
  const [acknowledgeRisk, setAcknowledgeRisk] = useState(false);
  // Per-provider model list plus, per MODEL, the effort tiers that provider says it accepts —
  // both from one probe, because they arrive on the same payload.
  const [models, setModels] = useState<readonly string[]>([]);
  const [effortsByModel, setEffortsByModel] = useState<Readonly<Record<string, readonly string[]>>>({});
  const fetchSeq = useRef(0);
  useEffect(() => {
    setModels([]);
    setEffortsByModel({});
    if (!targetProvider) return;
    const seq = ++fetchSeq.current;
    rpcCall<{ models: string[]; modelDetails?: Array<{ value: string; supportedEfforts?: string[] }> }>(
      "providers.models",
      { provider: targetProvider, ...(targetAccount ? { account: targetAccount } : {}) },
    ).then((res) => {
      // A late reply for a PREVIOUS agent must not repaint this card — the left rail stays
      // clickable while the overlay is open, so the target can change mid-flight (same guard
      // ModelCard carries).
      if (fetchSeq.current !== seq || !Array.isArray(res?.models)) return;
      setModels(res.models);
      setEffortsByModel(Object.fromEntries(
        (res.modelDetails ?? [])
          .filter((m) => Array.isArray(m.supportedEfforts) && m.supportedEfforts.length > 0)
          .map((m) => [m.value, m.supportedEfforts as string[]]),
      ));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.agentId, targetProvider, targetAccount]);
  const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

  // AgentView is a lightweight projection and carries no spec — maxTurns/instructions/autonomy/cwd
  // live only on the daemon's record. Fetched once on open, so the form shows what is ACTUALLY set
  // rather than blanks the operator would then "fill in" and unknowingly change.
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
  const [live, setLive] = useState<Live>({});
  // CHANGED-MEANS-CHANGED-FROM-WHAT-WAS-FETCHED: the exact values the form was seeded with, kept
  // so "did this move?" is answered against the same source that filled it in. Comparing against
  // the AgentView projection instead was wrong the moment the two disagreed — the view carries a
  // subset and lags a live /model change — and every disagreement sent a field that had not been
  // touched, respawning the agent to apply a value it already had.
  const [baseline, setBaseline] = useState<{ patch: Record<string, string>; live: Live }>({ patch: {}, live: {} });
  useEffect(() => {
    let cancelled = false;
    void rpcCall<{ spec?: Record<string, unknown>; displayLabel?: string }>("agent.status", { agentId })
      .then((rec) => {
        if (cancelled) return;
        const sp = rec.spec ?? {};
        setSpec(sp);
        // Seeded ONCE: re-seeding on every store tick would fight the operator's typing each time
        // the agent emitted an event.
        const seededPatch: Record<string, string> = {
          model: str(sp["model"] ?? agent?.model), effort: str(sp["effort"] ?? agent?.effort),
          account: str(sp["account"] ?? agent?.account),
          maxTurns: str(sp["maxTurns"]), turnLimitPolicy: str(sp["turnLimitPolicy"]),
          maxBudgetUsd: str(sp["maxBudgetUsd"]), compactionThreshold: str(sp["compactionThreshold"]),
          instructions: str(sp["instructions"]),
          autonomy: str(sp["autonomy"]), cwd: str(sp["cwd"]),
        };
        const seededLive: Live = {
          permissionProfile: agent?.permissionProfile ?? "", permissionRequest: agent?.permissionRequest ?? "",
          displayLabel: rec.displayLabel ?? agent?.displayLabel ?? "",
        };
        setPatch(seededPatch);
        setLive(seededLive);
        setBaseline({ patch: seededPatch, live: seededLive });
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [agentId]);
  const [busy, setBusy] = useState(false);
  const [realtimeBusy, setRealtimeBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: string, v: string): void => {
    if (k === "account") setAcknowledgeRisk(false);
    setPatch((p) => ({ ...p, ...(k === "account" && accounts.find((a) => a.name === v)?.provider !== targetProvider ? { model: "", effort: "" } : {}), [k]: v }));
  };

  const submit = async (): Promise<void> => {
    setBusy(true); setError(null);
    // Only CHANGED fields go in the patch — sending the whole form would make every save a
    // respawn even when nothing moved, which is the cost this panel exists to avoid.
    const changed: Record<string, unknown> = {};
    if (acknowledgeRisk) changed["acknowledgeCodexFullAccessRisk"] = true;
    // Compared field by field against the SEEDED values, as strings — the same form the operator
    // edited. Parsing first and comparing parsed values would call "40" and 40 different.
    const moved = (k: string): boolean => (patch[k] ?? "") !== (baseline.patch[k] ?? "");
    if (moved("model")) changed["model"] = patch["model"] || undefined;
    if (moved("effort")) changed["effort"] = patch["effort"] || undefined;
    if (moved("account")) changed["account"] = patch["account"] || undefined;
    if (moved("maxTurns") && patch["maxTurns"]) changed["maxTurns"] = Number(patch["maxTurns"]);
    if (moved("turnLimitPolicy")) changed["turnLimitPolicy"] = patch["turnLimitPolicy"] || undefined;
    if (moved("maxBudgetUsd")) changed["maxBudgetUsd"] = patch["maxBudgetUsd"] ? Number(patch["maxBudgetUsd"]) : null;
    // Blank means "no override" — null, not undefined, because a sparse patch drops undefined on
    // the wire and the field would silently stay at its old value instead of clearing.
    if (moved("compactionThreshold")) changed["compactionThreshold"] = patch["compactionThreshold"] ? Number(patch["compactionThreshold"]) : null;
    if (moved("instructions")) changed["instructions"] = patch["instructions"] || undefined;
    if (moved("autonomy")) changed["autonomy"] = patch["autonomy"] || undefined;

    const livePatch: Live = {};
    const liveMoved = (k: keyof Live): boolean => ((live[k] ?? "") as string) !== ((baseline.live[k] ?? "") as string);
    if (liveMoved("permissionProfile") && live.permissionProfile) livePatch.permissionProfile = live.permissionProfile;
    if (liveMoved("permissionRequest") && live.permissionRequest) livePatch.permissionRequest = live.permissionRequest;
    if (liveMoved("displayLabel") && live.displayLabel) livePatch.displayLabel = live.displayLabel;

    const movedCwd = moved("cwd") && patch["cwd"] ? patch["cwd"] : undefined;
    if (Object.keys(changed).length === 0 && Object.keys(livePatch).length === 0 && !movedCwd) { onClose(); return; }
    try {
      await rpcCall("agent.reconfigure", {
        agentId,
        ...(Object.keys(changed).length > 0 ? { patch: changed } : {}),
        ...(Object.keys(livePatch).length > 0 ? { live: livePatch } : {}),
        ...(movedCwd ? { cwd: movedCwd } : {}),
      });
      onClose();
    } catch (e) {
      // Kept OPEN on failure with the daemon's own reason inline — a refusal here names what does
      // change the field instead ("use agent_handoff"), which is unreadable from a toast that
      // closed the form holding the value it is about.
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  // FORM-GEOMETRY: the same structure SpawnCard uses, because the classes are its own —
  // `.body` supplies the card's padding and background (without it the transcript showed straight
  // through this card), and a FIELD is a `.row` of label + control. `.pair` is a two-column GRID
  // meant to hold two rows, not a label-and-input line; using it as one is what left every label
  // sitting in its own column, misaligned against the control beside it.
  const field = (key: string, label: string, opts?: string[]) => (
    <div className={styles.row} key={key}>
      <span className={styles.label}>{label}</span>
      {opts ? (
        <select className={`${styles.inputBox} ${own.nativeField}`} value={patch[key] ?? ""} onChange={(e) => set(key, e.target.value)} data-settings-field={key}>
          <option value="">—</option>
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input className={`${styles.inputBox} ${own.nativeField}`} value={patch[key] ?? ""} onChange={(e) => set(key, e.target.value)} data-settings-field={key} />
      )}
    </div>
  );

  const liveField = (key: keyof Live, label: string, opts?: string[]) => (
    <div className={styles.row} key={key}>
      <span className={styles.label}>{label}</span>
      {opts ? (
        <select
          className={`${styles.inputBox} ${own.nativeField}`}
          value={(live[key] as string) ?? ""}
          onChange={(e) => setLive((l) => ({ ...l, [key]: e.target.value }))}
          data-settings-field={key}
        >
          <option value="">—</option>
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input
          className={`${styles.inputBox} ${own.nativeField}`}
          value={(live[key] as string) ?? ""}
          onChange={(e) => setLive((l) => ({ ...l, [key]: e.target.value }))}
          data-settings-field={key}
        />
      )}
    </div>
  );

  return (
    <OverlayCard width={680} align="center" onClose={onClose}>
      <div data-agent-settings-card>
        <OverlayCardHeader
          title={`settings · ${agent?.displayLabel ?? agentId.slice(0, 8)}`}
          meta={error ? <span className={styles.error}>{error}</span> : undefined}
          hint={spec === null ? "reading current settings…" : "esc cancel"}
        />
        <div className={styles.body}>
          {/* The two groups are the honest cost split, not decoration: the SDK cannot change a
              running session's model or system prompt in place, so those restart the process (the
              conversation survives); the ones below never touch it. Someone about to fix a typo in
              a name should be able to see that it is free. */}
          <div className={styles.fieldHint}>{targetProvider !== agent?.provider ? "new provider session — source compaction + retained history transfer (up to 90s, uses source tokens)" : "restarts the process — resumes the same provider session"}</div>
          {targetProvider === "codex" && targetProvider !== agent?.provider && live.permissionProfile === "full" && <label><input type="checkbox" checked={acknowledgeRisk} onChange={(e) => setAcknowledgeRisk(e.target.checked)} />I acknowledge Codex full access runs without its sandbox.</label>}
          {field("model", "model", [...models])}
          {/* EFFORT-ONE-SOURCE: scoped to the model being SET here, not the one currently
              running — picking a model and an effort in the same edit must offer the efforts that
              new model accepts. Falls back to the provider's declared set until the probe answers,
              and to the full vocabulary for a provider we know nothing about. */}
          {field("effort", "effort", [...effortLevelsFor({
            provider: targetProvider,
            model: patch["model"] ?? agent.model,
            advertised: effortsByModel,
          })])}
          {field("account", "account")}
          <div className={styles.pair}>
            {field("maxTurns", "max turns")}
            {field("turnLimitPolicy", "turn policy", ["fail", "soft"])}
          </div>
          <div className={styles.pair}>
            {field("maxBudgetUsd", "budget $")}
            {field("autonomy", "autonomy", ["ask", "full"])}
          </div>
          {/* The context window this agent compacts against, NOT the model's native one. The CLI
              fires at ~90% of it, so 500000 compacts near 450k — the point being that a 1M agent
              left native pays for ~900k of context on every remaining turn. Blank inherits the
              account/provider default. */}
          {field("compactionThreshold", "compact at (tokens)")}
          {field("cwd", "cwd")}
          {field("instructions", "instructions")}

          {agent?.provider === "codex" && targetProvider === "codex" && spec !== null && spec["runtime"] !== "terminal" && <AgentRealtimeSetting
            key={agentId} agentId={agentId}
            enabled={(spec["providerOptions"] as Record<string, unknown> | undefined)?.["codexRealtime"] === true}
            paused={agent.state === "paused"} disabled={busy || (agent.state !== "running" && agent.state !== "paused")}
            onBusy={setRealtimeBusy}
            onChange={enabled => setSpec(previous => ({ ...previous, providerOptions: { ...(previous?.["providerOptions"] as Record<string, unknown> | undefined), codexRealtime: enabled } }))}
          />}

          <div className={styles.fieldHint}>applies live — no restart, no interrupted turn</div>
          {liveField("displayLabel", "name")}
          <div className={styles.pair}>
            {liveField("permissionProfile", "permission", PROFILES)}
            {liveField("permissionRequest", "ask routing", REQUESTS)}
          </div>
        </div>
        <div className={styles.footer}>
          <button type="button" className={styles.submitChip} disabled={busy || realtimeBusy || spec === null} onClick={() => void submit()} data-settings-apply>
            {busy ? "applying…" : "apply"}
          </button>
          <button type="button" className={styles.cancelChip} onClick={onClose} data-settings-cancel>cancel</button>
        </div>
      </div>
    </OverlayCard>
  );
}
