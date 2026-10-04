// Native-CLI-parity Phase 1 (Task N2): pure, unit-testable tree-building for
// the per-agent flowTree FlowPane (N3) renders. Kept entirely separate from
// reducer.ts so the tree logic is testable in isolation and the reducer stays
// a thin fold (see reducer.ts's agent_task/tool_call/tool_result cases).
//
// taskId/toolUseId keying decision (test 5 in flow-tree-n2.test.ts): an
// agent_task is keyed by `toolUseId ?? taskId` per the spec. But the Claude
// Agent SDK's task_updated message can repeat a taskId WITHOUT the toolUseId
// the original task_started carried -- e.g. `{taskId:"T1", toolUseId:"tu_p"}`
// then later just `{taskId:"T1", status:"completed"}`. The second event's key
// (`taskId` alone, since toolUseId is absent) will never equal the first
// node's id ("tu_p"), so a plain findFlowNode(tree, key) can't resolve it.
// applyFlowEvent solves this by stamping every task/workflow node with an
// internal `taskId` bookkeeping field (FlowNode.taskId, NOT part of FlowPane's
// display contract) at creation, and resolving a later agent_task by trying,
// in order: (1) the event's toolUseId as a node id, (2) the event's taskId as
// a node id, (3) the event's taskId against every node's stored `taskId`
// field. This keeps a toolUseId-first node lookup-able by taskId alone without
// requiring any state beyond the tree itself (applyFlowEvent stays pure).
import type { WorkflowSpec, WorkflowStep } from "@chimera/protocol";
import type { FlowNode, WorkflowGraphDocument, WorkflowGraphEdge } from "./types.js";

const graphEdgeId = (from: string, kind: string, order: number): string => `${from}:${kind}:${order}`;

/** Lossless normalized editor projection. Route order is significant: the daemon
 * evaluates the first matching edge. Derived implicit/special edges never leak back. */
export function normalizeWorkflowGraph(spec: WorkflowSpec): WorkflowGraphDocument {
  const nodesById: WorkflowGraphDocument["nodesById"] = {};
  const edgesById: WorkflowGraphDocument["edgesById"] = {};
  const nodeOrder = spec.steps.map((step) => step.id);
  spec.steps.forEach((step, index) => {
    nodesById[step.id] = { id: step.id, step: structuredClone(step) };
    const add = (to: string, kind: WorkflowGraphEdge["kind"], order: number): void => {
      const id = graphEdgeId(step.id, kind, order);
      edgesById[id] = { id, from: step.id, to, kind, order };
    };
    if (step.fanOut) add(step.fanOut.joinStep, "fanOutJoin", 0);
    // Nested sub-workflows: a subWorkflow step's real successor is its joinStep, same dynamic-
    // successor shape as fanOut/plan above.
    else if (step.subWorkflow) add(step.subWorkflow.joinStep, "subWorkflowJoin", 0);
    else if (step.gate.kind === "plan") add(step.gate.spec.resumeStep, "planResume", 0);
    else if (step.next !== undefined) step.next.forEach((edge, order) => add(edge.to, "route", order));
    else if (index + 1 < spec.steps.length) add(spec.steps[index + 1]!.id, "implicit", 0);
  });
  return { name: spec.name, onFail: spec.onFail, retryLimit: spec.retryLimit, params: spec.params, nodeOrder, nodesById, edgesById };
}

export function serializeWorkflowGraph(doc: WorkflowGraphDocument): WorkflowSpec {
  const steps = doc.nodeOrder.map((id) => structuredClone(doc.nodesById[id]!.step)) as WorkflowStep[];
  return { name: doc.name, onFail: doc.onFail, retryLimit: doc.retryLimit, params: doc.params, steps };
}

export function updateWorkflowGraphNode(doc: WorkflowGraphDocument, id: string, patch: Partial<WorkflowStep>): WorkflowGraphDocument {
  const node = doc.nodesById[id];
  if (!node) return doc;
  return { ...doc, nodesById: { ...doc.nodesById, [id]: { ...node, step: { ...node.step, ...patch } as WorkflowStep } } };
}

// Depth-first find a node by id in the forest (returns the node ref or null).
export function findFlowNode(tree: FlowNode[], id: string): FlowNode | null {
  for (const node of tree) {
    if (node.id === id) return node;
    if (node.children.length > 0) {
      const found = findFlowNode(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

// Depth-first find a node by its bookkeeping taskId (see module comment).
function findNodeByTaskId(tree: FlowNode[], taskId: string): FlowNode | null {
  for (const node of tree) {
    if (node.taskId === taskId) return node;
    if (node.children.length > 0) {
      const found = findNodeByTaskId(node.children, taskId);
      if (found) return found;
    }
  }
  return null;
}

// Immutable "find id, replace via fn": clones only the path from the matched
// node up to the roots array. Returns the SAME tree reference when nothing
// matched, so a genuine no-op never manufactures a new array reference.
function updateNodeById(
  tree: FlowNode[],
  id: string,
  fn: (n: FlowNode) => FlowNode,
): { tree: FlowNode[]; found: boolean } {
  let found = false;
  const next = tree.map((node) => {
    if (found) return node;
    if (node.id === id) {
      found = true;
      return fn(node);
    }
    if (node.children.length > 0) {
      const child = updateNodeById(node.children, id, fn);
      if (child.found) {
        found = true;
        return { ...node, children: child.tree };
      }
    }
    return node;
  });
  return found ? { tree: next, found: true } : { tree, found: false };
}

function appendChildById(tree: FlowNode[], parentId: string, child: FlowNode): { tree: FlowNode[]; found: boolean } {
  return updateNodeById(tree, parentId, (n) => ({ ...n, children: [...n.children, child] }));
}

// Defensive string read: non-string or empty-string values are treated as
// absent, so odd/malformed event data never produces a node keyed "" or a
// label of "undefined".
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function normalizeUsage(v: unknown): FlowNode["usage"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const u = v as Record<string, unknown>;
  const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const out: NonNullable<FlowNode["usage"]> = {};
  const totalTokens = num(u["totalTokens"]);
  const toolUses = num(u["toolUses"]);
  const durationMs = num(u["durationMs"]);
  if (totalTokens !== undefined) out.totalTokens = totalTokens;
  if (toolUses !== undefined) out.toolUses = toolUses;
  if (durationMs !== undefined) out.durationMs = durationMs;
  return Object.keys(out).length > 0 ? out : undefined;
}

// Depth-first, in tree order: every "tool" node currently "called". Used by
// tool_result to patch the most-recent one -- mirrors reducer.ts's existing
// agent.tools "search from the end" pattern, but over a tree instead of a
// flat array (see the applyToolResult doc comment below for the ordering note).
function collectCalledToolIds(tree: FlowNode[]): string[] {
  const ids: string[] = [];
  const walk = (nodes: FlowNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "tool" && node.status === "called") ids.push(node.id);
      if (node.children.length > 0) walk(node.children);
    }
  };
  walk(tree);
  return ids;
}

function applyAgentTask(tree: FlowNode[], data: Record<string, unknown>): FlowNode[] {
  const taskId = str(data["taskId"]);
  const toolUseId = str(data["toolUseId"]);
  const primaryId = toolUseId ?? taskId;
  if (!primaryId) return tree; // nothing to key on -- ignore (per spec)

  const workflowName = str(data["workflowName"]);
  const subagentType = str(data["subagentType"]);
  const description = str(data["description"]);
  const status = str(data["status"]);
  const usage = normalizeUsage(data["usage"]);
  const parentToolUseId = str(data["parentToolUseId"]);

  // Resolution order: direct toolUseId match, direct taskId-as-id match, then
  // the taskId bookkeeping fallback (see module comment).
  let existing: FlowNode | null = toolUseId ? findFlowNode(tree, toolUseId) : null;
  if (!existing && taskId) existing = findFlowNode(tree, taskId);
  if (!existing && taskId) existing = findNodeByTaskId(tree, taskId);

  if (existing) {
    const { tree: next, found } = updateNodeById(tree, existing.id, (n) => ({
      ...n,
      // Never DOWNGRADE an already-upgraded classification: a status-only
      // follow-up agent_task (no workflowName -- e.g. a task_updated) must
      // not flip an established "workflow" node back to "task". Only a
      // still-unclassified "tool" node may be upgraded by an absent
      // workflowName (-> "task"); "workflow" and "task" nodes keep their kind
      // unless this event explicitly carries a workflowName.
      kind: workflowName ? "workflow" : n.kind === "tool" ? "task" : n.kind,
      label: workflowName ?? subagentType ?? description ?? n.label,
      subLabel: subagentType ?? description ?? n.subLabel,
      status: status ?? n.status,
      usage: usage ?? n.usage,
      taskId: taskId ?? n.taskId,
    }));
    return found ? next : tree; // `found` is always true here (existing came from this same tree)
  }

  const node: FlowNode = {
    id: primaryId,
    kind: workflowName ? "workflow" : "task",
    label: workflowName ?? subagentType ?? description ?? taskId ?? primaryId,
    status: status ?? "running",
    ...(subagentType ?? description ? { subLabel: subagentType ?? description } : {}),
    ...(usage ? { usage } : {}),
    ...(taskId ? { taskId } : {}),
    children: [],
  };

  if (parentToolUseId) {
    const { tree: next, found } = appendChildById(tree, parentToolUseId, node);
    if (found) return next;
  }
  return [...tree, node];
}

function applyToolCall(tree: FlowNode[], data: Record<string, unknown>, seq: number): FlowNode[] {
  const toolName = str(data["toolName"]) ?? "?";
  const toolUseId = str(data["toolId"]) ?? str(data["toolUseId"]);
  const parentToolUseId = str(data["parentToolUseId"]);
  const id = toolUseId ?? `tool:${seq}`;
  const node: FlowNode = { id, kind: "tool", label: toolName, status: "called", children: [] };

  if (parentToolUseId) {
    const { tree: next, found } = appendChildById(tree, parentToolUseId, node);
    if (found) return next;
  }
  // No parent, or the parent doesn't (yet) resolve -- becomes a ROOT (an
  // orphaned/unknown parent must never drop the node or throw).
  return [...tree, node];
}

// Best-effort, mirroring the existing agent.tools/transcript "last called"
// patch pattern (reducer.ts): walk the tree depth-first and patch the LAST
// "tool" node still "called" to "done". A no-match is a no-op (returns the
// SAME tree reference).
function applyToolResult(tree: FlowNode[], data: Record<string, unknown>): FlowNode[] {
  const id = str(data["toolId"]) ?? str(data["toolUseId"]);
  if (id !== undefined) {
    const node = findFlowNode(tree, id);
    if (!node || node.kind !== "tool" || node.status !== "called") return tree;
    return updateNodeById(tree, id, (n) => ({ ...n, status: "done" })).tree;
  }
  const ids = collectCalledToolIds(tree);
  if (ids.length === 0) return tree;
  const lastId = ids[ids.length - 1]!;
  const { tree: next } = updateNodeById(tree, lastId, (n) => ({ ...n, status: "done" }));
  return next;
}

// Apply one normalized event to a flowTree, returning a NEW tree (immutable
// update). Handles kind "agent_task", "tool_call", "tool_result". Any other
// kind -- or odd/malformed data of any shape -- leaves the tree unchanged
// (same reference); this function never throws.
export function applyFlowEvent(
  tree: FlowNode[],
  ev: { kind: string; seq: number; data: Record<string, unknown> },
): FlowNode[] {
  try {
    const data = ev && ev.data && typeof ev.data === "object" ? ev.data : {};
    switch (ev?.kind) {
      case "agent_task":
        return applyAgentTask(tree, data);
      case "tool_call":
        return applyToolCall(tree, data, typeof ev.seq === "number" ? ev.seq : 0);
      case "tool_result":
        return applyToolResult(tree, data);
      default:
        return tree;
    }
  } catch {
    return tree;
  }
}
