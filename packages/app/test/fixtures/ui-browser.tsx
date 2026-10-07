import { MessageIdentityFixture, messageIdentityFixture } from "./message-identity";
import { projectDeleteFixture } from "./project-delete";
import { RecoveryProbe, resetRecovery, recoveryRpc } from "./recovery";
import "../../src/components/ArtifactPreviewCard";
import { canvasFixture } from "./canvas-data";
import { useStore } from "../../src/state/useStore";
import { projectsLocal } from "../../src/state/commands.projects";
import { closeConversationFork } from "../../src/state/conversationFork";
import { OperatorBrowserFixture, operatorFixture } from "./operator-browser";
import { contextShareOwnsEscape, openContextShare } from "../../src/state/contextLinks";
import type { ContextLinkView } from "@chimera/protocol";
import { WorkingTreePanel } from "../../src/components/WorkingTreePanel";
import { LocalSpeechSettings } from "../../src/components/LocalSpeechSettings";
import { loadLocalStt, sttLoadStatus, sttState } from "../../src/voice/localStt";
import { STT_MODEL, STT_RUNTIME } from "../../../core/src/stt-pins";
import type { SttStatus } from "@chimera/protocol";
import { onRowKeyDown } from "../../src/a11y";
import { IssueSources, IssueChip } from "../../src/components/IssueSources";
import { queueIssues } from "../../src/state/commands.issues";
import { closeIssueComment, openIssueComment } from "../../src/components/IssueCommentCard";
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
import { emptyAgent, initialState, reduce, type AgentView, type TranscriptItem } from "@chimera/ui-state";
import "../../src/styles/tokens.css";
import "../../src/styles/fonts.css";
import "../../src/styles/base.css";
import { DesignWorkspace, DesignPanel } from "../../src/components/DesignWorkspace";
import { staticDesignDocument } from "../../src/design/documents";
import { SecretsSection } from "../../src/components/SecretsSection";
import { AgentShadowPane } from "../../src/components/AgentShadowPane";
import { AgentList } from "../../src/components/AgentList";
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
import { getCoordCommands } from "../../src/state/commands.coord";
import { rolesStatus, getRolesCommands } from "../../src/state/commands.roles";
import { rpcCall } from "../../src/rpc/bridge";
import { resetKeyboardPreferences, saveKeyboardPreferences } from "../../src/state/keyboardPreferences";
import { installAppOverlayLifecycle } from "../../src/state/overlayLifecycle";
import {
  agentId,
  agentRecords,
  queues,
  roles,
  rpcFixture,
  resources,
  rejectSchedules,
  teams,
} from "./ui-browser-data.mjs";

declare global {
  interface Window {
    __UI_QA_IMAGE__?: { mediaType: "image/png"; data: string };
    __UI_QA__?: {
      show(name: Scenario): void;
      projectDelete: typeof projectDeleteFixture;
      fork: { mode(value: string): void; snapshot(): { calls: unknown[]; selected: string | null; draft: string; seq: number }; cycle(): void };
      git: { pending(): number; settle(mode: string): void; externalIndex(): void; externalContent(): void; cycle(): void; writes(): unknown[] };
      issues: { pending(): number[]; settle(id: number, mode: "rows" | "error" | "unsupported" | "empty"): void; refresh(): void; sync(mode: "ok" | "error" | "auth"): void; writes(): unknown[]; outcome(mode: "posted" | "uncertain" | "partial" | "deferred"): void; replaceComment(): void; settleWrite(): void; reviewAccepted(): void; cycle(): void };
      imageRegisteredOverlay(open: boolean): void;
      imageAgentSelection(): void;
      rejectSchedules(): void;
      setVoiceActive(active: boolean): void;
      stt: { mode(mode: string): Promise<void>; snapshot(): typeof speechFixture };
      pttSnapshot(): PttSnapshot;
      pttSpeak(): void;
      renameAgent(name?: string): void;
      unreadAgent(unread: boolean): void;
      quickSpawns(): unknown[];
      projectImports(): unknown[];
      finishBackground(status: string): void;
      groupRegistry: { mutate(action: "create" | "rename" | "delete" | "reconnect"): void; snapshot(): unknown };
      groupMoves(): unknown[];
      addLineageAgents(): void;
      foldLineageOwner(): void;
      failNextGroupMove(): void;
      softState(phase: "busy" | "idle" | "paused"): void;
      workspaceSnapshot(): unknown;
      clearComposer(): void;
      messageIdentity: typeof messageIdentityFixture;
      bookmarkOpened(): number;
      secretWrites(): unknown[];
      designSanitize(source: string): string;
      customProviderRpc(): { method: string; params: Record<string, unknown> }[];
      context: { replace(): void; select(id: string): void; competing(): void; mode(value: string): void; snapshot(): { rows: ContextLinkView[]; calls: unknown[]; selectedAgentId: string | null; escapeOwns: boolean; detail: unknown; spawn: boolean; composer: string }; changed(): void };
      resources: { pending(): number; settle(mode: string): void; cycle(): void; connected(value: boolean): void };
      teamStability: {
        dismissForm(): void;
        detailRows(populated: boolean): void;
        pending(): number[];
        settle(id: number, result: "rows" | "large" | "empty" | "error" | "unsupported"): void;
        refresh(): void;
        connected(value: boolean): void;
        cycle(): void;
      };
      stability: {
        pending(): number[];
        settle(id: number, result: "rows" | "large" | "error" | "unsupported"): void;
        refresh(): void;
        connected(value: boolean): void;
        cycle(): void;
        rebind(suffix: string | null): string | null;
        resetKeys(): void;
        overlay(): void;
      };
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
type Scenario = "message-identity" | "project-delete" | "qa-recovery" | "qa-liveboard" | "project-canvas" | "inspector-registry" | "operator-settings" | "operator-read" | "operator-control" | "conversation-fork" | "context-links" | "stt" | "git-review" | "issue-board" | "resources" | "output-images" | "teams-stability" | "team-roles-stability" | "roles-stability" | "desktop-preview" | "workflow-transcript" | "computer-use" | "background-task" | "project-import" | "slash-codex" | "slash-claude" | "group-order" | "quick-spawn" | "workspace-tools" | "keyboard" | `screen-${MainScreen}` | "metrics" | "accounts" | "local-links" | "design" | "design-error" | "design-large" | "secrets" | "live-names" | EdgeCase | ActionScenario | "topbar" | "modal" | "voice" | "ptt" | "transcript" | "pane" | "queues" | "teams" | "settings" | "spawn";

type PttSnapshot = { starts: number; stops: number; sends: string[]; backgroundActions: number };
let sttActive = false;
const speechFixture = {
  available: true, installed: true, state: "installed" as SttStatus["install"]["state"],
  preferences: { v: 1 as const, engine: "whisper-cpp" as "whisper-cpp" | null, language: "en" as "en" | "tr" },
  sends: 0, transcribes: 0, audioBytes: 0, lastLanguage: "", micRequests: 0,
};
function fixtureSpeechStatus(): SttStatus {
  return { preferences: speechFixture.preferences, engines: [{ id: "whisper-cpp", available: speechFixture.available, installed: speechFixture.installed, languages: ["en", "tr"], ...(!speechFixture.available ? { reason: "unsupported platform" } : {}) }],
    install: { state: speechFixture.state, progress: speechFixture.state === "downloading" ? 0.4 : speechFixture.installed ? 1 : 0, ...(speechFixture.state === "failed" ? { error: "Local speech artifact integrity check failed" } : {}) },
    model: { id: STT_MODEL.id, bytes: STT_MODEL.bytes, sha256: STT_MODEL.sha256, license: STT_MODEL.license, runtimeVersion: STT_RUNTIME.version, runtimeSha256: STT_RUNTIME.sha256, path: "/synthetic/stt/1.9.4" } };
}
const micStreams: MediaStream[] = [];
const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async constraints => { if (sttActive) speechFixture.micRequests++; const stream = await originalGetUserMedia(constraints); if (sttActive) micStreams.push(stream); return stream; };
const ptt: PttSnapshot = { starts: 0, stops: 0, sends: [], backgroundActions: 0 };
let lastVoiceStatus = voiceLocal.getState().status;
voiceLocal.subscribe(() => {
  const next = voiceLocal.getState();
  if (next.status === "listening" && lastVoiceStatus !== "listening" && next.sessionId?.startsWith("dictation:")) ptt.starts++;
  if (lastVoiceStatus === "listening" && next.status !== "listening") ptt.stops++;
  lastVoiceStatus = next.status;
});

// The page shell activates the existing dev/test seam before module evaluation. Keep the
// fixture assignment too so its RPC delegate is explicit and all PTT state remains local.
window.__CHIMERA_MOCK__ = { rpc: async (method, params) => window.__UI_QA_RPC__?.(method, params as Record<string, unknown>) };
window.__CHIMERA_VOICE_MOCK__ = { transcript: "synthetic focused transcript" };
const PushToTalkControl = React.lazy(async () => {
  const component = await import("../../src/components/PushToTalkControl");
  return { default: component.PushToTalkControl };
});
let gitActive = false;
const gitPending: { resolve(value: unknown): void; reject(error: unknown): void }[] = [];
const gitWrites: unknown[] = [];
let gitIndex = "index-1", gitVersion = "content-1", gitText = "original text\n";
let gitFiles = [{ path: "one.txt", index: "M", worktree: "M", staged: true }, { path: "nested/" + "long-path-".repeat(8) + ".txt", index: " ", worktree: "M", staged: false }];
let resourcesActive = false;
let metricsActive = false;
const resourcePending: { resolve(value: unknown): void; reject(error: unknown): void }[] = [];
let teamStabilityActive = false;
let teamStabilitySeq = 0;
let detailLayoutTeams: typeof teams = [];
const teamStabilityPending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
let stabilityActive = false;
let issueActive = false; let issueSeq = 0;
const issuePending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
let issueSyncPending: { resolve(value: unknown): void; reject(error: unknown): void } | null = null;
const issueWrites: unknown[] = [];
let issueOutcome: "posted" | "uncertain" | "partial" | "deferred" = "posted";
let issueWritePending: (() => void) | null = null;
const issueSource = { id: "11111111-1111-4111-8111-111111111111", projectId: "demo", repo: "demo/repo", labels: ["bug"], state: "open", queue: "issue-queue", enabled: true, lastSyncAt: null, lastError: null };
const issueLink = { taskId: "issue-task", sourceId: issueSource.id, repo: issueSource.repo, number: 123, url: "https://github.com/demo/repo/issues/123", title: "Fictional issue", state: "closed", bodyDigest: "hash", changed: true, upstreamUpdatedAt: "2026-10-05T01:00:00Z", importedAt: 1, syncedAt: 2, commentedAt: null, boardStatus: "awaiting_review", agentId: "fictional-worker", resultText: "Fixed in fixture. Exact result text." };
let stabilitySeq = 0;
const stabilityPending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
let renameSeq = 999999;
const secretWrites: unknown[] = [];
const customProviderCalls: { method: string; params: Record<string, unknown> }[] = [];
const customProviders: Record<string, Record<string, unknown>> = {};
const customAccounts: { name: string; provider: string; authType: string }[] = [];
let registryLive = false;
let registryCalls = 0;
let registryItems: { id: string; name: string; color?: "blue" | "teal"; order: number; createdAt: number }[] = [];
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
let forkMode = "ok", forkActive = false, forkSeq = 0;
const forkCalls: { method: string; params: unknown }[] = [];
let contextMode = "ok";
let contextRows: ContextLinkView[] = [];
const contextCalls: unknown[] = [];
function contextRpc(method: string, params: Record<string, unknown> = {}) {
  contextCalls.push({ method, params });
  if (contextMode === "unsupported") throw { code: "protocol", message: "unknown method contextlink.list" };
  if (contextMode === "error") throw { code: "unavailable", message: "Synthetic context failure" };
  if (method === "contextlink.create") {
    const text = String(params.text ?? "Synthetic bounded result summary");
    const row: ContextLinkView = { id: crypto.randomUUID(), from: params.from as ContextLinkView["from"], toAgentId: String(params.toAgentId), createdBy: "operator", createdAt: Date.now(), expiresAt: params.expiresAt as number | null, revokedAt: null, snapshot: { title: String(params.title), bytes: new TextEncoder().encode(text).length, sha256: "0".repeat(64), text }, status: "active", semantics: "snapshot", untrusted: false };
    contextRows.push(row); return { ...row, snapshot: { ...row.snapshot, text: undefined } };
  }
  if (method === "contextlink.list") return { links: contextRows.filter(r => params.toAgentId === r.toAgentId || params.fromAgentId === r.from.ref).map(r => ({ ...r, snapshot: { ...r.snapshot, text: undefined } })) };
  const row = contextRows.find(r => r.id === params.id);
  if (!row || row.status !== "active") throw { code: "revoked", message: "Snapshot unavailable" };
  if (method === "contextlink.revoke") { row.revokedAt = Date.now(); row.status = "revoked"; delete row.snapshot.text; }
  return row;
}
window.__UI_QA_RPC__ = (method, params) => {
  if (projectDeleteFixture.active) return projectDeleteFixture.rpc(method, params ?? {});
  const recovery = recoveryRpc(method, params ?? {}); if (recovery) return recovery.value;
  if (canvasFixture.active) {
    if (method === "evidence.get") return { taskId: (params as { taskId: string }).taskId, queue: "canvas-q", state: "pending", workflow: null, steps: [], artifacts: [], provenance: [] };
    if (method === "review.get") throw new Error("unknown method review.get");
    if (method === "queue.list") return [{ name: "canvas-q", paused: false }, { name: "other-q", paused: false }];
    if (method === "queue.status") { const name = String((params as { queue?: string; name?: string }).queue ?? (params as { name?: string }).name); return { spec: { name, retryLimit: 0, maxConcurrent: 1, paused: false }, counts: { pending: 2, done: 0, failed: 0, running: 0 }, tasks: name === "canvas-q" ? [{ taskId: "canvas-task", queue: name, prompt: "Existing task selected from canvas", role: null, agentId: null, state: "pending", createdAt: 1, attempts: 0, dependsOn: [] }, { taskId: "newer-task", queue: name, prompt: "Newer task must not be selected", role: null, agentId: null, state: "pending", createdAt: 200, attempts: 0, dependsOn: [] }] : [] }; }
    if (method === "artifact.get") return { id: "canvas-artifact", kind: "link", label: "Existing artifact", agentId: null, taskId: "canvas-task", createdAt: 1, sizeBytes: null, path: null, url: "https://example.invalid/fixture" };
    if (method.startsWith("canvas.")) return canvasFixture.rpc(method, (params ?? {}) as Record<string, unknown>);
    if (method === "project.list") return [{ name: "canvas-project", path: "/synthetic/canvas", origin: null, teams: [], queue: "canvas-q", archived: false }, { name: "canvas-second", path: "/synthetic/second", origin: null, teams: [], queue: null, archived: false }];
    if (method === "fs.list") return { path: (params as { path?: string })?.path ?? "", entries: [], truncated: false };
    if (method === "project.status") return { spec: { name: (params as { name: string }).name, path: "/synthetic/canvas", origin: null, teams: [], queue: "canvas-q", archived: false }, sessions: [], teams: [] };
  }
  if (registryLive && method === "group.list") { registryCalls++; return { groups: registryItems.map(g => ({ ...g })) }; }
  if (forkActive && (method === "agent.forkCapabilities" || method === "agent.fork")) {
    forkCalls.push({ method, params });
    if (forkMode === "unsupported") throw new Error("unknown method agent.forkCapabilities");
    if (forkMode === "error") throw new Error("Synthetic capability failure; retry");
    if (method === "agent.forkCapabilities") return { native: { available: false, reason: "Native Codex selected-boundary resume in a new worktree is unverified; use snapshot handoff" }, snapshot: { available: true, reason: null }, atSeq: params?.upToSeq ?? forkSeq, provider: "codex", account: "synthetic-codex", model: "synthetic-model" };
    const lineage = { forkedFrom: agentId, mode: "snapshot", atSeq: params?.upToSeq ?? forkSeq };
    appStore.dispatch({ type: "event", event: { seq: renameSeq++, ts: Date.now(), engineId: "local", agentId: "fork-child", kind: "status", data: { registered: true, state: "running", forkLineage: lineage, displayLabel: "Branch child" } } as never });
    return { agentId: "fork-child", mode: "snapshot", label: "Branch with snapshot handoff — context re-created from a brief; no tool history", lineage, worktree: { path: "/synthetic/child", branch: "chimera/fork-child", baseSha: "a".repeat(40) }, warnings: [] };
  }
  if (method.startsWith("operatorweb.")) return operatorFixture.rpc(method, params);
  if (method === "project.list" && document.body.dataset.fixtureReady === "operator-settings") return [{ name: "browser-fixture" }];
  if (method.startsWith("contextlink.")) return contextRpc(method, params);
  if (gitActive && method.startsWith("worktree.")) {
    if (method === "worktree.gitStatus") return new Promise((resolve, reject) => gitPending.push({ resolve, reject }));
    if (method === "worktree.gitDiff") return { hunks: "@@ -1 +1 @@\n-original text\n+staged text", binary: false, truncated: false };
    if (method === "worktree.fileRead") return { text: gitText, contentVersion: gitVersion, bytes: gitText.length };
    if (method === "worktree.fileWrite") {
      if (params?.expectedContentVersion !== gitVersion) throw new Error("stale_content: disk changed; draft retained");
      gitWrites.push({method,params}); gitText = String(params?.text); gitVersion += "-saved"; return { contentVersion: gitVersion };
    }
    if (method === "worktree.gitStage" || method === "worktree.gitCommit") {
      if (params?.expectedIndexFingerprint !== gitIndex) throw new Error("stale_index: index changed with unchanged HEAD");
      gitWrites.push({method,params}); gitIndex += "-next";
      if (method === "worktree.gitStage") gitFiles = gitFiles.map(f => (params?.paths as string[]).includes(f.path) ? { ...f, staged: !params?.unstage, index: params?.unstage ? " " : "M" } : f);
      return method === "worktree.gitCommit" ? { sha: "reviewed-fixture-sha" } : { indexFingerprint: gitIndex };
    }
  }
  if (method === "stt.status") { const status = fixtureSpeechStatus(); return sttActive ? status : { ...status, preferences: { v: 1, engine: null, language: "en" }, engines: status.engines.map(e => ({ ...e, installed: false })) }; }
  if (method === "stt.configure") { speechFixture.preferences = params as typeof speechFixture.preferences; return params; }
  if (method === "stt.install") { speechFixture.state = "downloading"; return fixtureSpeechStatus(); }
  if (method === "stt.installCancel") { speechFixture.state = "idle"; return { cancelled: true }; }
  if (method === "stt.uninstall") { speechFixture.installed = false; speechFixture.state = "idle"; return { removed: true }; }
  if (sttActive && method === "agent.send") speechFixture.sends++;
  if (method === "stt.transcribe") {
    speechFixture.transcribes++; speechFixture.lastLanguage = String(params?.language);
    const audio = params?.audio as { base64: string }; speechFixture.audioBytes = atob(audio.base64).length;
    return { text: params?.language === "tr" ? "Mesajı inceleyin" : "review this message", language: params?.language, durationMs: (speechFixture.audioBytes - 44) / 32, engine: "whisper-cpp" };
  }

  if (issueActive) {
    if (method === "issues.sourceList") return new Promise((resolve, reject) => { issuePending.set(++issueSeq, { resolve, reject }); });
    if (method === "issues.linkList") return [issueLink];
    if (method === "issues.sync") return new Promise((resolve, reject) => { issueSyncPending = { resolve, reject }; });
    if (method === "issues.postComment") {
      if (params?.phase === "confirm") issueWrites.push({ ...params });
      const result = { status: params?.phase === "confirm" ? (issueOutcome === "deferred" ? "posted" : issueOutcome) : "approval_required", previewId: "22222222-2222-4222-8222-222222222222", repo: issueLink.repo, number: issueLink.number, body: params?.body, closeIssue: params?.closeIssue, message: issueOutcome === "uncertain" ? "Comment outcome is uncertain. Do not repost; inspect this issue on GitHub." : issueOutcome === "partial" ? "Comment posted, but closing is uncertain. Do not repost; inspect this issue on GitHub." : "Fictional exact preview; no GitHub write." };
      if (params?.phase === "confirm" && issueOutcome === "deferred") return new Promise(resolve => { issueWritePending = () => resolve(result); });
      return result;
    }
  }
  if (metricsActive && method === "agent.resources") return resources.snapshot();
  if (resourcesActive && method === "agent.resources") return new Promise((resolve, reject) => resourcePending.push({ resolve, reject }));
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
  if (teamStabilityActive && method === "team.list") return new Promise((resolve, reject) => {
    teamStabilityPending.set(++teamStabilitySeq, { resolve, reject });
  });
  if (stabilityActive && method === "role.list") return new Promise((resolve, reject) => {
    stabilityPending.set(++stabilitySeq, { resolve, reject });
  });
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
    if (desktop.previewFails) throw "No preview image is available yet. Preview will retry automatically.";
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
        <PushToTalkControl agentId={agentId} onInsert={(text) => ptt.sends.push(text)} />
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

function OutputImagesProbe() {
  useEffect(() => installAppOverlayLifecycle(appStore), []);
  const [otherOwner, setOtherOwner] = useState(false);
  const [replacement, setReplacement] = useState(false);
  const [nestedConfirm, setNestedConfirm] = useState(false);
  const image = window.__UI_QA_IMAGE__ ?? { mediaType: "image/png" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaPgPAAIDAYAkYfWXAAAAAElFTkSuQmCC" };
  const corrupt = { ...image, data: btoa(atob(image.data).slice(0, 24)) };
  const [state] = useState(() => [
    { kind: "tool_call" as const, data: { toolName: "image_generation", toolId: "generated" } },
    { kind: "tool_result" as const, data: { toolName: "image_generation", toolId: "generated", images: [image] } },
    { kind: "tool_call" as const, data: { toolName: "malformed_image", toolId: "broken" } },
    { kind: "tool_result" as const, data: { toolId: "broken", images: [corrupt] } },
    { kind: "tool_result" as const, data: { toolName: "oversized_image", toolId: "oversized", imageOutputWarnings: ["too-large"] } },
  ].reduce((state, event, index) => reduce(state, { type: "event", event: { ...event, agentId: "image-owner", seq: index + 1, ts: index + 1 } }), initialState));
  const agent = otherOwner ? emptyAgent("other-owner") : state.agents["image-owner"]!;
  return <Stage><OverlayOutlet host="agents" />
    <button data-image-replacement onClick={() => setReplacement(true)}>Open local replacement</button>
    {replacement ? <OverlayCard width={320} onClose={() => setReplacement(false)} ariaLabel="Local replacement">
      <OverlayCardHeader title="Local replacement" />
      <button data-image-close-replacement onClick={() => setReplacement(false)}>Finish old card teardown</button>
      <button data-image-nested-confirm onClick={() => setNestedConfirm(true)}>Open nested confirmation</button>
      {nestedConfirm ? <ConfirmCard title="Nested image confirmation" body="Synthetic nested confirmation." confirmLabel="Confirm" onConfirm={() => setNestedConfirm(false)} onClose={() => setNestedConfirm(false)} /> : null}
    </OverlayCard> : null}
    <button data-image-owner-switch onClick={() => setOtherOwner(owner => !owner)}>Switch image owner</button>
    <div data-output-image-fixture style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "auto", padding: 12 }}>
      <TranscriptSegment key={agent.agentId} agent={agent} canInterrupt={false} isLive={false} />
    </div>
  </Stage>;
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
  const [permissionPhase, setPermissionPhase] = useState<"pending" | "submitted" | "applied" | "fresh">("pending");
  const permissionApplied = permissionPhase === "applied";
  const [large, setLarge] = useState(false);
  const [longModel, setLongModel] = useState(false);
  return <Stage><div data-metrics-probe style={{ minWidth: 0, minHeight: 0, flex: 1, display: "flex", flexDirection: "column", containerType: "inline-size", containerName: "agent-transcript" }}>
    <TranscriptHeader name="codex-prompt-engineer-with-a-very-long-agent-name" fullId="8eb20180-058c-469f-9ba4-bc36447d550c" state="running" tone="success" overBudget={false}
      permissionProfile={permissionPhase === "fresh" ? "full" : "readOnly"} permissionRequest={permissionPhase === "fresh" ? "auto" : "tui"} permissionAppliedToRunningProcess={permissionApplied}
      permissionApplication={permissionPhase === "fresh" ? { version: 0, requestedProfile: "full", submittedProfile: "full", submittedVersion: 0, profileStatus: "unverified", requestedRouting: "auto", routingStatus: "unsupported", transport: "exec", nativeApprovals: false } : permissionPhase === "submitted" ? { version: 1, requestedProfile: "readOnly", submittedProfile: "readOnly", submittedVersion: 1, profileStatus: "unverified", requestedRouting: "tui", routingStatus: "unsupported", transport: "exec", nativeApprovals: false } : { version: 1, requestedProfile: "readOnly", effectiveProfile: permissionApplied ? "readOnly" : "full", profileStatus: permissionApplied ? "applied" : "pending", requestedRouting: "tui", routingStatus: permissionApplied ? "applied" : "bypassed", transport: "app-server", nativeApprovals: true }}
      resourceAgentId={agentId} model={longModel ? "gpt-6-astra-with-a-very-long-model-identifier-and-additional-settings" : "gpt-6-astra"} effort="high" account="codex-account-with-a-very-long-name" costUsd={12.34} usageTotal={113696}
      usage={{ input: 113101, output: 20007, cacheRead: large ? 2293760 : 2000, cacheCreation: 0 }}
      contextLimits={{ source: "codex", defaultWindow: 272000, maxWindow: large ? 1050000 : 872000, sessionWindow: 258400, compactAt: 120000 }} fullContext={109416} limit={258400} ring={[1200, 1800]} compacting={large} hint={{ above: 38, below: 0 }}
      detailOpen={false} onToggleDetail={() => {}} onAction={() => {}} onToggleVoiceHistory={() => {}} />
    <button data-permission-fresh onClick={() => setPermissionPhase("fresh")}>Fresh exec session</button>
    <button data-permission-submit onClick={() => setPermissionPhase("submitted")}>Submit exec profile</button>
    <button data-permission-ack onClick={() => setPermissionPhase("applied")}>Acknowledge next turn</button>
    <button data-metrics-update onClick={() => setLarge(!large)}>Update usage</button>
    <button data-metrics-long-model onClick={() => setLongModel(!longModel)}>Long model</button>
    <div data-metrics-body style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
    <MessageBody text={"Long continuous text: " + "measurement".repeat(800) + "\n\nA readable paragraph with all controls retained."} done rawView={false} />
    </div>
    <textarea data-metrics-composer aria-label="Header test composer" style={{ height: 64, flexShrink: 0, boxSizing: "border-box", width: "100%" }} />
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

function TeamsStabilityProbe() {
  useEffect(() => installAppOverlayLifecycle(appStore), []);
  return <MainScreenProbe name="teams" />;
}

function RolesStabilityProbe() {
  useHotkeys(appStore);
  useEffect(() => installAppOverlayLifecycle(appStore), []);
  return <MainScreenProbe name="roles" />;
}

function MainScreenProbe({ name }: { name: MainScreen }) {
  const screens = { review:ReviewRoomScreen, welcome:WelcomeScreen, projects: ProjectsScreen, memory: MemoryScreen, events: EventsScreen,
    roles: RolesScreen, inbox: InboxScreen, slo: SloScreen, runs: HistoryScreen, help: HelpScreen,
    agents: AgentsScreen, settings: SettingsScreen, teams: TeamsScreen, queues: QueuesScreen };
  const Screen = screens[name];
  return <Stage><TopBar /><main data-screen-probe={name} style={{display:"flex",flexDirection:"column",flex:1,minWidth:0,minHeight:0}}><Screen /></main><Footer /></Stage>;
}

function GitReviewProbe() {
  return <Stage><header style={{ flex: "0 0 36px" }}>Changes / review fixture</header><div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "auto", position: "relative" }} data-git-review-pane><WorkingTreePanel target={{ agentId: "git-fixture" }} taskId="verified-task" /></div><Composer /></Stage>;
}

function CanvasNavigationProbe() {
  const review = useStore(s => s.reviewRoom.openTaskId);
  return <MainScreenProbe name={review ? "review" : "projects"} />;
}

function ScenarioView({ name }: { name: Scenario }) {
  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => { document.body.dataset.fixtureReady = name; });
    });
    return () => { cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame); };
  }, [name]);
  if (name === "qa-recovery" || name === "qa-liveboard") return <RecoveryProbe key={name} liveboard={name === "qa-liveboard"} />;

  if (name === "project-delete") return <MainScreenProbe name="projects" />;
  if (name === "project-canvas") return <CanvasNavigationProbe />;
  if (name === "git-review") return <GitReviewProbe />;
  if (name === "issue-board") return <Stage><TopBar /><main data-issue-board style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0, overflow: "auto" }}><IssueSources queue="issue-queue" /><div data-issue-task-row role="button" tabIndex={0} onKeyDown={onRowKeyDown(() => {})} style={{ padding: 12 }}>Fictional queue task <IssueChip queue="issue-queue" taskId="issue-task" /></div><OverlayOutlet host="queues" /></main><Footer /></Stage>;
  if (name === "message-identity") return <MessageIdentityFixture />;
  if (name === "slash-codex" || name === "slash-claude") return <Stage><div style={{padding: 24, marginTop: 260}}><Composer /></div></Stage>;
  if (name === "stt") return <Stage><TopBar /><div data-stt-stage style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "auto", padding: 12 }}><LocalSpeechSettings /></div><Composer /><Footer /></Stage>;
  if (name === "resources" || name === "context-links" || name === "conversation-fork") return <MainScreenProbe name="agents" />;
  if (name === "inspector-registry") return <MainScreenProbe name="agents" />;
  if (name === "group-order") return <MainScreenProbe name="agents" />;
  if (name === "workflow-transcript") return <WorkflowTranscriptProbe />;
  if (name === "background-task") return <BackgroundTaskProbe />;
  if (name === "project-import") return <Stage><ImportCard teams={["crew"]} importDirHint="/synthetic/projects" onClose={() => {}} onSubmit={async (values) => { projectImports.push(values); }} /></Stage>;
  if (name === "quick-spawn") return <MainScreenProbe name="agents" />;
  if (name === "workspace-tools") return <WorkspaceToolsProbe/>;
  if (name === "keyboard") return <KeyboardProbe />;
  if (name === "teams-stability") return <TeamsStabilityProbe />;
  if (name === "team-roles-stability") return <RolesStabilityProbe />;
  if (name === "roles-stability") return <RolesStabilityProbe />;
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
  if (name.startsWith("operator-")) return <OperatorBrowserFixture mode={name} />;
  if (name === "ptt") return <PttProbe />;
  if (name === "output-images") return <OutputImagesProbe />;
  if (name === "transcript") return <TranscriptProbe />;
  if (name === "pane") return <PaneProbe />;
  if (name === "queues") return <PaneStage name="queues"><QueuesScreen /></PaneStage>;
  if (name === "teams") return <PaneStage name="teams"><TeamsScreen /></PaneStage>;
  if (name === "desktop-preview") return <DesktopPreviewProbe />;
  if (name === "computer-use") return <Stage><ComputerUseCard request={computerRequest} builtInsStatus={builtInsStatus} installBuiltInTool={installBuiltInTool} /></Stage>;
  if (name === "settings") return <Stage><SettingsScreen /></Stage>;
  if (name === "spawn") return <Stage><SpawnCard onClose={() => {}} /></Stage>;
  if (name === "confirm-actions" || name === "team-actions" || name === "queue-actions") return <ActionProbe name={name} />;
  return <OverlayEdgeProbe mode={name as EdgeCase} />;
}

let root: Root | null = null;
let computerStatus = { autoStart: false, configured: true, existingProfileAllowed: false, existingProfileActive: false, running: false, permissionOwner: "Chimera", accessibility: false, screenRecording: false };
// The daemon's view of the Chimera-managed integrations (computerUse.builtins.status). Installing Laya
// flips only its row, the way the real first-use download does.
const freshBuiltIns = () => ({ managed: true, integrations: [
  { id: "laya", state: "not-installed", provisioning: "managed-download", version: "0.3.27", modelAssets: "downloaded-on-first-use", reason: "Laya's Python packages and models download on first use." },
  { id: "chimera-browser", state: "ready", provisioning: "bundled", version: "0.0.83" },
  { id: "chimera-desktop", state: "ready", provisioning: "bundled", version: "0.33.3" },
] }) as never;
let builtInsFixture = freshBuiltIns();
const builtInsStatus = async () => builtInsFixture;
const installBuiltInTool = async () => {
  builtInsFixture = { ...(builtInsFixture as { integrations: { id: string }[] }), integrations: (builtInsFixture as { integrations: { id: string }[] }).integrations.map(i => i.id === "laya" ? { ...i, state: "installing", reason: undefined } : i) } as never;
  return { started: true };
};
const computerRequest = async (command: string, args?: Record<string, unknown>) => {
  if (command === "computer_use_browser_access") computerStatus = { ...computerStatus, existingProfileAllowed: args?.allowed === true, existingProfileActive: computerStatus.running && args?.allowed === true };
  if (command === "computer_use_start") computerStatus = { ...computerStatus, running: true, autoStart: true, existingProfileActive: computerStatus.existingProfileAllowed };
  if (command === "computer_use_stop") computerStatus = { ...computerStatus, running: false, autoStart: false, existingProfileActive: false };
  if (command === "computer_use_permissions") computerStatus = { ...computerStatus, accessibility: true, screenRecording: true };
  return computerStatus;
};
function show(name: Scenario): void {
  if (name === "message-identity") messageIdentityFixture.reset();
  resetRecovery(name);
  projectDeleteFixture.active = name === "project-delete";
  if (projectDeleteFixture.active) { projectDeleteFixture.reset(); appStore.dispatch({ type: "selectTab", tab: "projects" }); }
  canvasFixture.active = name === "project-canvas";
  if (canvasFixture.active) {
    appStore.dispatch({ type: "reviewRoomClose" });
    canvasFixture.reset(); projectsLocal.set({ items: [], detail: null, cursor: 0, query: "" });
    appStore.dispatch({ type: "connected", connected: true }); appStore.dispatch({ type: "selectTab", tab: "projects" });
    for (const id of ["canvas-a", "canvas-b"]) appStore.dispatch({ type: "event", event: { seq: renameSeq++, ts: Date.now(), engineId: "local", agentId: id, kind: "status", data: { registered: true, state: "idle", displayLabel: id } } as never });
  }
  closeConversationFork(); forkActive = name === "conversation-fork"; forkMode = "ok"; forkCalls.length = 0;
  if (forkActive) {
    appStore.dispatch({ type: "connected", connected: true });
    appStore.dispatch({ type: "selectTab", tab: "agents" });
    appStore.dispatch({ type: "agentRecords", records: [{ ...agentRecords[0], state: "running" }] as never });
    appStore.dispatch({ type: "selectAgent", agentId });
    forkSeq = renameSeq++;
    appStore.dispatch({ type: "event", event: { seq: forkSeq, ts: Date.now(), engineId: "local", agentId, kind: "message_complete", data: { text: "Fork selected boundary context" } } as never });
    appStore.dispatch({ type: "event", event: { seq: renameSeq++, ts: Date.now(), engineId: "local", agentId, kind: "message_complete", data: { text: "Later context beyond selected boundary" } } as never });
    composerLocal.set({ composeText: "Original composer draft", agentDetail: null, spawnOpen: false });
  }
  if (name.startsWith("operator-")) operatorFixture.init(name);
  contextMode = "ok";
  gitActive = name === "git-review";
  if (gitActive) { gitPending.length = 0; gitWrites.length = 0; gitIndex = "index-1"; gitVersion = "content-1"; gitText = "original text\n"; gitFiles = [{ path: "one.txt", index: "M", worktree: "M", staged: true }, { path: "nested/" + "long-path-".repeat(8) + ".txt", index: " ", worktree: "M", staged: false }]; appStore.dispatch({ type: "connected", connected: true }); }
  sttActive = name === "stt";
  window.__CHIMERA_VOICE_REAL_CAPTURE__ = sttActive;
  if (sttActive) {
    Object.assign(speechFixture, { available: true, installed: true, state: "installed", sends: 0, transcribes: 0, audioBytes: 0, micRequests: 0, preferences: { v: 1, engine: "whisper-cpp", language: "en" } });
    micStreams.length = 0; sttLoadStatus.reset(); voiceLocal.dispatch({ type: "idle" });
    appStore.dispatch({ type: "connected", connected: true });
    appStore.dispatch({ type: "agentRecords", records: [{ ...agentRecords[0], state: "running", provider: "codex" }] as never });
    appStore.dispatch({ type: "selectAgent", agentId });
    composerLocal.set({ composeText: "before  after", target: "selected", pendingImages: [] });
  }

  issueActive = name === "issue-board";
  if (issueActive) { issueSeq = 0; issuePending.clear(); issueWrites.length = 0; issueOutcome = "posted"; issueWritePending = null; issueSyncPending = null; queueIssues("issue-queue").status.reset(); closeIssueComment(); appStore.dispatch({ type: "connected", connected: true }); appStore.dispatch({ type: "selectTab", tab: "queues" }); }
  resourcesActive = name === "resources";
  metricsActive = name === "metrics";
  if (metricsActive) appStore.dispatch({ type: "connected", connected: true });
  if (resourcesActive || name === "context-links") {
    resourcePending.length = 0;
    appStore.dispatch({ type: "connected", connected: true });
    appStore.dispatch({ type: "agentRecords", records: [
      { ...agentRecords[0], state: "running", displayLabel: "UI QA Agent" },
      ...Array.from({ length: 300 }, (_, i) => ({ agentId: `resource-fleet-${i}`, state: "running", displayLabel: `Synthetic worker ${i}`, createdAt: i + 1 })),
    ] as never });
    appStore.dispatch({ type: "selectTab", tab: "agents" });
    appStore.dispatch({ type: "selectAgent", agentId });
    composerLocal.set({ agentDetail: { agentId }, spawnOpen: false, targetMenuOpen: false });
  }
  teamStabilityActive = name === "teams-stability" || name === "team-roles-stability";
  if (teamStabilityActive) {
    getCoordCommands(appStore, rpcCall).teamsStatus.reset();
    rolesStatus.reset();
    teamStabilityPending.clear();
    teamStabilitySeq = 0;
    appStore.dispatch({ type: "teams", available: true, items: [] });
    appStore.dispatch({ type: "teamDetail", detail: null });
    appStore.dispatch({ type: "teamCursor", delta: -10000 });
    appStore.dispatch({ type: "roleCursor", delta: -10000 });
    appStore.dispatch({ type: "setMode", mode: "normal" });
    appStore.dispatch({ type: "connected", connected: true });
    appStore.dispatch({ type: "selectTab", tab: name === "teams-stability" ? "teams" : "roles" });
  }
  stabilityActive = name === "roles-stability";
  if (stabilityActive) {
    rolesStatus.reset();
    stabilityPending.clear();
    stabilitySeq = 0;
    appStore.dispatch({ type: "roles", available: true, items: [] });
    appStore.dispatch({ type: "roleCursor", delta: -10000 });
    appStore.dispatch({ type: "connected", connected: true });
    appStore.dispatch({ type: "selectTab", tab: "roles" });
  }
  if (name === "computer-use") builtInsFixture = freshBuiltIns();
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
  // Registry deletion deliberately preserves raw membership. Do not leak that
  // synthetic membership into the unrelated group-order fixture.
  if (registryLive && name !== "inspector-registry") appStore.dispatch({ type: "agentRecords", records: agentRecords.map(record => ({ ...record, groups: [] })) as never });
  registryLive = name === "inspector-registry";
  if (registryLive) {
    registryCalls = 0; registryItems = [];
    appStore.dispatch({ type: "groups", available: true, items: [] });
    appStore.dispatch({ type: "connected", connected: true });
    appStore.dispatch({ type: "selectTab", tab: "agents" });
    appStore.dispatch({ type: "agentRecords", records: [{ ...agentRecords[0], state: "running", groups: ["external"] }] as never });
    appStore.dispatch({ type: "selectAgent", agentId });
    composerLocal.set({ agentDetail: { agentId }, composeText: "Preserve registry draft" });
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
  root.render(name === "context-links" || name === "project-canvas" ? <React.StrictMode><ScenarioView name={name} /></React.StrictMode> : <ScenarioView name={name} />);
}

window.__UI_QA__ = {
  show,
  projectDelete: projectDeleteFixture,
  canvas: { remount() { const { layout, revision, large } = canvasFixture; show("project-canvas"); Object.assign(canvasFixture, { layout, revision, large }); }, mode(value: string) { canvasFixture.mode = value; }, large() { canvasFixture.large = true; }, remove() { canvasFixture.removed = true; }, snapshot() { return { calls: canvasFixture.calls, layout: canvasFixture.layout, revision: canvasFixture.revision, selectedAgentId: appStore.getState().selectedAgentId, tab: appStore.getState().activeTab }; }, cycle() { appStore.dispatch({ type: "connected", connected: false }); appStore.dispatch({ type: "connected", connected: true }); } },
  fork: { mode(value) { forkMode = value; }, snapshot() { return { calls: forkCalls, selected: appStore.getState().selectedAgentId, draft: composerLocal.getState().composeText, seq: forkSeq }; }, cycle() { appStore.dispatch({ type: "connected", connected: false }); appStore.dispatch({ type: "connected", connected: true }); } },
  context: {
    replace() { openContextShare({ consumer: "resource-fleet-1", from: { kind: "agent-summary", ref: "resource-fleet-1" } }); },
    select(id) { appStore.dispatch({ type: "selectAgent", agentId: id }); },
    competing() { composerLocal.set({ spawnOpen: true }); },
    mode(value) { contextMode = value; },
    snapshot() { return { rows: contextRows, calls: contextCalls, selectedAgentId: appStore.getState().selectedAgentId, escapeOwns: contextShareOwnsEscape(), detail: composerLocal.getState().agentDetail, spawn: composerLocal.getState().spawnOpen, composer: composerLocal.getState().composeText }; },
    changed() { window.__CHIMERA_PUSH__?.event({ seq: renameSeq++, ts: Date.now(), engineId: "local", agentId, kind: "context_link_changed", data: { id: contextRows[0]?.id } }); },
  },
  git: {
    pending: () => gitPending.length,
    settle(mode) {
      const p = gitPending.shift(); if (!p) throw new Error("Missing git status request");
      if (mode === "error") p.reject(new Error("Synthetic status failure"));
      else if (mode === "unsupported") p.reject(new Error("unknown method worktree.gitStatus"));
      else p.resolve({ branch: "chimera/review-fixture", head: "unchanged-head", indexFingerprint: gitIndex, files: mode === "clean" ? [] : gitFiles, truncated: false, writable: mode !== "lease", writeReason: mode === "lease" ? "worktree lease held by live fixture agent" : null });
    },
    externalIndex() { gitIndex += "-external"; },
    externalContent() { gitVersion += "-external"; gitText = "concurrent disk text"; },
    cycle() { appStore.dispatch({ type: "connected", connected: false }); appStore.dispatch({ type: "connected", connected: true }); },
    writes: () => [...gitWrites],
  },
  stt: {
    snapshot: () => ({ ...speechFixture, voiceStatus: voiceLocal.getState().status, voiceError: voiceLocal.getState().errorMessage, loadedLanguage: sttState().status?.preferences.language, activeTracks: micStreams.flatMap(s => s.getTracks()).filter(t => t.readyState === "live").length }),
    mode: async mode => {
      speechFixture.installed = mode === "installed";
      speechFixture.available = mode !== "unavailable";
      speechFixture.state = (["downloading", "failed", "installed"].includes(mode) ? mode : "idle") as SttStatus["install"]["state"];
      await loadLocalStt();
    },
  },
  issues: {
    pending: () => [...issuePending.keys()],
    settle(id, mode) { const pending = issuePending.get(id); if (!pending) throw new Error("Missing issue request"); issuePending.delete(id); if (mode === "error") pending.reject({ code: "transport", message: "Synthetic issue load failure" }); else if (mode === "unsupported") pending.reject({ code: "protocol", message: "unknown method issues.sourceList" }); else pending.resolve(mode === "empty" ? [] : [issueSource]); },
    refresh: () => { void queueIssues("issue-queue").load(); },
    sync(mode) { const pending = issueSyncPending; if (!pending) throw new Error("Missing issue sync"); issueSyncPending = null; if (mode === "error") pending.reject({ code: "transport", message: "Synthetic sync failure" }); else pending.resolve({ imported: 0, updated: 1, truncated: false, ghState: mode === "auth" ? "unauthenticated" : "ok", retryAfterMs: 0 }); },
    writes: () => [...issueWrites],
    outcome: mode => { issueOutcome = mode; },
    replaceComment() { openIssueComment({ ...issueLink, taskId: "replacement-issue-task", number: 124, resultText: "Replacement draft.", boardStatus: "accepted" }); },
    settleWrite() { const settle = issueWritePending; if (!settle) throw new Error("No pending issue write"); issueWritePending = null; settle(); },
    reviewAccepted() { issueLink.boardStatus = "accepted"; appStore.dispatch({ type:"event", event: { seq:renameSeq++, ts:Date.now(), agentId:"task:issue-task", kind:"review_changed", data:{taskId:"issue-task"} } }); },
    cycle() { appStore.dispatch({ type: "connected", connected: false }); appStore.dispatch({ type: "connected", connected: true }); },
  },
  resources: {
    pending: () => resourcePending.length,
    settle(mode) {
      const p = resourcePending.shift();
      if (!p) throw new Error("No pending resource request");
      if (mode === "error") p.reject(new Error("synthetic process scan failed"));
      else if (mode === "unsupported") p.reject(new Error("unknown method agent.resources"));
      else p.resolve(resources.snapshot(mode));
    },
    cycle: () => { appStore.dispatch({ type: "connected", connected: false }); appStore.dispatch({ type: "connected", connected: true }); },
    connected: value => appStore.dispatch({ type: "connected", connected: value }),
  },
  teamStability: {
    dismissForm: () => { appStore.dispatch({ type: "paletteOpen", open: false }); appStore.dispatch({ type: "setMode", mode: "normal" }); },
    detailRows(populated) {
      // Isolate the worker table from the independent 201-team master-list
      // fixture above, then restore it for the existing list/screen probes.
      if (populated) detailLayoutTeams = appStore.getState().teams.items as typeof teams;
      appStore.dispatch({ type: "teams", available: true, items: populated ? teams : detailLayoutTeams });
      const records = populated ? Array.from({ length: 3 }, (_, i) => ({
        ...agentRecords[0], agentId: `detail-layout-${i}`, state: "running",
        accountName: "synthetic-account-with-a-long-unbroken-name",
        membership: { team: "quality", role: "quality-engineering-with-a-long-role-name" },
        costUsd: 12345.67,
        resultText: "A long synthetic activity summary that must remain reachable in the detail table",
        spec: { prompt: "Synthetic detail table task" },
      })) : agentRecords;
      appStore.dispatch({ type: "teamDetail", detail: {
        spec: teams[0], running: populated ? 3 : 0, totalRuns: populated ? 3 : 0,
        agents: populated ? records : [],
      } as never });
    },
    pending: () => [...teamStabilityPending.keys()],
    settle(id, result) {
      const pending = teamStabilityPending.get(id);
      if (!pending) throw new Error(`No Teams request ${id}`);
      teamStabilityPending.delete(id);
      if (result === "error") pending.reject({ code: "transport", message: "Synthetic Teams failure" });
      else if (result === "unsupported") pending.reject({ code: "protocol", message: "unknown method team.list" });
      else pending.resolve(result === "empty" ? [] : result === "large" ? [
        ...teams, ...Array.from({ length: 200 }, (_, i) => ({ ...teams[0], name: `team-${String(i).padStart(3, "0")}` })),
      ] : teams);
    },
    refresh: () => { void getCoordCommands(appStore, rpcCall).loadTeams(); },
    connected: (connected) => appStore.dispatch({ type: "connected", connected }),
    cycle: () => {
      appStore.dispatch({ type: "connected", connected: false });
      appStore.dispatch({ type: "connected", connected: true });
    },
  },
  stability: {
    pending: () => [...stabilityPending.keys()],
    settle(id, result) {
      const pending = stabilityPending.get(id);
      if (!pending) throw new Error(`No Roles request ${id}`);
      stabilityPending.delete(id);
      if (result === "error") pending.reject({ code: "disconnected", message: "Synthetic Roles failure" });
      else if (result === "unsupported") pending.reject({ code: "protocol", message: "unknown method role.list" });
      else pending.resolve(result === "large" ? [
        ...Array.from({ length: 200 }, (_, i) => ({ ...roles[0], name: `role-${String(i).padStart(3, "0")}-a-long-library-name-to-test-truncation` })), ...roles,
      ] : roles);
    },
    refresh: () => { void getRolesCommands(appStore, rpcCall).loadRoles(); },
    connected: (connected) => appStore.dispatch({ type: "connected", connected }),
    cycle: () => {
      appStore.dispatch({ type: "connected", connected: false });
      appStore.dispatch({ type: "connected", connected: true });
    },
    rebind: (suffix) => saveKeyboardPreferences({ leader: "mod+k", bindings: { "tab.roles": suffix } }),
    resetKeys: resetKeyboardPreferences,
    overlay: () => appStore.dispatch({ type: "paletteOpen", open: true }),
  },
  rejectSchedules,
  imageRegisteredOverlay: (open) => appStore.dispatch({ type: "accountsOpen", open }),
  imageAgentSelection: () => appStore.dispatch({ type: "selectAgent", agentId: "image-test-other-selection" }),
  workspaceSnapshot: () => ({data:workspaceTools.getState(),composer:composerLocal.getState().composeText,filter:currentFleetFilter()}),
  bookmarkOpened: () => openedBookmark,
  messageIdentity: messageIdentityFixture,
  clearComposer: () => composerLocal.set({composeText:"",pendingImages:[]}),
  secretWrites: () => secretWrites,
  designSanitize: (source) => staticDesignDocument(source).html,
  customProviderRpc: () => customProviderCalls.map((call) => ({ method: call.method, params: { ...call.params } })),
  quickSpawns: () => quickSpawns,
  projectImports: () => projectImports,
  finishBackground: (status) => appStore.dispatch({ type: "event", event: { agentId, seq: renameSeq++, ts: Date.now(), kind: "agent_task", data: { taskId: "bg-browser", status, ...(status === "failed" ? { error: "exit 2" } : {}) } } }),
  groupRegistry: {
    mutate(action) {
      if (action === "delete") registryItems = [];
      else registryItems = [{ id: "external", name: action === "create" ? "External created" : action === "rename" ? "External renamed" : "Reconnected registry", color: action === "create" ? "blue" : "teal", createdAt: 1, order: 0 }];
      if (action === "reconnect") {
        appStore.dispatch({ type: "connected", connected: false });
        appStore.dispatch({ type: "connected", connected: true });
      } else appStore.dispatch({ type: "event", event: { agentId: "group:registry", kind: "group_registry_changed", seq: renameSeq++, ts: Date.now(), data: { operation: action === "rename" ? "update" : action, id: "external" } } });
    },
    snapshot() { return { calls: registryCalls, groups: appStore.getState().groups.items, memberships: appStore.getState().agents[agentId]?.groups, selected: appStore.getState().selectedAgentId, draft: composerLocal.getState().composeText, inspector: composerLocal.getState().agentDetail?.agentId }; },
  },
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
Object.assign(window, { __OPERATOR_QA__: operatorFixture });
show("topbar");
