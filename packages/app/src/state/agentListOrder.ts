import type { AgentListRow } from "./selectors.workflows";

export const LIST_ORDER_KEY = "chimera.agentList.order.v1";
export const LIST_DND_MIME = "application/x-chimera-list-row";
export type ListOrder = Record<string, string[]>;
export const listRowKey = (row: AgentListRow): string => row.kind === "agent" ? `agent:${row.agentId}`
  : row.kind === "group" ? `group:${row.groupId}` : row.kind === "task" ? `task:${row.taskId}` : `job:${row.jobName}`;

type Node = { row: AgentListRow; children: Node[] };
function forest(rows: readonly AgentListRow[]): Node[] {
  const roots: Node[] = [];
  const stack: Node[] = [];
  for (const row of rows) {
    const node: Node = { row, children: [] };
    if (row.kind !== "agent" && row.kind !== "task") { roots.push(node); stack.length = 0; continue; }
    while (stack.length && (stack.at(-1)!.row as { depth: number }).depth >= row.depth) stack.pop();
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  return roots;
}

/** Sort siblings, never individual rows out of their subtree. Unknown/new rows retain order. */
export function orderAgentList(rows: readonly AgentListRow[], order: ListOrder): AgentListRow[] {
  const walk = (nodes: Node[], scope: string): AgentListRow[] => {
    const rank = new Map((order[scope] ?? []).map((key, i) => [key, i]));
    return [...nodes].sort((a, b) => (rank.get(listRowKey(a.row)) ?? Infinity) - (rank.get(listRowKey(b.row)) ?? Infinity))
      .flatMap(({ row, children }) => [row.kind === "group"
        ? { ...row, memberRows: walk(forest(row.memberRows), listRowKey(row)) } : row,
      ...walk(children, listRowKey(row))]);
  };
  return walk(forest(rows), "root");
}

export type RowLocation = { scope: string; group: string | null; siblings: string[] };
export function listLocations(rows: readonly AgentListRow[]): Map<string, RowLocation> {
  const result = new Map<string, RowLocation>();
  const walk = (nodes: Node[], scope: string, group: string | null): void => {
    const siblings = nodes.map(node => listRowKey(node.row));
    for (const { row, children } of nodes) {
      const key = listRowKey(row);
      result.set(key, { scope, group, siblings });
      if (row.kind === "group") walk(forest(row.memberRows), key, row.groupId);
      walk(children, key, group);
    }
  };
  walk(forest(rows), "root", null);
  return result;
}

export function moveListRow(order: ListOrder, scope: string, visible: readonly string[], source: string, target?: string, after = false): ListOrder {
  // Preserve hidden siblings while inserting around a visible target, so a filtered drag
  // cannot erase ordering for the rest of the fleet.
  const ids = [...new Set([...(order[scope] ?? []), ...visible])].filter(id => id !== source);
  const at = target ? ids.indexOf(target) : -1;
  ids.splice(at < 0 ? ids.length : at + Number(after), 0, source);
  return { ...order, [scope]: ids };
}

export function loadListOrder(): ListOrder {
  try {
    const raw = localStorage.getItem(LIST_ORDER_KEY);
    if (!raw || raw.length > 1_000_000) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => Array.isArray(value))
      .map(([scope, value]) => [scope, [...new Set((value as unknown[]).filter((id): id is string => typeof id === "string"))].slice(-10000)]));
  } catch { return {}; }
}
export function saveListOrder(order: ListOrder): void {
  try { localStorage.setItem(LIST_ORDER_KEY, JSON.stringify(order)); } catch { /* Storage failure must not prevent in-session sorting. */ }
}
