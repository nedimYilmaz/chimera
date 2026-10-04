import { Channel, invoke } from "@tauri-apps/api/core";
import type { UiStore } from "@chimera/ui-state";
import { displayName } from "./selectors";

export function terminalCwdFor(agent: { id: string; workdir?: string | null }): string {
  return agent.workdir && agent.workdir.length > 0 ? agent.workdir : "~";
}

export type PtyMsg = { kind: "output"; b64: string } | { kind: "exit"; code: number | null };

type OpenFn = (cwd: string, cols: number, rows: number, onOutput: Channel<PtyMsg>) => Promise<string>;

const defaultOpen: OpenFn = (cwd, cols, rows, onOutput) =>
  invoke<string>("term_open", { cwd, cols, rows, onOutput });

// TerminalView attaches its onmessage handler after mount, which can happen a tick after
// openTerminalForAgent resolves — keep the Channel alive here so early PTY output isn't lost
// to garbage collection before the view subscribes.
const sinks = new Map<string, Channel<PtyMsg>>();

export function registerSink(id: string, channel: Channel<PtyMsg>): void {
  sinks.set(id, channel);
}

export function takeSink(id: string): Channel<PtyMsg> | undefined {
  return sinks.get(id);
}

export function releaseSink(id: string): void {
  sinks.delete(id);
}

type OpenCmdFn = (cwd: string, cols: number, rows: number, command: string[], onOutput: Channel<PtyMsg>) => Promise<string>;
const defaultOpenCmd: OpenCmdFn = (cwd, cols, rows, command, onOutput) =>
  invoke<string>("term_open_command", { cwd, cols, rows, command, onOutput });

/** TERMINAL-RUNTIME: attach a live VIEW to an agent that is running as a real CLI.
 *
 *  This opens `tmux attach`, not the agent — the session belongs to the daemon. Closing the panel,
 *  or the whole app, detaches; the agent keeps running and can be attached again from here or from
 *  any terminal. That is the property the runtime exists for, so the view must not be able to
 *  violate it by accident. */
export async function attachAgentTerminal(
  agent: { id: string; workdir?: string | null; session: string },
  open: OpenCmdFn = defaultOpenCmd,
): Promise<{ id: string; channel: Channel<PtyMsg> }> {
  const onOutput = new Channel<PtyMsg>();
  // `=session` is tmux's EXACT-match target. Without it an agent named `a` would attach to a
  // session named `abc` — the same prefix-matching hazard core guards on every other target.
  const id = await open(terminalCwdFor(agent), 120, 32, ["tmux", "attach", "-t", `=${agent.session}`], onOutput);
  registerSink(id, onOutput);
  return { id, channel: onOutput };
}

// TERMINAL-NAMES: tabs used to be titled after the LAST PATH SEGMENT of their cwd, so every
// terminal an agent opened in the same repo was called the same thing — indistinguishable in the
// tab strip and unaddressable by name. A name is now a handle, not decoration: terminal_read and
// terminal_write both take one.
//
// `<agent>-<n>`, numbered per agent, and n counts from the HIGHEST existing suffix rather than the
// tab count, so closing the middle tab of three does not hand the next one a name that is already
// on screen.
export function defaultTerminalTitle(store: UiStore, agentId: string): string {
  const agent = store.getState().agents[agentId];
  // The SAME name the agent shows everywhere else. Written as a duplicate first, which quietly
  // produced "74c05eee-1" where the rest of the UI says "brave-otter" — a tab you cannot connect
  // to the agent it belongs to.
  const name = agent ? displayName(agent) : agentId.slice(0, 8);
  const prefix = `${name}-`;
  let highest = 0;
  for (const t of store.getState().terminals.tabs) {
    if (t.agentId !== agentId || !t.title.startsWith(prefix)) continue;
    const n = Number.parseInt(t.title.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return `${prefix}${highest + 1}`;
}

export async function openTerminalForAgent(
  store: UiStore,
  agent: { id: string; workdir?: string | null },
  open: OpenFn = defaultOpen,
): Promise<void> {
  const cwd = terminalCwdFor(agent);
  const onOutput = new Channel<PtyMsg>();
  const id = await open(cwd, 80, 24, onOutput);
  registerSink(id, onOutput);
  store.dispatch({
    type: "terminalOpened",
    tab: { id, title: defaultTerminalTitle(store, agent.id), cwd, agentId: agent.id, exited: null },
  });
}
