import type { McpStoreMonitor } from "@chimera/protocol";
import { ComputerUseCard } from "../../src/components/ComputerUseCard";
import { Composer } from "../../src/components/Composer";
import { ReviewRoomScreen } from "../../src/screens/ReviewRoomScreen";
import { WelcomeScreen } from "../../src/screens/WelcomeScreen";
import { composerLocal } from "../../src/state/commands.agents";
import { WorkspaceTools } from "../../src/components/WorkspaceTools";
import { applyWorkspaceDisplay, workspaceTools, currentFleetFilter, onOpenBookmark } from "../../src/state/workspaceTools";
import { ProjectsScreen } from "../../src/screens/ProjectsScreen";
import { MemoryScreen } from "../../src/screens/MemoryScreen";
import { EventsScreen } from "../../src/screens/EventsScreen";
import { RolesScreen } from "../../src/screens/RolesScreen";
import { InboxScreen } from "../../src/screens/InboxScreen";
import { SloScreen } from "../../src/screens/SloScreen";
import { HistoryScreen } from "../../src/screens/HistoryScreen";
import { HelpScreen } from "../../src/screens/HelpScreen";
import { AgentsScreen } from "../../src/screens/AgentsScreen";
import { Footer } from "../../src/components/Footer";
import { TranscriptHeader } from "../../src/components/TranscriptHeader";
import { AccountsCard } from "../../src/components/AccountsCard";
import { MessageBody } from "../../src/components/MessageBody";
import { Markdown } from "../../src/components/Markdown";
import { OverlayOutlet } from "../../src/components/OverlayOutlet";
import "../../src/components/PathViewerCard";
import { ImportCard } from "../../src/components/ImportCard";
import React, { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import { emptyAgent, type AgentView, type TranscriptItem } from "@chimera/ui-state";
import "../../src/styles/tokens.css";
import "../../src/styles/fonts.css";
import "../../src/styles/base.css";
import { DesignWorkspace, DesignPanel } from "../../src/components/DesignWorkspace";
import { staticDesignDocument } from "../../src/design/documents";
import { SecretsSection } from "../../src/components/SecretsSection";
import { AgentShadowPane } from "../../src/components/AgentShadowPane";
import { AgentList } from "../../src/components/AgentList";
import { useStore } from "../../src/state/useStore";
import { TopBar } from "../../src/components/TopBar";
import { OverlayCard, OverlayCardHeader } from "../../src/components/OverlayCard";
import { ConfirmCard } from "../../src/components/ConfirmCard";
import { TeamFormCard } from "../../src/components/TeamFormCard";
import { QueueFormCard } from "../../src/components/QueueFormCard";
import { ChipButton } from "../../src/components/ChipButton";
import { VoiceConversationPanel } from "../../src/components/VoiceConversationPanel";
import { TranscriptSegment } from "../../src/components/TranscriptSegment";
import { TranscriptPanel } from "../../src/components/TranscriptPanel";
import { nativeCodexVoice } from "../../src/voice/nativeCodex";
import { registerActionHandler, useHotkeys } from "../../src/keymap";
import { voiceLocal } from "../../src/voice/store";
import { QueuesScreen } from "../../src/screens/QueuesScreen";
import { TeamsScreen } from "../../src/screens/TeamsScreen";
import { SettingsScreen } from "../../src/screens/SettingsScreen";
import { SpawnCard } from "../../src/components/SpawnCard";
import { appStore } from "../../src/state/store";
import {
  agentId,
  agentRecords,
  queues,
  roles,
  rpcFixture,
  rejectSchedules,
  teams,
} from "./ui-browser-data.mjs";

declare global {
  interface Window {
    __UI_QA__?: {
      show(name: Scenario): void;
      rejectSchedules(): void;
      setVoiceActive(active: boolean): void;
      pttSnapshot(): PttSnapshot;
      pttSpeak(): void;
      renameAgent(name?: string): void;
      unreadAgent(unread: boolean): void;
      quickSpawns(): unknown[];
      projectImports(): unknown[];
      finishBackground(status: string): void;
      groupMoves(): unknown[];
      addLineageAgents(): void;
      foldLineageOwner(): void;
      failNextGroupMove(): void;
      softState(phase: "busy" | "idle" | "paused"): void;
      workspaceSnapshot(): unknown;
      clearComposer(): void;
      bookmarkOpened(): number;
      secretWrites(): unknown[];
      designSanitize(source: string): string;
      customProviderRpc(): { method: string; params: Record<string, unknown> }[];
      desktop: {
        lease(owner: "a" | "b" | null, windowId?: number): void;
        set(patch: { running?: boolean; previewFails?: boolean; defer?: boolean }): void;
        pending(): unknown[];
        settle(windowId?: number): void;
        calls(): { command: string; args?: Record<string, unknown> }[];
      };
    };
    __UI_QA_RPC__?: (method: string, params?: Record<string, unknown>) => unknown;
    __UI_QA_COMPUTER__?: (command: string, args?: Record<string, unknown>) => unknown;
  }
}

type EdgeCase = "external-focus" | "cancel-focus" | "inline-child" | "portal-child" | "no-close" | "guard-popup";
type ActionScenario = "confirm-actions" | "team-actions" | "queue-actions";
type MainScreen = "review" | "welcome" | "projects" | "memory" | "events" | "roles" | "inbox" | "slo" | "runs" | "help" | "agents" | "settings" | "teams" | "queues";
type Scenario = "desktop-preview" | "workflow-transcript" | "computer-use" | "background-task" | "project-import" | "slash-codex" | "slash-claude" | "group-order" | "quick-spawn" | "workspace-tools" | "keyboard" | `screen-${MainScreen}` | "metrics" | "accounts" | "local-links" | "design" | "design-error" | "design-large" | "secrets" | "live-names" | EdgeCase | ActionScenario | "topbar" | "modal" | "voice" | "ptt" | "transcript" | "pane" | "queues" | "teams" | "settings" | "spawn";

type PttSnapshot = { starts: number; stops: number; sends: string[]; backgroundActions: number };
const ptt: PttSnapshot = { starts: 0, stops: 0, sends: [], backgroundActions: 0 };

// The page shell activates the existing dev/test seam before module evaluation. Keep the
// fixture assignment too so its RPC delegate is explicit and all PTT state remains local.
window.__CHIMERA_MOCK__ = { rpc: async (method, params) => window.__UI_QA_RPC__?.(method, params as Record<string, unknown>) };
window.__CHIMERA_VOICE_MOCK__ = { transcript: "synthetic focused transcript" };
const PushToTalkControl = React.lazy(async () => {
  const component = await import("../../src/components/PushToTalkControl");
  return { default: component.PushToTalkControl };
});
let renameSeq = 999999;
const secretWrites: unknown[] = [];
const customProviderCalls: { method: string; params: Record<string, unknown> }[] = [];
const customProviders: Record<string, Record<string, unknown>> = {};
const customAccounts: { name: string; provider: string; authType: string }[] = [];
let groupOrderFixture = false;
let groupOrderSeeded = false;
let failGroupMove = false;
const groupMoves: unknown[] = [];
const orderGroups = ["one", "two"].map((id, order) => ({ id, name: `Group ${id}`, order, createdAt: order }));
let quickSpawnFixture = false;
const quickSpawns: unknown[] = [];
const projectImports: unknown[] = [];
const quickProviders = [
  { id: "claude", label: "Claude", defaultModel: "claude-sonnet-5", models: ["claude-sonnet-5", "claude-opus-5-5"], accounts: [{ name: "claude", authType: "subscription" }, { name: "claude-work", authType: "subscription" }] },
  { id: "codex", label: "Codex", defaultModel: "gpt-6-sol", models: ["gpt-6-sol", "gpt-6-astra"], accounts: [{ name: "codex", authType: "subscription" }] },
];
const builtInProvider = {
  id: "openai", label: "OpenAI", kind: "openai-compat", baseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-5.1", models: ["gpt-5.1"], authModes: ["apiKey"],
  capabilities: { tools: true, vision: true, streaming: true }, tosNote: null,
  experimental: false, override: null, accounts: [],
};
const designSources: Record<string, string> = {
  "design-v1": '<style>body{font-family:system-ui;padding:24px;background:#f7f5f0;color:#20242c}article{padding:24px;background:white;border-radius:16px}</style><h1>Monitoring · v1</h1><article>Earlier design</article>',
  "design-v2": '<style>body{font-family:system-ui;padding:24px;background:#f7f5f0;color:#20242c}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}article{padding:24px;background:white;border-radius:16px}small{color:#777}h1{font-size:32px}</style><small>CLUSTER OVERVIEW</small><h1>Keep things cool.</h1><p>Raspberry Pi fleet · monitoring design</p><div class="cards"><article><small>AVERAGE CPU</small><h2>55.9 °C</h2></article><article><small>ONLINE NODES</small><h2>4 / 5</h2></article><article><small>FANS</small><h2>Automatic</h2></article></div><script>parent.postMessage("design-executed","*")</script><meta http-equiv="refresh" content="0;url=/__design-leak"><iframe src="/__design-leak"></iframe><img src="/__design-leak" onerror="parent.postMessage(123,`*`)"><a href="/__design-leak">Go</a><style>@import "/__design-leak"; body{background-image:url(/__design-leak)}</style>',
  "design-b": '<h1>Other agent design</h1>',
};
function designRow(id: string, agent: string, createdAt: number, path = "/synthetic/design/index.html") {
  return { id, agentId: agent, taskId: null, createdAt, path, kind: "file", label: "Cluster dashboard", sizeBytes: 1800, url: null };
}
window.__UI_QA_RPC__ = (method, params) => {
  if (groupOrderFixture) {
    if (method === "group.list") return { groups: orderGroups };
    if (method === "agent.setGroups") {
      groupMoves.push(params);
      if (failGroupMove) { failGroupMove = false; throw new Error("Synthetic membership failure"); }
      appStore.dispatch({ type: "event", event: { seq: renameSeq++, ts: Date.now(), engineId: "local", agentId: String(params?.agentId), kind: "status", data: { state: "running", groups: params?.groups } } as never });
      return { ok: true };
    }
  }
  if (quickSpawnFixture) {
    if (method === "providers.list") return quickProviders;
    if (method === "accounts.list") return quickProviders.flatMap(provider => provider.accounts.map(account => ({ ...account, provider: provider.id })));
    if (method === "providers.models") return { models: quickProviders.find(provider => provider.id === params?.provider)?.models ?? [], source: "live" };
    if (method === "agent.spawn") { quickSpawns.push(params?.spec); return { agentId: "quick-synthetic" }; }
  }
  if (["providers.addCustom", "providers.list", "providers.models", "accounts.add", "accounts.setKey", "accounts.list"].includes(method)) {
    customProviderCalls.push({ method, params: { ...params } });
  }
  if (method === "providers.addCustom") {
    const id = String(params?.id);
    customProviders[id] = {
      ...params, kind: "openai-compat", models: [String(params?.defaultModel)],
      authModes: params?.requiresKey ? ["apiKey"] : [], capabilities: { tools: true, vision: true, streaming: true },
      tosNote: null, experimental: false, override: null, custom: true, accounts: [],
    };
    return { id };
  }
  if (method === "accounts.add") {
    customAccounts.push({ name: String(params?.name), provider: String(params?.provider), authType: "keychain" });
    return {};
  }
  if (method === "accounts.setKey") return {};
  if (method === "accounts.list") return customAccounts;
  if (method === "providers.list") return [builtInProvider, ...Object.values(customProviders).map((provider) => ({
    ...provider,
    accounts: customAccounts.filter((account) => account.provider === provider.id).map(({ name, authType }) => ({ name, authType })),
  }))];
  if (method === "providers.models") {
    const provider = String(params?.provider);
    return provider in customProviders
      ? { models: ["discovered-chat", String(customProviders[provider]?.defaultModel)], source: "live" }
      : { models: ["gpt-5.1"], source: "catalog" };
  }
  if (method === "fs.resolve") {
    const path = String(params?.path);
    if (!path.startsWith("/synthetic/design/")) return null;
    const image = path.endsWith(".png");
    return { project: "fixture", relPath: path, result: {
      path, encoding: image ? "base64" : "utf8", binary: image, mediaType: image ? "image/png" : null,
      content: image ? "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6b9sAAAAASUVORK5CYII=" : "# Design guide\n\nOpen the Design tab.\nThird line.",
      truncated: false, sizeBytes: 80,
    } };
  }

  if (method === "artifact.list" && params?.agentId === "design-a") return [designRow("design-v1", "design-a", 100), designRow("design-v2", "design-a", 200)];
  if (method === "artifact.list" && params?.agentId === "design-b") return [designRow("design-b", "design-b", 100)];
  if (method === "artifact.read") return designSources[String(params?.id)] ?? "";

  if (method === "secret.list") return { secrets: [
    { name: "monitoring/read-token", description: "Read-only monitoring access for incident investigation.", updatedAt: 1, grants: [{ agentId, agentLabel: "stale label", mode: "reveal" }] },
    { name: "deploy/isolated-fixture-key", description: "Synthetic value only; no production account access.", updatedAt: 1, grants: [] },
  ] };
  if (method.startsWith("secret.")) { secretWrites.push({ method, params }); return {}; }
  if (method === "voice.session.start") {
    ptt.starts++;
    return { sessionId: "ui-qa-ptt", agentId: params?.agentId, state: "listening", startedAt: 0 };
  }
  if (method === "voice.session.stop") {
    ptt.stops++;
    return { stopped: true };
  }
  if (method === "mcpstore.monitor") return desktop.monitor;
  return rpcFixture(method, params);
};
appStore.dispatch({ type: "daemonStatus", status: rpcFixture("daemon.status") as never });
appStore.dispatch({ type: "agentRecords", records: agentRecords as never });
appStore.dispatch({ type: "teams", available: true, items: teams });
appStore.dispatch({ type: "queues", available: true, items: queues });
appStore.dispatch({ type: "roles", available: true, items: roles });

// The desktop-control preview is driven by two seams the real component already reads: the daemon's
// `mcpstore.monitor` lease (above) and the Rust commands (this hook, swapped in for native/computerUse).
const desktopAgentB = "ui-qa-agent-b";
const desktopActivities: McpStoreMonitor["activities"] = [
  { id: 1, ts: 1000, agentId: agentId, tool: "click", state: "succeeded" },
  { id: 2, ts: 1001, agentId: desktopAgentB, tool: "type_text", state: "succeeded" },
  { id: 3, ts: 1002, agentId: agentId, tool: "screenshot", state: "succeeded" },
];
const releasedLease: McpStoreMonitor = { held: false, owner: null, busy: false, windowId: null, activities: desktopActivities };
const desktop = {
  running: true,
  previewFails: false,
  defer: false,
  frames: 0,
  monitor: releasedLease,
  pending: [] as { windowId: unknown; resolve: (frame: string) => void }[],
  calls: [] as { command: string; args?: Record<string, unknown> }[],
};
const desktopFrame = (label: string) => "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#20242c"/><text x="32" y="70" fill="white" font-size="25">${label}</text><rect x="32" y="130" width="180" height="60" fill="#9aa3f2"/></svg>`);
window.__UI_QA_COMPUTER__ = (command, args) => {
  desktop.calls.push({ command, args });
  if (command === "computer_use_status") return { configured: true, running: desktop.running, autoStart: true, permissionOwner: "Chimera", accessibility: true, screenRecording: true };
  if (command === "computer_use_stop") { desktop.running = false; return { configured: true, running: false, autoStart: false }; }
  if (command === "computer_use_preview") {
    if (desktop.previewFails) throw new Error("Target window is unavailable");
    const windowId = args?.windowId;
    if (desktop.defer) return new Promise<string>(resolve => desktop.pending.push({ windowId, resolve }));
    return desktopFrame(`Fixture target · window ${String(windowId)} · frame ${++desktop.frames}`);
  }
  throw new Error(`unexpected native command ${command}`);
};

const transcript: TranscriptItem[] = [
  { role: "assistant", text: "outside before", streaming: false, ts: 100, seq: 1 },
  { role: "tool", toolName: "Read", status: "called", toolId: "tool-1", ts: 200, seq: 2 },
  { role: "tool", toolName: "Read", status: "done", toolId: "tool-1", result: "ok", ts: 250, seq: 3 },
  { role: "assistant", text: " \n\t", streaming: false, ts: 275, seq: 4 },
  { role: "assistant", text: "inside assistant", streaming: false, ts: 300, seq: 5 },
  { role: "user", text: "inside user", ts: 400, seq: 6 },
  { role: "assistant", text: "outside after", streaming: false, ts: 500, seq: 7 },
];

const transcriptAgent: AgentView = {
  ...emptyAgent(agentId),
  state: "done",
  displayLabel: "UI QA Agent",
  provider: "codex",
  account: "synthetic-codex",
  usage: { input: 9_000_000, output: 100, cacheRead: 0, cacheCreation: 0 },
  ctxUsage: null,
  effectiveContextLimit: 922_000,
  transcript,
  historyLoaded: true,
  historyLoadState: "loaded",
};

const transcriptAgentB: AgentView = {
  ...emptyAgent(desktopAgentB),
  state: "done",
  displayLabel: "UI QA Agent B",
  provider: "codex",
  account: "synthetic-codex",
  transcript: [{ role: "assistant", text: "Agent B is reviewing the changelog.", streaming: false, ts: 100, seq: 1 }],
  historyLoaded: true,
  historyLoadState: "loaded",
};

function Stage({ children }: { children: React.ReactNode }) {
  return <div style={{ width: "100vw", height: "100vh", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>{children}</div>;
}

function PaneStage({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <Stage>
      <div
        data-ui-qa-pane={name}
        style={{ width: 630, maxWidth: "100%", height: 720, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        {children}
      </div>
    </Stage>
  );
}

function ModalProbe() {
  const [open, setOpen] = useState(false);
  const [nestedOpen, setNestedOpen] = useState(false);
  const [switchCount, setSwitchCount] = useState(0);
  return (
    <Stage>
      <TopBar />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <aside style={{ width: 300, flex: "0 0 300px", padding: 24 }}>
          <button type="button" data-agent-switch onClick={() => setSwitchCount((count) => count + 1)}>
            switch agent {switchCount}
          </button>
        </aside>
        <div data-modal-pane style={{ position: "relative", width: 630, maxWidth: "100%", minWidth: 0, padding: 24 }}>
          <button type="button" data-modal-opener onClick={() => setOpen(true)}>open dialog</button>
          <button type="button" data-background-action>pane background action</button>
          {open ? (
            <OverlayCard width={420} onClose={() => setOpen(false)}>
              <OverlayCardHeader title="UI regression dialog" />
              <div style={{ display: "flex", gap: 8, padding: 16 }}>
                <button type="button" data-modal-hidden style={{ display: "none" }}>hidden action</button>
                <button type="button" data-modal-first autoFocus>first action</button>
                <button type="button" data-modal-nested-opener onClick={() => setNestedOpen(true)}>nested dialog</button>
                <button type="button" data-modal-last>last action</button>
              </div>
              {nestedOpen ? createPortal(
                <OverlayCard width={320} ariaLabel="Nested UI regression dialog" onClose={() => setNestedOpen(false)}>
                  <OverlayCardHeader title="Nested dialog" />
                  <div style={{ display: "flex", gap: 8, padding: 16 }}>
                    <button type="button" data-modal-nested-first autoFocus>nested first</button>
                    <button type="button" data-modal-nested-last>nested last</button>
                  </div>
                </OverlayCard>,
                document.body,
              ) : null}
            </OverlayCard>
          ) : null}
        </div>
      </div>
    </Stage>
  );
}

function OverlayEdgeProbe({ mode }: { mode: EdgeCase }) {
  const [open, setOpen] = useState(false);
  const [child, setChild] = useState(false);
  const [popup, setPopup] = useState(true);
  const nested = child ? <OverlayCard width={250} onClose={() => setChild(false)} escGuard={() => popup}>
    <OverlayCardHeader title="Child card" />
    <button data-edge-child autoFocus onKeyDown={(event) => {
      if (event.key === "Escape" && popup) { event.stopPropagation(); setPopup(false); }
    }}>{popup ? "popup open" : "popup closed"}</button>
  </OverlayCard> : null;
  return <Stage><TopBar /><button data-edge-outside>outside action</button>
    <button data-edge-opener onClick={() => {
      flushSync(() => { setOpen(true); setChild(mode === "inline-child" || mode === "portal-child" || mode === "guard-popup"); });
      if (mode === "external-focus") document.querySelector<HTMLButtonElement>("[data-edge-outside]")!.focus();
      if (mode === "cancel-focus") flushSync(() => setOpen(false));
    }}>open edge case</button>
    <div style={{ position: "relative", width: 630, height: 600 }}>
      {open && <OverlayCard width={400} onClose={mode === "no-close" ? undefined : () => setOpen(false)}>
        <OverlayCardHeader title="Parent card" />
        <button data-edge-parent>parent action</button>
        {mode === "portal-child" ? createPortal(nested, document.body) : nested}
      </OverlayCard>}
    </div>
  </Stage>;
}

function VoiceProbe() {
  const [open, setOpen] = useState(true);
  return (
    <PaneStage name="voice">
      <button type="button" data-voice-toggle onClick={() => setOpen(true)}>show voice history</button>
      <div style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }} />
        <VoiceConversationPanel agentId={agentId} open={open} onClose={() => setOpen(false)} />
      </div>
    </PaneStage>
  );
}

function PttProbe() {
  useHotkeys(appStore);
  useEffect(() => registerActionHandler("a2a.history", () => { ptt.backgroundActions++; }), []);
  return (
    <Stage>
      <React.Suspense fallback={<span data-ptt-loading>loading PTT</span>}>
        <PushToTalkControl agentId={agentId} onSend={(text) => ptt.sends.push(text)} />
      </React.Suspense>
    </Stage>
  );
}

function WorkflowTranscriptProbe() {
  const state = useStore(s => s);
  const selected = state.selectedAgentId ? state.agents[state.selectedAgentId] : null;
  return <Stage><div data-workflow-probe style={{ display: "flex", flex: 1, minHeight: 0 }}>
    <aside style={{ width: 360 }}><AgentList /></aside>
    <div style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
      <TranscriptSegment agent={state.agents["workflow-owner"]!} canInterrupt={false} isLive={true} />
      {selected?.shadow ? <div data-inspected-workflow={selected.agentId}><AgentShadowPane agent={selected} /></div> : null}
    </div>
  </div></Stage>;
}

function BackgroundTaskProbe() {
  const state = useStore((s) => s);
  return <Stage><div style={{padding: 18}}><TranscriptSegment agent={state.agents[agentId]!} canInterrupt={false} isLive={true} /></div></Stage>;
}

function TranscriptProbe() {
  return (
    <PaneStage name="transcript-window">
      <div data-transcript-fixture style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 18 }}>
        <TranscriptSegment
          agent={transcriptAgent}
          timeWindow={{ startedAt: 200, endedAt: 400 }}
          events={[{ seq: 5, ts: 300, engineId: "local", agentId, kind: "message_complete", data: { text: "inside assistant" } }]}
          canInterrupt={false}
          isLive={false}
        />
      </div>
    </PaneStage>
  );
}

function PaneProbe() {
  return (
    <PaneStage name="transcript">
      <TranscriptPanel agent={transcriptAgent} />
    </PaneStage>
  );
}

function DesktopPreviewProbe() {
  const [selected, setSelected] = useState<"a" | "b">("a");
  const size = { width: 630, maxWidth: "100%" } as const;
  return (
    <Stage>
      <div style={{ display: "flex", gap: 8, padding: 6, flexShrink: 0 }}>
        <button data-select-agent="a" aria-pressed={selected === "a"} onClick={() => setSelected("a")}>Agent A</button>
        <button data-select-agent="b" aria-pressed={selected === "b"} onClick={() => setSelected("b")}>Agent B</button>
      </div>
      <div data-ui-qa-pane="desktop-preview" style={{ ...size, flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <TranscriptPanel agent={selected === "a" ? transcriptAgent : transcriptAgentB} />
      </div>
      {/* The real composer lives below the transcript (AgentsScreen); a textarea is enough to prove it stays reachable. */}
      <textarea data-ui-qa-composer aria-label="Message the agent" style={{ ...size, height: 64, boxSizing: "border-box", flexShrink: 0 }} />
    </Stage>
  );
}

function ActionProbe({ name }: { name: ActionScenario }) {
  const [confirm, setConfirm] = useState(0);
  const [submit, setSubmit] = useState(0);
  const [close, setClose] = useState(0);
  const [disabled, setDisabled] = useState(0);
  const counters = JSON.stringify({ confirm, submit, close, disabled });
  const onSubmit = async () => {
    setSubmit((value) => value + 1);
  };
  return (
    <Stage>
      <div data-ui-qa-action-host style={{ position: "relative", width: 630, maxWidth: "100%", height: "100%", minWidth: 0, overflow: "hidden" }}>
        <output data-ui-qa-action-counts>{counters}</output>
        <ChipButton data-ui-qa-disabled-action disabled onClick={() => setDisabled((value) => value + 1)}>disabled synthetic action</ChipButton>
        {name === "confirm-actions" ? (
          <ConfirmCard
            title="confirm synthetic destructive action"
            body="This long confirmation explains the irreversible synthetic action while retaining every word inside the constrained card host."
            note="Synthetic fixture only."
            confirmLabel="confirm action"
            onConfirm={() => setConfirm((value) => value + 1)}
            onClose={() => setClose((value) => value + 1)}
          >
            <input data-confirm-editable aria-label="editable confirmation note" />
          </ConfirmCard>
        ) : name === "team-actions" ? (
          <TeamFormCard
            mode="edit"
            initial={{ name: "quality-team", role: "dev", maxConcurrent: "2", cwd: "/synthetic/project", queue: "", purpose: "", model: "", persistent: "", instructions: "long synthetic instructions for the constrained host" }}
            onSubmit={onSubmit}
            onClose={() => setClose((value) => value + 1)}
          />
        ) : (
          <QueueFormCard
            mode="edit"
            initial={{ name: "quality-queue", retryLimit: "2" }}
            onSubmit={onSubmit}
            onClose={() => setClose((value) => value + 1)}
          />
        )}
      </div>
    </Stage>
  );
}

function LiveNamesProbe() {
  const agent = useStore((s) => s.agents[agentId]);
  return <Stage><div style={{ display: "flex", height: "100%", minHeight: 0 }}>
    <div data-live-list style={{ width: 420, minWidth: 0 }}><AgentList /></div>
    <div data-live-transcript style={{ flex: 1, minWidth: 0 }}><TranscriptPanel agent={{ ...agent!, transcript: transcriptAgent.transcript, historyLoaded: true, historyLoadState: "loaded" }} /></div>
  </div></Stage>;
}
function DesignProbe() {
  const [agent, setAgent] = useState("design-a");
  return <Stage><button data-design-switch onClick={() => setAgent((s) => s === "design-a" ? "design-b" : "design-a")}>Switch agent</button><DesignWorkspace scope={{ agentId: agent }} label={agent}><div data-design-conversation style={{ flex: 1, padding: 24 }}>Conversation for {agent}</div></DesignWorkspace></Stage>;
}
function MetricsProbe() {
  const [large, setLarge] = useState(false);
  return <Stage><div data-metrics-probe style={{ minWidth: 0, overflow: "auto", containerType: "inline-size", containerName: "agent-transcript" }}>
    <TranscriptHeader name="codex-prompt-engineer-with-a-very-long-agent-name" fullId="8eb20180-058c-469f-9ba4-bc36447d550c" state="running" tone="success" overBudget={false}
      model="gpt-6-astra" effort="high" account="codex-account-with-a-very-long-name" costUsd={12.34} usageTotal={113696}
      usage={{ input: 113101, output: 20007, cacheRead: large ? 2293760 : 2000, cacheCreation: 0 }}
      contextLimits={{ source: "codex", defaultWindow: 272000, maxWindow: large ? 1050000 : 872000, sessionWindow: 258400, compactAt: 120000 }} fullContext={109416} limit={258400} ring={[1200, 1800]} compacting={large} hint={{ above: 38, below: 0 }}
      detailOpen={false} onToggleDetail={() => {}} onAction={() => {}} onToggleVoiceHistory={() => {}} />
    <button data-metrics-update onClick={() => setLarge(!large)}>Update usage</button>
    <MessageBody text={"Long continuous text: " + "measurement".repeat(80) + "\n\nA readable paragraph with all controls retained."} done rawView={false} />
  </div></Stage>;
}
function TopbarProbe() {
  useEffect(() => registerActionHandler("system.accounts", () => appStore.dispatch({ type: "accountsOpen", open: !appStore.getState().accountsOpen })), []);
  return <Stage><TopBar /><AccountsCard /><div style={{ flex: 1 }} /></Stage>;
}

let openedBookmark=0;
function WorkspaceToolsProbe() {
  useEffect(()=>onOpenBookmark(()=>{openedBookmark++;}),[]);
  useEffect(()=>{applyWorkspaceDisplay();return workspaceTools.subscribe(applyWorkspaceDisplay);},[]);
  return <Stage><WorkspaceTools onClose={()=>{}}/></Stage>;
}

function KeyboardProbe() {
  useHotkeys(appStore);
  const [runs, setRuns] = useState(0);
  const [voices, setVoices] = useState(0);
  useEffect(() => {
    const off = registerActionHandler("agents.spawn", () => setRuns(n => n + 1));
    const offVoice = registerActionHandler("voice.conversationToggle", () => setVoices(n => n + 1));
    return () => {off(); offVoice();};
  }, []);
  return <Stage><input aria-label="Shortcut test draft" data-keyboard-input defaultValue="A draft to preserve" /><button data-keyboard-next>Next focus target</button><output data-keyboard-runs>{runs}</output><output data-keyboard-voices>{voices}</output><HelpScreen /><Footer /></Stage>;
}

function MainScreenProbe({ name }: { name: MainScreen }) {
  const screens = { review:ReviewRoomScreen, welcome:WelcomeScreen, projects: ProjectsScreen, memory: MemoryScreen, events: EventsScreen,
    roles: RolesScreen, inbox: InboxScreen, slo: SloScreen, runs: HistoryScreen, help: HelpScreen,
    agents: AgentsScreen, settings: SettingsScreen, teams: TeamsScreen, queues: QueuesScreen };
  const Screen = screens[name];
  return <Stage><TopBar /><main data-screen-probe={name} style={{display:"flex",flexDirection:"column",flex:1,minWidth:0,minHeight:0}}><Screen /></main><Footer /></Stage>;
}

function ScenarioView({ name }: { name: Scenario }) {
  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => { document.body.dataset.fixtureReady = name; });
    });
    return () => { cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame); };
  }, [name]);
  if (name === "slash-codex" || name === "slash-claude") return <Stage><div style={{padding: 24, marginTop: 260}}><Composer /></div></Stage>;
  if (name === "group-order") return <MainScreenProbe name="agents" />;
  if (name === "workflow-transcript") return <WorkflowTranscriptProbe />;
  if (name === "background-task") return <BackgroundTaskProbe />;
  if (name === "project-import") return <Stage><ImportCard teams={["crew"]} importDirHint="/synthetic/projects" onClose={() => {}} onSubmit={async (values) => { projectImports.push(values); }} /></Stage>;
  if (name === "quick-spawn") return <MainScreenProbe name="agents" />;
  if (name === "workspace-tools") return <WorkspaceToolsProbe/>;
  if (name === "keyboard") return <KeyboardProbe />;
  if (name.startsWith("screen-")) return <MainScreenProbe name={name.slice(7) as MainScreen} />;
  if (name === "metrics") return <MetricsProbe />;
  if (name === "accounts") return <Stage><AccountsCard /></Stage>;
  if (name === "local-links") return <Stage><div data-local-links style={{ padding: 24 }}>
    <MessageBody text="[Önizleme görüntüsü](/synthetic/design/design-split.png) · [Kullanım rehberi](</synthetic/design/My Guide.md>) · [Satır](/synthetic/design/My%20Guide.md:3) · [Missing](/not-allowed/missing.md) · [Unsafe](javascript:alert)" done rawView={false} />
    <Markdown text="[Result guide](/synthetic/design/My%20Guide.md)" />
    <OverlayOutlet host="agents" />
  </div></Stage>;

  if (name === "design") return <DesignProbe />;
  if (name === "design-error") return <Stage><DesignPanel scope={{ agentId: "error" }} label="Error fixture" request={async () => { throw new Error("Synthetic list failure"); }} /></Stage>;
  if (name === "design-large") return <Stage><DesignPanel scope={{ agentId: "large" }} label="Large fixture" request={async <T,>() => [{ ...designRow("large", "large", 1), sizeBytes: 2000000 }] as T} readSnapshot={async () => { throw new Error("Oversize snapshot must not be read"); }} /></Stage>;
  if (name === "secrets") return <Stage><div style={{ padding: 16, overflow: "auto", minWidth: 0 }}><SecretsSection /></div></Stage>;
  if (name === "live-names") return <LiveNamesProbe />;
  if (name === "topbar") return <TopbarProbe />;
  if (name === "modal") return <ModalProbe />;
  if (name === "voice") return <VoiceProbe />;
  if (name === "ptt") return <PttProbe />;
  if (name === "transcript") return <TranscriptProbe />;
  if (name === "pane") return <PaneProbe />;
  if (name === "queues") return <PaneStage name="queues"><QueuesScreen /></PaneStage>;
  if (name === "teams") return <PaneStage name="teams"><TeamsScreen /></PaneStage>;
  if (name === "desktop-preview") return <DesktopPreviewProbe />;
  if (name === "computer-use") return <Stage><ComputerUseCard request={computerRequest} /></Stage>;
  if (name === "settings") return <Stage><SettingsScreen /></Stage>;
  if (name === "spawn") return <Stage><SpawnCard onClose={() => {}} /></Stage>;
  if (name === "confirm-actions" || name === "team-actions" || name === "queue-actions") return <ActionProbe name={name} />;
  return <OverlayEdgeProbe mode={name as EdgeCase} />;
}

let root: Root | null = null;
let computerStatus = { autoStart: false, configured: true, running: false, permissionOwner: "Chimera", accessibility: false, screenRecording: false };
const computerRequest = async (command: string) => {
  if (command === "computer_use_start") computerStatus = { ...computerStatus, running: true, autoStart: true };
  if (command === "computer_use_stop") computerStatus = { ...computerStatus, running: false, autoStart: false };
  if (command === "computer_use_permissions") computerStatus = { ...computerStatus, accessibility: true, screenRecording: true };
  return computerStatus;
};
function show(name: Scenario): void {
  if (name === "desktop-preview") {
    Object.assign(desktop, { running: true, previewFails: false, defer: false, frames: 0, monitor: releasedLease, pending: [], calls: [] });
    appStore.dispatch({ type: "agentRecords", records: [{ ...agentRecords[0], agentId: desktopAgentB, displayLabel: "UI QA Agent B", treeId: desktopAgentB }] as never });
    appStore.dispatch({ type: "selectAgent", agentId });
  }
  if (name === "workflow-transcript") {
    appStore.dispatch({ type: "agentRecords", records: [
      { agentId: "workflow-owner", state: "running", treeId: "workflow-owner", depth: 0, createdAt: 1 },
      ...["old", "new"].map((task, i) => ({ agentId: `shadow:workflow-owner:${task}`, state: i ? "running" : "done", treeId: "workflow-owner", parentId: "workflow-owner", depth: 1, createdAt: i + 2,
        shadow: true, label: "ai-review", shadowInfo: { workflowName: "ai-review" } })),
    ] as never });
    for (const taskId of ["old", "new"]) {
      for (const [kind, data] of [
        ["tool_call", { toolName: "Workflow", toolId: `call-${taskId}`, input: { name: "ai-review" } }],
        ["agent_task", { taskId, toolUseId: `call-${taskId}`, workflowName: "ai-review", status: taskId === "old" ? "completed" : "running" }],
        ["tool_result", { toolId: `call-${taskId}`, result: "Workflow launched in background" }],
      ] as const) appStore.dispatch({ type: "event", event: { agentId: "workflow-owner", seq: renameSeq++, ts: Date.now(), kind, data } });
    }
    appStore.dispatch({ type: "selectAgent", agentId: "workflow-owner" });
  }
  if (name === "background-task") {
    appStore.dispatch({ type: "event", event: { agentId, seq: renameSeq++, ts: Date.now(), kind: "agent_task", data: { taskId: "bg-browser", taskType: "local_bash", isBackgrounded: true, description: "Start Atlas CLI device login", status: "running" } } });
  }
  groupOrderFixture = name === "group-order";
  if (groupOrderFixture) {
    appStore.dispatch({ type: "selectTab", tab: "agents" });
    if (!groupOrderSeeded) {
      localStorage.removeItem("chimera.agentList.order.v1");
      const records = [
        { agentId: "sort-a", groups: ["one"] },
        { agentId: "sort-child", parentId: "sort-a", treeId: "sort-a", depth: 1 },
        { agentId: "sort-b", groups: ["one"] },
        { agentId: "sort-c", groups: ["two"] },
        { agentId: "sort-u" }, { agentId: "sort-v" },
      ].map(record => ({ state: "running", createdAt: 50, provider: "claude", accountName: "synthetic", treeId: record.agentId, depth: 0, ...record, spec: { displayLabel: record.agentId } }));
      appStore.dispatch({ type: "agentRecords", records: records as never });
      groupOrderSeeded = true;
    }
  }
  quickSpawnFixture = name === "quick-spawn" || name === "project-import";
  if (name === "project-import") projectImports.length = 0;
  if (name === "slash-codex" || name === "slash-claude") {
    appStore.dispatch({ type: "agentRecords", records: [{ ...agentRecords[0], provider: name === "slash-codex" ? "codex" : "claude", state: "running" }] as never });
    appStore.dispatch({ type: "selectAgent", agentId });
    if (name === "slash-claude") appStore.dispatch({ type: "event", event: { agentId, seq: renameSeq++, ts: Date.now(), kind: "commands_changed", data: { commands: [{ name: "audit", description: "SDK-discovered audit command" }] } } });
    composerLocal.set({ composeText: name === "slash-codex" ? "/go" : "/aud", slashDismissed: false, slashIndex: 0, target: "selected" });
  }

  if (quickSpawnFixture) {
    quickSpawns.length = 0;
    composerLocal.set({ spawnOpen: false });
    appStore.dispatch({ type: "selectTab", tab: "agents" });
  }
  if (name.startsWith("screen-") && name !== "screen-help" && name !== "screen-review" && name !== "screen-welcome") appStore.dispatch({type:"selectTab", tab: name.slice(7) as never});
  if (name === "keyboard") appStore.dispatch({type:"selectTab",tab:"agents"});
  if(name === "screen-review") {
    appStore.dispatch({type:"reviewRoomOpen",taskId:"ui-review"});
    appStore.dispatch({type:"reviewRoomLoaded",taskId:"ui-review",session:null,evidence:{taskId:"ui-review",queue:"qa",state:"done",workflow:null,steps:[],artifacts:[],provenance:[]} as never});
  }
  if(name === "workspace-tools") {
    const agent = appStore.getState().agentOrder[0]!;
    appStore.dispatch({type:"selectAgent",agentId:agent});
    appStore.dispatch({type:"event",event:{seq:renameSeq++,ts:Date.now(),engineId:"local",agentId:appStore.getState().agents[agent]!.agentId,kind:"message",data:{text:"Bookmark browser probe",role:"user"}} as never});
  }
  document.body.dataset.fixtureReady = "pending";
  if (name === "secrets" || name === "live-names") appStore.dispatch({ type: "agentRecords", records: [{ ...agentRecords[0], state: "running", displayLabel: "UI QA Agent" }] as never });
  appStore.dispatch({ type: "accountsOpen", open: name === "accounts" });
  if (name === "accounts") {
    appStore.dispatch({ type: "daemonStatus", status: { ...rpcFixture("daemon.status") as object, accounts: ["claude", "codex"].map(provider => ({ name: provider + "-account-with-a-very-long-name", provider, quota: { windows: [ { kind: "session", usedFraction: 0.25, windowStartedAt: Date.now() - 1000, resetsAt: Date.now() + 600000 }, { kind: "weekly", variant: "seven_day_sonnet", usedFraction: 0.5, windowStartedAt: Date.now() - 1000, resetsAt: Date.now() + 86400000 } ] } })) } as never });
    appStore.dispatch({ type: "accountsOpen", open: true });
  }
  if (name !== "accounts") appStore.dispatch({ type: "daemonStatus", status: rpcFixture("daemon.status") as never });
  root?.unmount();
  const host = document.getElementById("root")!;
  host.replaceChildren();
  root = createRoot(host);
  root.render(<ScenarioView name={name} />);
}

window.__UI_QA__ = {
  show,
  rejectSchedules,
  workspaceSnapshot: () => ({data:workspaceTools.getState(),composer:composerLocal.getState().composeText,filter:currentFleetFilter()}),
  bookmarkOpened: () => openedBookmark,
  clearComposer: () => composerLocal.set({composeText:"",pendingImages:[]}),
  secretWrites: () => secretWrites,
  designSanitize: (source) => staticDesignDocument(source).html,
  customProviderRpc: () => customProviderCalls.map((call) => ({ method: call.method, params: { ...call.params } })),
  quickSpawns: () => quickSpawns,
  projectImports: () => projectImports,
  finishBackground: (status) => appStore.dispatch({ type: "event", event: { agentId, seq: renameSeq++, ts: Date.now(), kind: "agent_task", data: { taskId: "bg-browser", status, ...(status === "failed" ? { error: "exit 2" } : {}) } } }),
  groupMoves: () => groupMoves,
  addLineageAgents: () => {
    for (const data of [
      { agentId: "live-direct", parentId: "sort-b", treeId: "sort-b", depth: 1 },
      { agentId: "live-queue", originConductorId: "sort-b", treeId: "live-queue", depth: 0 },
      { agentId: "live-nested", parentId: "live-queue", treeId: "live-queue", depth: 1 },
    ]) appStore.dispatch({ type: "event", event: { seq: renameSeq++, ts: Date.now(), engineId: "local", agentId: data.agentId, kind: "status", data: { ...data, registered: true, displayLabel: data.agentId } } });
  },
  foldLineageOwner: () => appStore.dispatch({ type: "collapse", agentId: "sort-b" }),
  failNextGroupMove: () => { failGroupMove = true; },
  unreadAgent(unread) {
    appStore.dispatch({
      type: "agentRecords",
      records: [{ ...agentRecords[0], state: "running", displayLabel: "UI QA Agent", attentionAt: 300, reviewedAt: unread ? 0 : 300 }] as never,
    });
  },
  softState(phase) {
    appStore.dispatch({ type: "agentRecords", records: [{ ...agentRecords[0], state: phase === "paused" ? "paused" : "running", displayLabel: "Monitoring investigator" }] as never });
    appStore.dispatch({ type: "event", event: { seq: renameSeq++, ts: Date.now(), engineId: "local", agentId, kind: "status", data: { turnBudgetExceeded: true } } });
    appStore.dispatch({ type: "event", event: { seq: renameSeq++, ts: Date.now(), engineId: "local", agentId, kind: phase === "busy" ? "message_delta" : "turn_complete", data: phase === "busy" ? { text: "Still working beyond the soft limit" } : {} } });
  },
  renameAgent(name = "Monitoring investigator") { appStore.dispatch({ type: "event", event: { seq: renameSeq++, engineId: "local", ts: Date.now(), agentId, kind: "status", data: { displayLabel: name } } }); },
  pttSnapshot: () => ({ ...ptt, sends: [...ptt.sends] }),
  pttSpeak: () => voiceLocal.dispatch({ type: "speaking", text: "synthetic reply" }),
  setVoiceActive(active) {
    (nativeCodexVoice as unknown as { setFixtureActive(value: boolean): void }).setFixtureActive(active);
  },
  desktop: {
    lease: (owner, windowId = 11) => { desktop.monitor = owner ? { held: true, owner: owner === "a" ? agentId : desktopAgentB, busy: false, windowId, activities: desktopActivities } : releasedLease; },
    pending: () => desktop.pending.map(p => p.windowId),
    set: (patch) => { Object.assign(desktop, patch); },
    // Resolves in-flight captures with a frame labelled by the window it was TAKEN for, so a late
    // frame of the previous owner is recognisable if it ever reaches the screen.
    settle: (windowId) => {
      const open = desktop.pending.filter(p => windowId === undefined || p.windowId === windowId);
      desktop.pending = desktop.pending.filter(p => !open.includes(p));
      for (const p of open) p.resolve(desktopFrame(`Late capture · window ${String(p.windowId)}`));
    },
    calls: () => desktop.calls.map(call => ({ ...call })),
  },
};
show("topbar");
