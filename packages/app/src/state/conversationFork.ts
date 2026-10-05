import { useSyncExternalStore } from "react";
import { dismissAppLocalOverlays } from "./overlayLifecycle";

type Branch = { agentId: string; upToSeq?: number; instance: number };
let branch: Branch | null = null;
let notice: { source: string; child: string; label: string } | null = null;
let instance = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const fn of listeners) fn(); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export function openConversationFork(agentId: string, upToSeq?: number): void {
  dismissAppLocalOverlays({ preserveAgentDetail: true });
  branch = { agentId, upToSeq, instance: ++instance }; emit();
}
export function closeConversationFork(): void { branch = null; emit(); }
export function branchCreated(source: string, child: string, label: string): void { notice = { source, child, label }; closeConversationFork(); }
export function useConversationFork(): Branch | null { return useSyncExternalStore(subscribe, () => branch); }
export function useBranchNotice() { return useSyncExternalStore(subscribe, () => notice); }

let mounted = 0;
export function mountConversationForkCard(): () => void {
  mounted++; let active = true;
  return () => { if (active) { active = false; mounted--; } };
}
export function conversationForkOwnsEscape(): boolean { return mounted > 0; }
