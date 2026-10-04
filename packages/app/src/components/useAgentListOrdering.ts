import { createContext, useMemo, useRef, useState, type DragEvent } from "react";
import { AGENT_DND_MIME } from "../state/commands.agents";
import { listLocations, listRowKey, loadListOrder, LIST_DND_MIME, moveListRow, orderAgentList, saveListOrder } from "../state/agentListOrder";
import type { AgentListRow } from "../state/selectors.workflows";
import type { GroupsCommands } from "../state/commands.groups";

type TargetKind = "row" | "group" | "ungrouped";
type Drop = { source: string; scope: string; target?: string; after: boolean; group: string | null; membership: boolean; marker: string; position: string };
export const ListOrderingContext = createContext<ReturnType<typeof useAgentListOrdering> | null>(null);

export function useAgentListOrdering(rawRows: readonly AgentListRow[], commands: GroupsCommands) {
  const [order, setOrder] = useState(loadListOrder);
  const [marker, setMarker] = useState<{ key: string; position: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const sourceRef = useRef<string | null>(null);
  const pendingRef = useRef(false);
  const rows = useMemo(() => orderAgentList(rawRows, order), [rawRows, order]);
  const locations = useMemo(() => listLocations(rows), [rows]);
  const rootKeys = rows.filter(row => locations.get(listRowKey(row))?.scope === "root").map(listRowKey);
  const end = (): void => { sourceRef.current = null; setMarker(null); setDragging(false); };
  const start = (event: DragEvent, key: string): void => {
    if ((event.target as HTMLElement).closest("input,button,select,textarea")) { event.preventDefault(); return; }
    sourceRef.current = key;
    setDragging(true);
    event.dataTransfer.setData(LIST_DND_MIME, key);
    if (key.startsWith("agent:")) event.dataTransfer.setData(AGENT_DND_MIME, key.slice(6));
    event.dataTransfer.effectAllowed = key.startsWith("agent:") ? "copyMove" : "move";
  };
  const plan = (event: DragEvent, key: string, kind: TargetKind): Drop | null => {
    const source = sourceRef.current;
    if (!source || source === key || pendingRef.current) return null;
    const from = locations.get(source);
    if (!from) {
      // Job/task member rows retain their existing file-into-group gesture even
      // though their enclosing synthetic row owns placement in the main list.
      if (!source.startsWith("agent:") || kind === "row") return null;
      const group = kind === "group" ? key.slice(6) : null;
      return { source, scope: group ? key : "root", group, after: true, membership: true, marker: key, position: "inside" };
    }
    const after = event.clientY >= event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2;
    if (kind === "ungrouped") {
      if (!source.startsWith("agent:") || (from.group === null && from.scope !== "root")) return null;
      return { source, scope: "root", after: true, group: null, membership: from.group !== null, marker: key, position: "inside" };
    }
    const to = locations.get(key);
    if (!to) return null;
    if (source.startsWith("group:")) {
      if (to.scope !== "root") return null;
      return { source, scope: "root", target: key, after, group: null, membership: false, marker: key, position: after ? "after" : "before" };
    }
    if (kind === "group") {
      const group = key.slice(6);
      if (from.group === group) return null;
      return { source, scope: key, group, after: true, membership: true, marker: key, position: "inside" };
    }
    // Reorder siblings in place. A cross-group drop files the agent beside the
    // target's root, keeping nested children attached to their own parent.
    let target = key;
    let scope = to.scope;
    const membership = from.group !== to.group;
    if (!membership && from.scope !== scope) return null;
    if (membership) {
      while (scope.startsWith("agent:")) {
        target = scope;
        scope = locations.get(target)?.scope ?? "root";
      }
    }
    return { source, scope, target, after, group: to.group, membership, marker: key, position: after ? "after" : "before" };
  };
  const over = (event: DragEvent, key: string, kind: TargetKind = "row"): void => {
    if (!event.dataTransfer.types.includes(LIST_DND_MIME)) return;
    event.stopPropagation();
    const next = plan(event, key, kind);
    event.dataTransfer.dropEffect = next ? "move" : "none";
    if (!next) { setMarker(null); return; }
    event.preventDefault();
    setMarker(old => old?.key === key && old.position === next.position ? old : { key, position: next.position });
  };
  const drop = (event: DragEvent, key: string, kind: TargetKind = "row"): void => {
    if (!event.dataTransfer.types.includes(LIST_DND_MIME)) return;
    event.preventDefault(); event.stopPropagation();
    const next = plan(event, key, kind);
    end();
    if (!next || event.dataTransfer.getData(LIST_DND_MIME) !== next.source) return;
    pendingRef.current = true;
    const visible = next.scope === "root" ? rootKeys
      : [...locations.entries()].filter(([, value]) => value.scope === next.scope).map(([id]) => id);
    void (async () => {
      try {
        if (next.membership && !await commands.setAgentGroup(next.source.slice(6), next.group)) return;
        setOrder(previous => {
          const updated = moveListRow(previous, next.scope, visible, next.source, next.target, next.after);
          saveListOrder(updated);
          return updated;
        });
      } finally { pendingRef.current = false; }
    })();
  };
  const leave = (event: DragEvent): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMarker(null);
  };
  return { rows, dragging, start, end, over, drop, leave, position: (key: string) => marker?.key === key ? marker.position : undefined };
}
