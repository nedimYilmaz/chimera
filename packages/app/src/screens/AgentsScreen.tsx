import { conversationForkOwnsEscape } from "../state/conversationFork";
import { contextShareOwnsEscape } from "../state/contextLinks";
import { WorkspaceTools } from "../components/WorkspaceTools";
import { useEffect, useMemo, useRef, useState } from "react";
import { budgetResumeEffect, budgetSpendSplit, isMcpTool, unseenAgentIds, type UiState } from "@chimera/ui-state";
import { isEditableTarget, isMacPlatform, registerActionHandler, runAction } from "../keymap";
import { rpcCall } from "../rpc/bridge";
import { voiceLocal } from "../voice/store";
import { stopSpeakingNow } from "../voice/session";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import {
  agentCommands,
  canInterruptSelected,
  composerLocal,
  resolveEscTier,
  useComposerLocal,
  visibleDialog,
  visiblePermission,
  visibleQuestion,
} from "../state/commands.agents";
import { isReplayActive, systemCommands, systemLocal } from "../state/commands.system"; // B7: replay disables mutating actions
import { projectsLocal } from "../state/commands.projects";
import { getHostCommands } from "../state/commands.host";
import { useAgentTasksLocal } from "../state/commands.agentTasks";
import { useWorkflowsLocal } from "../state/commands.workflows";
import { displayName } from "../state/selectors";
import { CONFIRMS } from "../copy";
import { A2ATicker } from "../components/A2ATicker";
import { AgentList } from "../components/AgentList";
import { AgentShadowPane } from "../components/AgentShadowPane";
import { Composer, resolveActiveTargets, slashMatchesFor } from "../components/Composer";
import { TerminalDock } from "../components/TerminalDock";
import { ConfirmCard } from "../components/ConfirmCard";
import { DialogCard } from "../components/DialogCard";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { FlowPane } from "../components/FlowPane";
import { FleetTelemetry } from "../components/FleetTelemetry";
import { FleetDashboard } from "../components/FleetDashboard";
import { MeetingRooms, useMeetingRooms } from "../components/MeetingRooms";
import { FleetNavigation } from "../components/FleetNavigation";
import { Liveboard } from "../components/Liveboard";
import { mcpPaletteEscape } from "../components/McpToolPalette";
import { OverlayOutlet } from "../components/OverlayOutlet";
import { PermissionCard } from "../components/PermissionCard";
import { QuestionCard } from "../components/QuestionCard";
import { SpawnCard } from "../components/SpawnCard";
import { AgentSettingsCard } from "../components/AgentSettingsCard";
import { DesignWorkspace } from "../components/DesignWorkspace";
import { TranscriptPanel, type TranscriptWorkflowData } from "../components/TranscriptPanel";
import { str } from "../state/selectors.coord";
import { stitchedStepSections, taskIdFromRowId, taskWorkflowBinding, workflowFor } from "../state/selectors.workflows";
import styles from "./AgentsScreen.module.css";
import { usePaneColumn, usePaneRow } from "../components/PaneDivider";

// W3 — the agents screen; W4 adds the composer band (SlashPopup + QueuedBar +
// strip, all inside <Composer/>), the decision overlays (PermissionCard /
// QuestionCard / SpawnCard — every one through OverlayCard inside THIS right
// column, PLAN §0.5: top bar + left rail stay interactive), and the ONE
// capture-phase key handler that owns (a) the permission answer chords above
// every other surface (TUI-017) and (b) the esc close-priority chain
// (commands.agents.ts resolveEscTier — order documented there). The handler
// registers at SCREEN mount so it always precedes any overlay's own window
// listener; stopImmediatePropagation keeps a handled key from double-firing.
type InspectorView = "dashboard" | "liveboard" | "inspector";
export function AgentsScreen() {
  const meetings = useMeetingRooms();
  const [toolsOpen,setToolsOpen]=useState(false);
  const [focus,setFocus]=useState(false);
  const [fleetView, setFleetView] = useState<InspectorView>("inspector");
  useEffect(() => { if (meetings?.open) setFleetView("inspector"); }, [meetings?.open]);
  return <div className={styles.fleetShell}>
    <FleetNavigation view={meetings?.open ? "meetings" : fleetView} onChange={view => {
      if (view === "meetings") meetings?.openRooms();
      else { if (meetings?.open) meetings.closeRooms(); setFleetView(view); }
    }} tools={<><button onClick={()=>setToolsOpen(true)}>Workspace tools</button><button aria-pressed={focus} onClick={()=>{setFocus(!focus);setFleetView("inspector");if(meetings?.open)meetings.closeRooms();}}>{focus?"Restore fleet pane":"Focus workspace"}</button></>} />
    {meetings?.open ? <div className={styles.row}><MeetingRooms /></div>
      : <AgentsWorkspace fleetView={fleetView} setFleetView={setFleetView} focus={focus} />}
    {toolsOpen && <WorkspaceTools onClose={()=>setToolsOpen(false)}/>}
  </div>;
}

// Inspector shortcuts and overlays are mounted only while its workspace is visible.
function AgentsWorkspace({ fleetView, setFleetView, focus }: { fleetView: InspectorView; setFleetView: (view: InspectorView) => void; focus:boolean }) {
  const commands = agentCommands(appStore, rpcCall);
  // F50.UI: the budget-pause banner is a SystemStrips overlay, so its release confirm has to be
  // rendered (and executed) from the screen that owns the confirm slot, same as killAgent.
  const sysCommands = systemCommands(appStore, rpcCall);
  const [leftView, setLeftView] = useState<"list" | "flow">("list");
  const selectedId = useStore((s: UiState) => s.selectedAgentId);
  const agentOrder = useStore((s: UiState) => s.agentOrder);
  const selected = useStore((s: UiState) => (s.selectedAgentId ? s.agents[s.selectedAgentId] : undefined));
  // KILL-CONFIRM: agent.kill is irreversible (terminates the live process,
  // loses in-flight work) yet was the only destructive action in the app
  // with no confirm gate — every sibling (dissolveTeam/deleteQueue/...) routes
  // through this same ConfirmAction union before the RPC fires.
  const confirm = useStore((s: UiState) => s.confirm);
  // WORKFLOW-TASK-VIEW: a task-row selection (AgentList's synthetic
  // "task:<id>" row) feeds TranscriptPanel its `workflow` prop instead of the
  // ordinary single-agent `agent` prop (WORKFLOW-UI-4 — one transcript
  // component, no separate stitched pane) — the composer band underneath
  // stays mounted either way (Composer.tsx resolves its own target/disabled
  // state off the same selection).
  const selectedTaskId = selectedId ? taskIdFromRowId(selectedId) : null;
  const tasks = useAgentTasksLocal((s) => s.tasks);
  const workflowItems = useWorkflowsLocal((s) => s.items);
  const workflowData = useMemo<TranscriptWorkflowData | undefined>(() => {
    if (!selectedTaskId) return undefined;
    const raw = tasks.find((t) => str(t["taskId"]) === selectedTaskId) ?? null;
    const binding = raw ? taskWorkflowBinding(raw) : null;
    const wf = workflowFor(binding, workflowItems);
    const sections = raw ? stitchedStepSections(raw, wf) : [];
    return { raw, workflow: wf, sections };
  }, [selectedTaskId, tasks, workflowItems]);
  const [quickSpawn, setQuickSpawn] = useState(false);
  const spawnOpen = useComposerLocal((s) => s.spawnOpen);
  const dismissedPermissions = useComposerLocal((s) => s.dismissedPermissions);
  const dismissedQuestions = useComposerLocal((s) => s.dismissedQuestions);

  // visible decision state — primitive/stable-ref selectors only (useStore's
  // referential-stability contract), objects assembled via useMemo.
  const permission = useStore((s: UiState) => visiblePermission(s, { dismissedPermissions }));
  const questionAgentId = useStore((s: UiState) => visibleQuestion(s, { dismissedQuestions })?.agentId ?? null);
  const pendingQuestion = useStore((s: UiState) => (questionAgentId ? s.agents[questionAgentId]?.pendingQuestion ?? null : null));
  const question = useMemo(
    () => (questionAgentId && pendingQuestion ? { ...pendingQuestion, agentId: questionAgentId } : null),
    [questionAgentId, pendingQuestion],
  );
  const dialogAgentId = useStore((s: UiState) => visibleDialog(s)?.agentId ?? null);
  const pendingDialog = useStore((s: UiState) => (dialogAgentId ? s.agents[dialogAgentId]?.pendingDialog ?? null : null));
  const dialog = useMemo(
    () => (dialogAgentId && pendingDialog ? { ...pendingDialog, agentId: dialogAgentId } : null),
    [dialogAgentId, pendingDialog],
  );

  // decision cards float ABOVE the composer band (mock: scrim bottom 48px) —
  // measure the band so QueuedBar/SlashPopup growth keeps the cards clear.
  const bandRef = useRef<HTMLDivElement | null>(null);
  // PANE-RESIZE: the row is the drag ceiling AND the carrier of the width custom property.
  const pane = usePaneRow("agents");
  // PANE-RESIZE: the transcript/composer split. The right COLUMN is the container the drag is
  // measured against, and the band below the seam is what carries the height.
  const composerPane = usePaneColumn("agents.composer");
  const [bottomInset, setBottomInset] = useState(48);
  useEffect(() => {
    const el = bandRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setBottomInset(el.offsetHeight + 8));
    ro.observe(el);
    setBottomInset(el.offsetHeight + 8);
    return () => ro.disconnect();
  }, []);

  // mod+r — flow/list toggle (W3, re-lettered off ctrl+f — "f" is OS-reserved).
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  useEffect(() => registerActionHandler("agents.toggleView", () => setLeftView((v) => (v === "list" ? "flow" : "list"))), []);
  useEffect(() => registerActionHandler("system.agentSettings", () => {
    const id = appStore.getState().selectedAgentId;
    if (id) setSettingsFor(id);
  }), []);

  // W4 action handlers — every mouse affordance clicks the SAME ids. Every
  // world-mutating action bows out during replay (coverage B7 "replay'de
  // send/kill çalışmaz" — W6 review MAJOR; the seam doc in commands.system.ts
  // names these exact adoption points).
  useEffect(() => {
    const offs = [
      registerActionHandler("agents.spawn", () => {
        if (isReplayActive()) return;
        setQuickSpawn(false);
        composerLocal.set({ spawnOpen: !composerLocal.getState().spawnOpen });
      }),
      // The quick path shares the spawn card but only asks for routing choices.
      registerActionHandler("agents.spawnDefault", () => {
        if (isReplayActive()) return;
        setQuickSpawn(true);
        composerLocal.set({ spawnOpen: true });
      }),
      // KILL-CONFIRM: gate behind the same ConfirmCard every other destructive
      // action uses, rather than killing the live process on a bare click/chord.
      registerActionHandler("agents.kill", () => {
        if (isReplayActive()) return;
        const state = appStore.getState();
        const agentId = state.selectedAgentId;
        if (!agentId) return;
        const agent = state.agents[agentId];
        appStore.dispatch({ type: "confirm", confirm: { kind: "killAgent", agentId, label: agent ? displayName(agent) : agentId } });
      }),
      // AGENT-RESUME-UI: pick a finished agent back up in its own worktree and session.
      //
      // Deliberately NOT behind a ConfirmCard: resuming is additive, and the confirm gate is for
      // actions that destroy. The BRIEF comes from the composer draft when there is one, because
      // resume continues a session with new instructions rather than replaying the old prompt —
      // and falls back to "carry on" for the case the operator actually described: coming back to
      // a fleet that finished overnight and wanting it to keep going.
      registerActionHandler("agents.resume", () => {
        if (isReplayActive()) return;
        const state = appStore.getState();
        const agentId = state.selectedAgentId;
        if (!agentId) return;
        const agent = state.agents[agentId];
        // "RESUME" MEANS TWO DIFFERENT THINGS, and the operator means the same one either way:
        // carry on. A PAUSED agent is held — it still has its process and its turn, so the way to
        // continue it is to release the hold. A TERMINAL one has no process left, so continuing it
        // means respawning into its session with a new brief. Sending a paused agent down the
        // second path is what produced "is paused, not terminal — interrupt or kill it before
        // resuming": a refusal telling the operator to DESTROY the thing they asked to continue.
        if (agent?.state === "paused") { void commands.releaseAgent(agentId); return; }
        const draft = composerLocal.getState().composeText.trim();
        void commands.resumeAgent(agentId, draft || "Continue where you left off.").then((ok) => {
          if (ok && draft) composerLocal.set({ composeText: "" });   // the draft became the brief
        });
      }),
      // Ad-hoc sessions design §6 "close all sessions" — batch-destructive, gated behind
      // the same ConfirmCard killAgent/closeMain use rather than firing on a bare click.
      registerActionHandler("agents.closeAllSessions", () => {
        if (isReplayActive()) return;
        appStore.dispatch({ type: "confirm", confirm: { kind: "closeAllSessions" } });
      }),
      // PURGE-TERMINAL-SESSIONS: the same gate, for the destructive-in-a-different-way sweep —
      // closeAllSessions ends live work, this deletes finished work's data.
      registerActionHandler("agents.purgeTerminalSessions", () => {
        if (isReplayActive()) return;
        appStore.dispatch({ type: "confirm", confirm: { kind: "purgeTerminalSessions" } });
      }),
      // F47: mark-seen is non-destructive and trivially re-earned (the next thing that wants
      // attention sets attentionAt again), so it fires directly — no confirm gate. These ids have
      // no KEYMAP row yet (the agents letter budget is spent and mod+m is OS-reserved), so today
      // they are reached only through runAction; AgentList's badge/sweep call the command directly
      // because they must also work when this screen is not mounted.
      registerActionHandler("agents.markSeen", () => {
        if (isReplayActive()) return;
        const id = appStore.getState().selectedAgentId;
        if (id) void agentCommands(appStore, rpcCall).markSeen([id]);
      }),
      registerActionHandler("agents.markAllSeen", () => {
        if (isReplayActive()) return;
        // F47.FIX M-2: see the TUI `M` path — a chunked fleet sweep must not half-mark on one
        // purged id. The single-agent handler above stays strict.
        void agentCommands(appStore, rpcCall).markSeen(unseenAgentIds(appStore.getState()), { skipUnknown: true });
      }),
      // F09.UI: re-deliver the prompt the selected agent never picked up. Same escape hatch as
      // markSeen above — the agents letter budget is spent, so the reach is the row badge (click)
      // and the palette. Non-destructive: it re-sends a message the operator already sent once.
      registerActionHandler("agents.resendPrompt", () => {
        if (isReplayActive()) return;
        const id = appStore.getState().selectedAgentId;
        if (id) void agentCommands(appStore, rpcCall).resendStalledPrompt(id);
      }),
      // CLOSE-CONFIRM: agent.close ends the conductor session irreversibly (the
      // next enter lazily respawns fresh, with no memory of this one) — gate it
      // behind the same ConfirmCard killAgent uses rather than firing on a bare chord.
      registerActionHandler("agents.closeMain", () => {
        if (isReplayActive()) return;
        const state = appStore.getState();
        const id = state.mainConductorId;
        if (!id) return;
        const agent = state.agents[id];
        appStore.dispatch({ type: "confirm", confirm: { kind: "closeAgent", agentId: id, label: agent ? displayName(agent) : id } });
      }),
      // Answer the VISIBLE request, not [0] — an esc-'later'-dismissed earlier
      // request may still occupy the head slot (W4 review MAJOR).
      registerActionHandler("perm.allow", () => {
        if (isReplayActive()) return;
        const p = visiblePermission(appStore.getState(), composerLocal.getState());
        if (p) void commands.answerPermission(true, p.requestId);
      }),
      registerActionHandler("perm.deny", () => {
        if (isReplayActive()) return;
        const p = visiblePermission(appStore.getState(), composerLocal.getState());
        if (p) void commands.answerPermission(false, p.requestId);
      }),
      // ALWAYS-ALLOW-UI: persist-then-allow for the VISIBLE request. MCP-gated
      // (the chips + chords only surface for mcp__ asks); server scope writes the
      // server key, tool scope the exact tool. Persist-then-respond in the command.
      registerActionHandler("perm.allowTool", () => {
        if (isReplayActive()) return;
        const p = visiblePermission(appStore.getState(), composerLocal.getState());
        if (p && isMcpTool(p.toolName)) void commands.answerPermissionPersist("tool", true, p.requestId);
      }),
      registerActionHandler("perm.allowServer", () => {
        if (isReplayActive()) return;
        const p = visiblePermission(appStore.getState(), composerLocal.getState());
        if (p && isMcpTool(p.toolName)) void commands.answerPermissionPersist("server", true, p.requestId);
      }),
      // esc — the keymap-path entry into the SAME chain the capture handler
      // walks (shadows the built-in help-only fallback while mounted).
      registerActionHandler("global.escape", () => { escChain(); }),
    ];
    return () => { for (const off of offs) off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands]);

  // THE esc close-priority chain (build item 10) — one resolver, one applier;
  // the tier order + rationale live on resolveEscTier (commands.agents.ts).
  const escChain = (): boolean => {
    const state = appStore.getState();
    const l = composerLocal.getState();
    const targetIds = resolveActiveTargets(state, l.target);
    const queued = state.outbox.filter((o) => targetIds.includes(o.agentId));
    const tier = resolveEscTier({
      // VOICE-STOP: read live (not via useVoiceStore) because this chain also runs from the
      // capture-phase listener, outside React's render.
      voiceSpeaking: voiceLocal.getState().status === "speaking",
      // tier 0 — system overlays (final-acceptance MAJOR 1): ui-state opens +
      // the W6/W7/W8 local stores. Without these the capture handler starved
      // OverlayCard's own esc listener and fell through to agent.interrupt.
      paletteOpen: state.paletteOpen,
      mcpPaletteOpen: state.mcpPaletteOpen,
      accountsOpen: state.accountsOpen,
      resultOpen: state.resultOpen,
      modelOpen: systemLocal.getState().modelOpen,
      pluginsOpen: projectsLocal.getState().pluginsOpen,
      hostToolsOpen: getHostCommands(appStore, rpcCall).getState().open,
      helpOpen: state.helpOpen,
      toolDetailOpen: l.toolDetail !== null,
      agentDetailOpen: l.agentDetail !== null,
      slashOpen: slashMatchesFor(state, l.composeText, l.slashDismissed).length > 0,
      targetMenuOpen: l.targetMenuOpen,
      spawnOpen: l.spawnOpen,
      dialogVisible: visibleDialog(state) !== null,
      questionVisible: visibleQuestion(state, l) !== null,
      permissionVisible: visiblePermission(state, l) !== null,
      composeNonEmpty: l.composeText.length > 0 || l.pendingImages.length > 0,
      queuedCount: queued.length,
      canInterrupt: canInterruptSelected(state, l, queued.length),
    });
    switch (tier) {
      case "voiceStopSpeaking": stopSpeakingNow(); return true;
      // tier 0 — each close mirrors the card's own onClose exactly;
      // mcpPalette/hostTools route through their tiered escape accessors
      // (args-form → list, profile-edit → rows) instead of blind-closing.
      case "palette": appStore.dispatch({ type: "paletteOpen", open: false }); return true;
      case "mcpPalette": mcpPaletteEscape(); return true;
      case "accounts": appStore.dispatch({ type: "accountsOpen", open: false }); return true;
      case "result": appStore.dispatch({ type: "resultOpen", open: false }); return true;
      case "model": systemLocal.set({ modelOpen: false }); return true;
      case "plugins": projectsLocal.set({ pluginsOpen: false }); return true;
      case "hostTools": getHostCommands(appStore, rpcCall).escape(); return true;
      case "help": appStore.dispatch({ type: "helpOpen", open: false }); return true;
      case "toolDetail": composerLocal.set({ toolDetail: null }); return true;
      case "agentDetail": composerLocal.set({ agentDetail: null }); return true;
      case "slash": composerLocal.set({ slashDismissed: true, slashIndex: 0 }); return true;
      case "targetMenu": composerLocal.set({ targetMenuOpen: false }); return true;
      case "spawn": composerLocal.set({ spawnOpen: false }); return true;
      case "dialog": {
        const d = visibleDialog(state);
        if (d) void commands.answerDialog(d.dialogId, { behavior: "cancelled" });
        return true;
      }
      case "question": {
        const q = visibleQuestion(state, l);
        if (q) composerLocal.set({ dismissedQuestions: new Set([...l.dismissedQuestions, q.questionId]) });
        return true;
      }
      case "permission": {
        const p = visiblePermission(state, l);
        if (p) composerLocal.set({ dismissedPermissions: new Set([...l.dismissedPermissions, p.requestId]) });
        return true;
      }
      case "clearCompose": composerLocal.set({ composeText: "", pendingImages: [], nextImageNum: 1, slashIndex: 0, slashDismissed: false }); return true;
      case "dropQueued": {
        const last = queued[queued.length - 1];
        if (last) commands.dropLastQueued(last.agentId);
        return true;
      }
      case "interrupt": void commands.interruptSelected(); return true;
      default: return false;
    }
  };

  // Capture-phase priority handler: permission chords (mod+y/j anywhere —
  // TUI-017; bare y/n with an EMPTY composer — TUI-001) + the esc chain. Both
  // must fire regardless of focus (the composer textarea swallows the
  // bubbling root-hotkey path for editable targets).
  //
  // KEYMAP-REDESIGN: "mod" resolves to ONE physical modifier per platform
  // (metaKey on macOS, ctrlKey elsewhere — isMacPlatform, same rule chordOf
  // uses) instead of accepting either unconditionally, per rule 1. perm.deny
  // moved off ctrl+n ("n" is OS-reserved) onto mod+j. The ALWAYS-ALLOW-UI
  // persist-then-allow chords (was ctrl+t/ctrl+s — both letters OS-reserved)
  // are retired as KEYBOARD bindings (KEYMAP-REDESIGN letter budget,
  // keymap.ts's KEYBINDING STANDARD comment) — perm.allowTool/perm.allowServer
  // stay reachable via PermissionCard's own persist-chip buttons below.
  useEffect(() => {
    const mac = isMacPlatform();
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.repeat) return;
      const state = appStore.getState();
      const l = composerLocal.getState();
      const hasPending = state.pendingPermissions.length > 0;
      const modPressed = mac ? ev.metaKey : ev.ctrlKey;
      if (hasPending && modPressed && !ev.altKey && (ev.key === "y" || ev.key === "j")) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        runAction(ev.key === "y" ? "perm.allow" : "perm.deny", appStore);
        return;
      }
      // TYPING-OWNS-THE-KEYBOARD: a BARE y/n answers a pending permission prompt — which means it
      // also fires as the first letter typed into any focused field. The composeText check beside
      // it only ever knew about the COMPOSER, so every other input in the app (a settings search,
      // a spawn form, a rename box, a secret's name) silently answered permission prompts instead
      // of accepting the letter. Same class as the empty-field digit removed from keymap.ts's
      // gate, in a listener that bypasses that gate by binding the window directly.
      //
      // The mod+y/mod+j branch above is deliberately left alone: a modifier chord cannot be
      // produced by ordinary typing, so it never fires by accident — which is the harm here.
      if (
        hasPending && !ev.ctrlKey && !ev.metaKey && !ev.altKey && (ev.key === "y" || ev.key === "n") &&
        !isEditableTarget(ev.target) &&
        l.composeText === "" && l.pendingImages.length === 0 && !l.spawnOpen
      ) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        runAction(ev.key === "y" ? "perm.allow" : "perm.deny", appStore);
        return;
      }
      if (ev.key === "Escape") {
        if (contextShareOwnsEscape() || conversationForkOwnsEscape()) return;
        if (escChain()) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
        }
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands]);

  // Auto-select: nothing selected + agents exist → select the first (W3).
  // WORKFLOW-TASK-VIEW: a task-row selection ("task:<id>") never resolves in
  // state.agents — without the taskIdFromRowId escape hatch this effect would
  // immediately bounce a fresh task-row selection back to agentOrder[0] on
  // every render.
  useEffect(() => {
    // The list owns selection against its filtered rows. A second writer here
    // can undo its search fallback indefinitely, especially during roster updates.
    if (fleetView !== "inspector" || leftView !== "flow") return;
    const current = appStore.getState();
    const id = current.selectedAgentId;
    const stillValid = !!id && ((current.agentOrder.includes(id) && !!current.agents[id]) || taskIdFromRowId(id) !== null);
    const fallback = current.agentOrder.find((key) => current.agents[key]);
    if (!stillValid && fallback) {
      appStore.dispatch({ type: "selectAgent", agentId: fallback });
    }
  }, [selectedId, agentOrder, fleetView, leftView]);

  return (
      <div data-screen-layout="split" className={`${styles.row} ${focus && fleetView==="inspector" ? styles.focus : ""}`} {...pane.rowProps}>
      {fleetView === "dashboard" ? (
        // FLEET-TELEMETRY: the live panel sits ABOVE the existing grouped table rather than
        // replacing it — the table's grouping and batch actions are still the thing you reach
        // for once a number on the panel makes you look closer.
        <div className={styles.dashboardStack}>
          <FleetTelemetry onOpen={(id) => { appStore.dispatch({ type: "selectAgent", agentId: id }); setFleetView("inspector"); }} />
          <FleetDashboard onOpen={(id) => { appStore.dispatch({ type: "selectAgent", agentId: id }); setFleetView("inspector"); }} />
        </div>
      ) : fleetView === "liveboard" ? <Liveboard onOpen={(id) => { appStore.dispatch({ type: "selectAgent", agentId: id }); setFleetView("inspector"); }} /> : <>
      {leftView === "list" ? <AgentList /> : <FlowPane agent={selected} />}
      {/* PANE-RESIZE: the seam, in place of the gap that used to be here. */}
      {pane.divider}
      <div className={styles.right} {...composerPane.columnProps}>
        <DesignWorkspace scope={selectedTaskId ? { taskId: selectedTaskId } : selected ? { agentId: selected.agentId } : null} label={selectedTaskId ? "Task designs" : selected ? displayName(selected) : "Design"}>
        {selectedTaskId ? (
          <ErrorBoundary
            key={`task:${selectedTaskId}`}
            label="transcript"
            message="transcript failed to render — press r to retry"
            onError={(err) =>
              appStore.dispatch({ type: "notice", message: `transcript render failed: ${err.message}` })
            }
          >
            <TranscriptPanel agent={undefined} workflow={workflowData} />
          </ErrorBoundary>
        ) : selected?.shadow && selected.transcript.length === 0 ? (
          // R2 (inline sub-agent/workflow surfacing): a shadow with a real captured transcript
          // (supervisor.ts now routes subagent-tagged events into it) falls through to the normal
          // TranscriptPanel branch below like any other agent — its AgentView is structurally
          // identical, no TranscriptPanel change needed. AgentShadowPane stays the fallback for a
          // shadow with no transcript yet (still-starting, an older CLI, or skipTranscript).
          <AgentShadowPane agent={selected} />
        ) : (
          // Defense-in-depth: a transcript render crash degrades to a fallback
          // pane instead of unmounting the whole tree / blanking the window.
          // Keyed by agentKey so switching the selected agent remounts the
          // boundary and retries a clean render (press r retries in place).
          <ErrorBoundary
            key={selected?.agentId ?? ""}
            label="transcript"
            message="transcript failed to render — press r to retry"
            onError={(err) =>
              appStore.dispatch({ type: "notice", message: `transcript render failed: ${err.message}` })
            }
          >
            <TranscriptPanel agent={selected} />
          </ErrorBoundary>
        )}
        </DesignWorkspace>
        {/* TERMINAL-SURVIVES-AGENT-SWITCH: mounted HERE, not inside TranscriptPanel, and that
            placement is the whole point. The dock already kept every tab of every agent mounted
            (only flipping `visible`) precisely because TerminalView's unmount is the one place
            term_close fires — but it sat inside an ErrorBoundary keyed by agentId, so selecting a
            different agent changed that key, React unmounted the whole subtree, and every PTY was
            killed on the way out. Coming back attached a fresh view to a dead session.
            An invariant a component keeps for itself is still defeated by an ancestor that
            remounts it, so the dock has to be owned by something that does not. This also gets it
            back for a selected SHADOW, whose branch renders AgentShadowPane and no panel at all. */}
        <TerminalDock />
        <A2ATicker />{/* A2A-UX-OVERHAUL: overlay-only now (the pinned bar is retired) — renders the ⇄ a2a history overlay + hosts its keybinding; live traffic shows in AgentList */}
        {/* PANE-RESIZE: the second seam — the transcript above, the composer below. The band was
            content-sized before; it now carries an explicit height so the split can be moved. */}
        {composerPane.divider}
        <div ref={bandRef} className={styles.band}>
          <Composer />
        </div>
        {spawnOpen ? <SpawnCard quick={quickSpawn} onClose={() => { setQuickSpawn(false); composerLocal.set({ spawnOpen: false }); }} /> : null}
        {/* AGENT-RECONFIGURE: opened from the transcript header's ⚙ chip, always for the agent
            whose transcript is on screen — the settings you are about to change belong to the
            conversation you are reading. */}
        {settingsFor ? <AgentSettingsCard agentId={settingsFor} onClose={() => setSettingsFor(null)} /> : null}
        {dialog ? <DialogCard dialog={dialog} bottomInset={bottomInset} /> : null}
        {question ? <QuestionCard question={question} bottomInset={bottomInset} /> : null}
        {permission ? <PermissionCard pending={permission} bottomInset={bottomInset} /> : null}
        {confirm?.kind === "killAgent" && (
          <ConfirmCard
            title="⚠ kill agent"
            meta={confirm.label}
            body={CONFIRMS.killAgent(confirm.label).body}
            note={CONFIRMS.killAgent(confirm.label).note}
            confirmLabel="confirm kill"
            onConfirm={() => {
              const { agentId } = confirm;
              appStore.dispatch({ type: "confirm", confirm: null });
              void commands.killAgent(agentId);
            }}
            onClose={() => appStore.dispatch({ type: "confirm", confirm: null })}
          />
        )}
        {confirm?.kind === "purgeTerminalSessions" && (() => {
          const count = Object.values(appStore.getState().agents)
            .filter((a) => a.state === "done" || a.state === "failed" || a.state === "killed").length;
          return (
            <ConfirmCard
              title="⚠ clean up finished sessions"
              body={CONFIRMS.purgeTerminalSessions(count).body}
              note={CONFIRMS.purgeTerminalSessions(count).note}
              confirmLabel="confirm clean up"
              onConfirm={() => {
                appStore.dispatch({ type: "confirm", confirm: null });
                void commands.purgeTerminalSessions();
              }}
              onClose={() => appStore.dispatch({ type: "confirm", confirm: null })}
            />
          );
        })()}
        {confirm?.kind === "closeAllSessions" && (() => {
          const count = Object.values(appStore.getState().agents)
            .filter((a) => a.session && (a.state === "running" || a.state === "paused")).length;
          return (
            <ConfirmCard
              title="⚠ close all sessions"
              body={CONFIRMS.closeAllSessions(count).body}
              note={CONFIRMS.closeAllSessions(count).note}
              confirmLabel="confirm close all"
              onConfirm={() => {
                appStore.dispatch({ type: "confirm", confirm: null });
                void commands.closeAllSessions();
              }}
              onClose={() => appStore.dispatch({ type: "confirm", confirm: null })}
            />
          );
        })()}
        {confirm?.kind === "closeAgent" && (
          <ConfirmCard
            title="⚠ close session"
            meta={confirm.label}
            body={CONFIRMS.closeAgent(confirm.label).body}
            note={CONFIRMS.closeAgent(confirm.label).note}
            confirmLabel="confirm close"
            onConfirm={() => {
              appStore.dispatch({ type: "confirm", confirm: null });
              void commands.closeMain();
            }}
            onClose={() => appStore.dispatch({ type: "confirm", confirm: null })}
          />
        )}
        {confirm?.kind === "resumeBudget" && (
          <ConfirmCard
            title="⚠ release budget pause"
            meta={confirm.label}
            body={CONFIRMS.resumeBudget(confirm.label, budgetSpendSplit(confirm), budgetResumeEffect(confirm)).body}
            note={CONFIRMS.resumeBudget(confirm.label, budgetSpendSplit(confirm), budgetResumeEffect(confirm)).note}
            confirmLabel="confirm release"
            onConfirm={() => {
              const { treeId } = confirm;
              appStore.dispatch({ type: "confirm", confirm: null });
              void sysCommands.resumeBudget(treeId);
            }}
            onClose={() => appStore.dispatch({ type: "confirm", confirm: null })}
          />
        )}
        {/* F22.UI: both lease actions are destructive to ANOTHER agent, so they share the same
            gate every other destructive action uses — no bespoke dialog. Release adds an inline
            force toggle (re-dispatching the confirm) because the note text has to change with it:
            a forced release can strand two writers in one tree. */}
        {confirm?.kind === "worktreeLeaseHandoff" && (
          <ConfirmCard
            title="⚠ hand off worktree lease"
            meta={`${confirm.workdirKey} · ${confirm.ownerLabel} → ${confirm.label}`}
            body={CONFIRMS.worktreeLeaseHandoff(confirm.workdirKey, confirm.ownerLabel, confirm.label).body}
            note={CONFIRMS.worktreeLeaseHandoff(confirm.workdirKey, confirm.ownerLabel, confirm.label).note}
            confirmLabel="confirm handoff"
            onConfirm={() => {
              const { agentId, workdirKey, toAgentId, label } = confirm;
              appStore.dispatch({ type: "confirm", confirm: null });
              void commands.worktreeLeaseHandoff(agentId, workdirKey, toAgentId, label);
            }}
            onClose={() => appStore.dispatch({ type: "confirm", confirm: null })}
          />
        )}
        {confirm?.kind === "worktreeLeaseRelease" && (
          <ConfirmCard
            title="⚠ release worktree lease"
            meta={`${confirm.workdirKey} · held by ${confirm.ownerLabel}`}
            body={CONFIRMS.worktreeLeaseRelease(confirm.workdirKey, confirm.ownerLabel, confirm.force).body}
            note={CONFIRMS.worktreeLeaseRelease(confirm.workdirKey, confirm.ownerLabel, confirm.force).note}
            confirmLabel={confirm.force ? "confirm FORCE release" : "confirm release"}
            onConfirm={() => {
              const { agentId, workdirKey, force } = confirm;
              appStore.dispatch({ type: "confirm", confirm: null });
              void commands.worktreeLeaseRelease(agentId, workdirKey, force);
            }}
            onClose={() => appStore.dispatch({ type: "confirm", confirm: null })}
          >
            <label data-lease-force-toggle>
              <input
                type="checkbox"
                checked={confirm.force}
                onChange={(e) => appStore.dispatch({ type: "confirm", confirm: { ...confirm, force: e.target.checked } })}
              />{" "}
              force (drop the lease even if its holder is still active)
            </label>
          </ConfirmCard>
        )}
        <OverlayOutlet host="agents" bottomInset={bottomInset} />
      </div>
      </>}
      </div>
  );
}
