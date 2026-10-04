import { isAgentUnseen } from "@chimera/protocol";
import type { AgentView, UiState } from "./types.js";

// F47: the ONE unseen predicate both front ends call, delegating to protocol's isAgentUnseen so
// core and the UIs share a single comparison. Re-exported through @chimera/ui-state because the
// TUI and app import UI helpers from here, never from protocol directly.
export function isUnseen(a: Pick<AgentView, "attentionAt" | "reviewedAt"> | undefined): boolean {
  return a !== undefined && isAgentUnseen(a);
}

// F47: the fleet's attention count — what the app's header chip renders and what "mark all seen"
// targets. Fold-INSENSITIVE and query-insensitive, matching fleetSummary's own contract
// (app/selectors.ts): folding a team hides rows, it does not mean the operator read them.
export function unseenAgentIds(state: Pick<UiState, "agents" | "agentOrder">): string[] {
  return state.agentOrder.filter((id) => isUnseen(state.agents[id]));
}

// F47.UI: the attention-only view's row filter — every unseen agent PLUS the ancestors needed to
// keep it reachable, so a filter meant to surface a deep worker never orphans it out of its tree.
// Order-preserving subsequence of `order`. The app has its own copy over its richer row state
// (selectors.filterOrderForUnseen); this one is what the TUI's AgentList and the reducer's
// visible-order mirror BOTH call, which is the only way row rendering, mouse hit-testing and
// ↑/↓ selection can agree on which rows exist.
export function filterOrderForUnseen(
  state: Pick<UiState, "agents">,
  order: readonly string[],
): string[] {
  return filterOrderKeeping(state, order, (a) => isUnseen(a));
}

// The ancestor-preserving row filter itself, generic over the predicate: F47's attention view and
// F08.UI's needs-operator view must orphan a deep worker in EXACTLY the same way (i.e. not at
// all), so they share one lineage walk rather than two that can drift.
export function filterOrderKeeping(
  state: Pick<UiState, "agents">,
  order: readonly string[],
  pred: (a: AgentView | undefined) => boolean,
): string[] {
  const keep = new Set<string>();
  for (const id of order) if (pred(state.agents[id])) keep.add(id);
  if (keep.size === 0) return [];
  const depthOf = (id: string): number => state.agents[id]?.displayDepth ?? state.agents[id]?.depth ?? 0;
  const treeOf = (id: string): string => state.agents[id]?.treeId ?? id;
  const parentOf = new Map<string, string>();
  const stack: string[] = [];
  for (const id of order) {
    const owner = state.agents[id]?.originConductorId;
    if (owner && state.agents[owner]) parentOf.set(id, owner);
    const d = depthOf(id);
    while (stack.length > 0 && depthOf(stack[stack.length - 1]!) >= d) stack.pop();
    const top = stack[stack.length - 1];
    if (!parentOf.has(id) && top !== undefined && d > 0 && treeOf(top) === treeOf(id)) parentOf.set(id, top);
    stack.push(id);
  }
  for (const id of [...keep]) {
    let cur = parentOf.get(id);
    while (cur !== undefined && !keep.has(cur)) { keep.add(cur); cur = parentOf.get(cur); }
  }
  return order.filter((id) => keep.has(id));
}
