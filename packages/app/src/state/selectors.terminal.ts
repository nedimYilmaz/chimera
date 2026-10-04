import type { TerminalState, TerminalTab } from "@chimera/ui-state";

export type TerminalDockView = {
  tabs: TerminalTab[];
  activeId: string | null;
  open: boolean;
};

// TERMINAL-DOCK-PER-AGENT: the single source of truth for "what should agent X's dock show".
// `terminals.tabs` is one flat list (every tab stays mounted regardless of the selected agent —
// see TerminalView.tsx's unmount-kills-the-PTY gotcha), so this filters down to one agent's
// slice. `agentId: null` (no agent selected) always yields an empty, closed dock — there is
// nothing to scope it to. A tab with `agentId: null` never matches any real agentId, so it's
// mounted (in the flat list) but permanently absent from every dock — see TerminalState's doc
// comment in ui-state/src/types.ts.
export function terminalDockForAgent(terminals: TerminalState, agentId: string | null): TerminalDockView {
  if (agentId === null) return { tabs: [], activeId: null, open: false };
  const tabs = terminals.tabs.filter((t) => t.agentId === agentId);
  return {
    tabs,
    activeId: tabs.length > 0 ? (terminals.activeByAgent[agentId] ?? null) : null,
    open: tabs.length > 0 && !!terminals.openByAgent[agentId],
  };
}
