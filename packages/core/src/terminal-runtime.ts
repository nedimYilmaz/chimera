// TERMINAL-RUNTIME — running an agent as a real CLI in a real terminal, instead of through the SDK.
//
// WHY THIS EXISTS. chimera drives agents through the Agent SDK, which itself spawns the `claude`
// binary with `--output-format stream-json`. That gives structured events (token usage, tool calls,
// a permission callback) but costs the terminal: the CLI knows it is headless and refuses its
// interactive commands — measured, the refusal is a distinct telemetry class, `cmd_unavailable_
// headless`, not `cmd_unknown`. Run the same binary on a real PTY and those commands work.
//
// WHY TMUX AND NOT A BARE PTY. The PTY lives in the desktop app on purpose (packages/app/src-tauri/
// src/pty.rs: the shell then runs with exactly the operator's privileges and adds no trust boundary
// on the daemon socket). But an AGENT belongs to the daemon, and an agent that dies when a window
// closes is not an agent. tmux resolves the split: the daemon owns a detached session, the app
// attaches a view to it, and the operator can attach from any terminal they like
// (`tmux attach -t chimera-<id>`). Session, scrollback and process all outlive the app.
//
// WHAT THIS COSTS, stated plainly: there is no permission callback (the CLI asks in its own
// terminal), no structured tool-call stream, and no push token accounting — the last of which is
// recoverable, because the CLI writes full per-message usage into its own transcript JSONL.

import { spawn } from "node:child_process";

export type TerminalAgentSpec = {
  agentId: string;
  cwd: string;
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  cols?: number;
  rows?: number;
};

export type ExecResult = { code: number | null; stdout: string; stderr: string };
/** The process seam. Tests drive the whole lifecycle without a tmux binary. */
export type Exec = (file: string, args: readonly string[]) => Promise<ExecResult>;

export const realExec: Exec = (file, args) =>
  new Promise((resolve) => {
    const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => { stdout += String(c); });
    child.stderr?.on("data", (c) => { stderr += String(c); });
    child.on("error", (e) => resolve({ code: null, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

/** tmux session name for an agent.
 *
 *  Sanitized because tmux's target syntax is not opaque: `.` separates a pane index and `:` a
 *  window, so an agent id carrying either would address something other than the session — or
 *  nothing at all. Everything outside a safe set collapses to `-`. */
export function sessionNameFor(agentId: string): string {
  return `chimera-${agentId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** tmux matches `-t name` by PREFIX unless the target is written `=name`. Without this, an agent
 *  named `a` would happily kill, capture from, or type into a session named `abc`. Every target
 *  this module builds goes through here. */
const exact = (session: string): string => `=${session}`;

export class TmuxTerminalHost {
  constructor(private exec: Exec = realExec, private tmuxBin = "tmux") {}

  /** Is tmux usable at all? Callers degrade rather than fail — a missing tmux means no detachable
   *  agent terminals, not a broken daemon. */
  async available(): Promise<boolean> {
    const r = await this.exec(this.tmuxBin, ["-V"]);
    return r.code === 0;
  }

  async isAlive(session: string): Promise<boolean> {
    const r = await this.exec(this.tmuxBin, ["has-session", "-t", exact(session)]);
    return r.code === 0;
  }

  /** Start (or adopt) the agent's session, detached. Returns the session name.
   *
   *  Adopting an EXISTING session rather than failing is deliberate: a daemon restart must not
   *  strand a running agent, and this is the operation it calls on the way back up. */
  async start(spec: TerminalAgentSpec): Promise<{ session: string; adopted: boolean }> {
    const session = sessionNameFor(spec.agentId);
    if (await this.isAlive(session)) return { session, adopted: true };

    const args = [
      "new-session", "-d", "-s", session,
      "-x", String(spec.cols ?? 200), "-y", String(spec.rows ?? 50),
      "-c", spec.cwd,
    ];
    // `-e` (tmux 3.2+) sets the session environment explicitly instead of leaking the daemon's
    // whole environment into the agent. That matters here specifically: the daemon's own
    // CHIMERA_* vars would otherwise decide the agent's identity, which is the exact
    // cross-contamination the app's PTY strips for the operator shell.
    for (const [k, v] of Object.entries(spec.env)) args.push("-e", `${k}=${v}`);
    args.push("--", spec.command, ...spec.args);

    const r = await this.exec(this.tmuxBin, args);
    if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return { session, adopted: false };
  }

  /** Press a KEY. The argument is interpreted by tmux as a key name ("Enter", "Escape", "C-c"). */
  async sendKey(session: string, ...keys: readonly string[]): Promise<void> {
    await this.exec(this.tmuxBin, ["send-keys", "-t", exact(session), ...keys]);
  }

  /** Type TEXT, literally, without submitting it.
   *
   *  Two things make this more than `send-keys <text>`:
   *
   *  1. send-keys reads each argument as a KEY NAME first. A message containing the word "Escape",
   *     or "C-c", would be delivered as that keypress instead of as those characters — and an
   *     agent-to-agent message is arbitrary text. `-l` forces literal.
   *  2. A newline inside literal text SUBMITS the prompt. A multi-line message would send its
   *     first line and leave the rest as a half-typed follow-up. Routed through a tmux buffer and
   *     pasted with `-p` (bracketed paste), the CLI receives it as pasted input and does not
   *     submit on the embedded newlines — which is exactly what a human pasting it would get. */
  async sendText(session: string, text: string): Promise<void> {
    if (text.length === 0) return;
    if (!text.includes("\n")) {
      await this.exec(this.tmuxBin, ["send-keys", "-t", exact(session), "-l", "--", text]);
      return;
    }
    const buffer = `chimera-${session}`;
    await this.exec(this.tmuxBin, ["set-buffer", "-b", buffer, "--", text]);
    // -d deletes the buffer after pasting, so a long message is not left sitting in tmux's
    // paste history where the next `paste-buffer` (or the operator) would pick it up again.
    await this.exec(this.tmuxBin, ["paste-buffer", "-b", buffer, "-p", "-d", "-t", exact(session)]);
  }

  /** Type text and submit it — one delivered message, or one slash command. This is how a
   *  terminal-runtime agent receives mail from another agent, and how the header's /compact,
   *  /effort and /model reach it (an SDK agent gets those through an RPC instead). */
  async sendCommand(session: string, command: string): Promise<void> {
    await this.sendText(session, command);
    await this.sendKey(session, "Enter");
  }

  /** The visible screen, plus `scrollback` lines of history above it. */
  async capture(session: string, scrollback = 0): Promise<string> {
    const args = ["capture-pane", "-p", "-t", exact(session)];
    if (scrollback > 0) args.push("-S", String(-scrollback));
    const r = await this.exec(this.tmuxBin, args);
    return r.code === 0 ? r.stdout : "";
  }

  async stop(session: string): Promise<void> {
    await this.exec(this.tmuxBin, ["kill-session", "-t", exact(session)]);
  }

  /** Every chimera-owned session currently up — what a daemon reconciles against on boot. */
  async list(): Promise<string[]> {
    const r = await this.exec(this.tmuxBin, ["list-sessions", "-F", "#{session_name}"]);
    if (r.code !== 0) return [];   // "no server running" is not an error worth propagating
    return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("chimera-"));
  }

  /** The command an operator runs to sit down at this agent. Surfaced in the UI rather than left
   *  for someone to reconstruct. */
  attachCommand(session: string): string {
    return `tmux attach -t ${session}`;
  }
}
