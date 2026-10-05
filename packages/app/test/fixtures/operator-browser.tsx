import type { OperatorWebSettings, OperatorWebSnapshot } from "@chimera/protocol";
import { OperatorPanel } from "../../src/operator/OperatorPanel";
import { SessionExpired, type OperatorSession, type OperatorTransport } from "../../src/operator/bridge";
import { OperatorWebSettings as Settings } from "../../src/components/OperatorWebSettings";
import { OverlayOutlet } from "../../src/components/OverlayOutlet";
const preferences: OperatorWebSettings = { v: 1, port: 0, idleMin: 30, absoluteH: 8, publicOrigin: null };
const snapshot: OperatorWebSnapshot = { project: "browser-fixture", scope: "read", truncated: false,
  agents: [{ agentId: "synthetic-worker", label: "Synthetic worker", state: "running", held: false }],
  queues: [{ name: "synthetic-q", paused: false, tasks: [{ taskId: "synthetic-task", state: "pending", prompt: "Synthetic work for review" }] }],
  attention: [{ id: "approval", agentId: "synthetic-worker", kind: "permission", prompt: "Review synthetic command", actionable: true }, { id: "question", agentId: "synthetic-worker", kind: "question", prompt: "Choose a synthetic option", actionable: true, freeform: true, options: [{ id: "continue", label: "Continue fixture" }] }],
};
let scope: "read" | "control" = "read", expired = false, enabled = false, sessions = [{ id: "fixture-device", deviceLabel: "Synthetic phone", project: "browser-fixture", scope: "read", createdAt: Date.now(), lastUsedAt: Date.now(), expiresAt: Date.now() + 3_600_000 }];
let review = { taskId: "synthetic-task", findings: [], decision: null } as { taskId: string; findings: unknown[]; decision: unknown };
let changed: (() => void) | null = null;
let interrupt: (() => void) | null = null; const calls: Array<{ method: string; params: unknown }> = [];
const session = (): OperatorSession => ({ csrf: "test-csrf", project: "browser-fixture", scope, expiresAt: Date.now() + 3_600_000 });
const transport: OperatorTransport = {
  restore: async () => { if (expired) throw new SessionExpired(); return session(); }, pair: async () => session(),
  snapshot: async <T,>() => ({ ...snapshot, scope } as T),
  rpc: async <T,>(method: string, params: unknown) => { calls.push({ method, params }); if (method === "agent.tail") return [{ seq: 1, kind: "message_delta", text: "Synthetic recent transcript" }] as T; if (method === "review.decide") review.decision = params; return review as T; },
  logout: async () => {}, events: (change, interrupted) => { changed = change; interrupt = interrupted; return () => { interrupt = null; changed = null; }; },
};
export const operatorFixture = {
  init(mode: string) { scope = mode === "operator-control" ? "control" : "read"; expired = false; enabled = false; calls.length = 0; review = { taskId: "synthetic-task", findings: [], decision: null }; },
  replaceScope() { scope = "read"; changed?.(); },
  expire() { expired = true; interrupt?.(); }, calls: () => calls,
  rpc(method: string, params?: Record<string, unknown>): unknown {
    const status = () => ({ enabled, localUrl: enabled ? "http://127.0.0.1:54321" : null, settings: preferences, sessions, bundleAvailable: true, limitation: "Loopback HTTP only; owner-managed HTTPS remote transport." });
    if (!method.startsWith("operatorweb.")) return undefined;
    if (method === "operatorweb.enable") enabled = true;
    if (method === "operatorweb.disable") { enabled = false; sessions = []; }
    if (method === "operatorweb.sessionRevoke") sessions = sessions.filter(s => params?.id !== null && params?.id !== s.id);
    if (method === "operatorweb.pairStart") return { code: "f".repeat(32), expiresAt: Date.now() + 120_000, project: params?.project, scope: params?.allowControl ? "control" : "read" };
    return status();
  },
};
export function OperatorBrowserFixture({ mode }: { mode: string }) {
  return mode === "operator-settings" ? <div style={{ position: "relative", height: "100vh", overflowY: "auto", padding: 12 }}><Settings /><OverlayOutlet host="settings" /></div> : <OperatorPanel key={mode} transport={transport} />;
}
