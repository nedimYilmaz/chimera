import { isRevivableHold } from "./supervisor.js";
import type { AgentRecord } from "./supervisor.js";
import type { Engine } from "./engine.js";
import type { OperatorWebDeps } from "./operator-web.js";
import type { OperatorWebSession, OperatorWebSnapshot, NormalizedEvent } from "@chimera/protocol";
import { scrubSecretShapes } from "./configstore.js";
const denied = (): never => { throw Object.assign(new Error("Resource outside paired project scope"), { status: 403 }); };
const text = (value: unknown, cap = 4000) => {
  const valueText = scrubSecretShapes(String(value ?? ""));
  if (Buffer.byteLength(valueText) <= cap) return valueText;
  return Buffer.from(valueText).subarray(0, cap).toString("utf8") + "… [truncated]";
};

export function operatorWebEngine(engine: Engine): Omit<OperatorWebDeps, "home" | "bundleDir"> {
  const projectExists = (project: string) => engine.projects.list().some(p => p.name === project && !p.archived);
  // Explicit projectId is authoritative. Cwd-only records and federated records
  // are deliberately unavailable: guessing a project from paths grants too much.
  const visible = (s: OperatorWebSession, agentId: string) => {
    if (!projectExists(s.project) || agentId.includes("/")) return false;
    try { const a = engine.supervisor.status(agentId); return a.projectId === s.project && !a.shadow; } catch { return false; }
  };
  const projectQueues = (project: string): Set<string> => {
    const p = engine.projects.get(project);
    return new Set([p.queue, ...engine.teams.list().filter(t => p.teams.includes(t.name)).map(t => t.queue)].filter((x): x is string => !!x));
  };
  const queueVisible = (s: OperatorWebSession, queue: string) => {
    // A shared queue cannot be paused/read safely through one project's session.
    const owners = engine.projects.list().filter(p => projectQueues(p.name).has(queue));
    return owners.length === 1 && owners[0]!.name === s.project && !owners[0]!.archived;
  };
  const agentView = (a: AgentRecord) => ({ agentId: a.agentId, label: text(a.spec.displayLabel ?? a.agentId, 120), state: a.state, held: a.state === "paused" && (a.pauseReason === "operator-hold" || isRevivableHold(a)) });
  const queueView = (queue: string) => {
    const q = engine.queues.status(queue);
    return { name: q.spec.name, paused: q.spec.paused, tasks: q.tasks.slice(0, 200).map(t => ({ taskId: t.taskId, state: t.state, prompt: text(t.prompt, 2000) })) };
  };
  const attention = async (s: OperatorWebSession) => {
    const pending = engine.supervisor.operatorAttention().filter(p => visible(s, p.agentId)).slice(0, 20);
    return Promise.all(pending.map(async p => {
      const events = await engine.handle("agent.tail", { agentId: p.agentId, n: 50 }) as NormalizedEvent[];
      const event = [...events].reverse().find(e => e.data.requestId === p.id || e.data.questionId === p.id);
      const prompt = p.kind === "permission" ? `${text(event?.data.toolName ?? "Approval request", 120)}: ${text(JSON.stringify(event?.data.input ?? {}), 8000)}` : text(event?.data.prompt ?? "Question details no longer in recent history; review in desktop", 8000);
      const rawOptions = Array.isArray(event?.data.options) ? event.data.options : [];
      const options = p.kind === "question" && Array.isArray(event?.data.options) ? event.data.options.slice(0, 20).flatMap(o => typeof o === "object" && o && "id" in o && "label" in o && String(o.id).length <= 120 ? [{ id: String(o.id), label: text(o.label, 120) }] : []) : undefined;
      return { ...p, prompt, actionable: !!event && !prompt.includes("[truncated") && rawOptions.length <= 20 && (!options || options.length === rawOptions.length), ...(p.kind === "question" ? { freeform: event?.data.freeform === true, options } : {}) };
    }));
  };
  return {
    projectExists,
    visible: (s, id) => {
      if (visible(s, id)) return true;
      if (id.startsWith("queue:")) return queueVisible(s, id.slice(6));
      if (id.startsWith("task:")) { try { return queueVisible(s, engine.queues.getTask(id.slice(5)).queue); } catch { return false; } }
      return false;
    },
    subscribe: cb => engine.events.subscribe(e => cb(e.agentId)),
    snapshot: async s => {
      if (!projectExists(s.project)) denied();
      const all = engine.supervisor.list().filter(a => visible(s, a.agentId));
      const qs = engine.queues.list().filter(q => queueVisible(s, q.name));
      let queueBytes = 0, byteTruncated = false;
      const queues = qs.slice(0, 20).map(q => {
        const view = queueView(q.name);
        view.tasks = view.tasks.filter(t => { const bytes = Buffer.byteLength(JSON.stringify(t)); if (queueBytes + bytes > 400_000) { byteTruncated = true; return false; } queueBytes += bytes; return true; });
        return view;
      });
      const snapshot: OperatorWebSnapshot = { project: s.project, scope: s.scope, agents: all.slice(0, 200).map(agentView), queues, attention: await attention(s), truncated: byteTruncated || engine.supervisor.operatorAttention().filter(p => visible(s, p.agentId)).length > 20 || all.length > 200 || qs.length > 20 || qs.some(q => engine.queues.status(q.name).tasks.length > 200) };
      return snapshot;
    },
    dispatch: async (s, method, params) => {
      if (!projectExists(s.project)) denied();
      if (method === "project.list") return [{ name: s.project }];
      if (method === "agent.list") return engine.supervisor.list().filter(a => visible(s, a.agentId)).slice(0, 200).map(agentView);
      if (method === "queue.list") return engine.queues.list().filter(q => queueVisible(s, q.name)).slice(0, 20).map(q => ({ name: q.name, paused: q.paused }));
      if ("agentId" in params && (typeof params.agentId !== "string" || !visible(s, params.agentId))) denied();
      if ("agentIds" in params && (!Array.isArray(params.agentIds) || params.agentIds.some(id => typeof id !== "string" || !visible(s, id)))) denied();
      if (method === "agent.status") return agentView(engine.supervisor.status(params.agentId as string));
      if ("queue" in params && !queueVisible(s, params.queue as string)) denied();
      if ("taskId" in params) {
        try { if (!queueVisible(s, engine.queues.getTask(params.taskId as string).queue)) denied(); } catch { denied(); }
      }
      if (method === "agent.permissionRespond" || method === "agent.answerQuestion") {
        const id = params.requestId ?? params.questionId;
        const pending = engine.supervisor.operatorAttention().find(p => p.id === id && p.kind === (method === "agent.permissionRespond" ? "permission" : "question"));
        if (!pending || !visible(s, pending.agentId)) denied();
      }
      if (method === "queue.status" || method === "queue.statusSummary") return queueView(params.queue as string);
      // Actor labels are audit metadata, never taken from browser input.
      const result = await engine.handle(method, method === "agent.send" ? { ...params, from: "operator panel" } : params);
      if (method === "queue.push") return { taskId: (result as { taskId: string }).taskId };
      if (method === "queue.pause" || method === "queue.resume") return { paused: method === "queue.pause" };
      if (method === "agent.tail") {
        return (result as Array<{ seq: number; kind: string; data: Record<string, unknown> }>).map(e => ({ seq: e.seq, kind: e.kind, text: text(e.data.text ?? e.data.message ?? e.data.error ?? e.data.reason ?? "", 8000) }));
      }
      return JSON.parse(scrubSecretShapes(JSON.stringify(result)));
    },
    audit: (s, method) => { engine.auditLedger.append({ agentId: null, action: "operator_web_control", resource: method, decision: "recorded", reason: "Authenticated project-scoped operator action", detail: { sessionId: s.id, project: s.project, scope: s.scope } }); },
  };
}
