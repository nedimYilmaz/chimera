import { describe, it, expect } from "vitest";
import { TmuxTerminalHost, sessionNameFor, type Exec, type ExecResult } from "@chimera/core/terminal-runtime";

// TERMINAL-RUNTIME — the tmux control surface, driven through the exec seam so no tmux binary and
// no real session are involved. What is pinned here is the set of things that fail SILENTLY and
// destructively if they drift: target exactness, environment isolation, and restart adoption.

function fakeTmux(responses: Record<string, ExecResult> = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const key = args[0] ?? "";
    return responses[key] ?? { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls, argsOf: (verb: string) => calls.find((c) => c[1] === verb) };
}

const spec = {
  agentId: "wispy-otter",
  cwd: "/tmp/work",
  command: "claude",
  args: ["--mcp-config", "/tmp/m.json"],
  env: { CHIMERA_AGENT_ID: "wispy-otter", CHIMERA_TREE_ID: "tree-1" },
};

describe("sessionNameFor", () => {
  it("prefixes chimera- so a fleet session is distinguishable from the operator's own", () => {
    expect(sessionNameFor("wispy-otter")).toBe("chimera-wispy-otter");
  });

  it("strips tmux target punctuation, which is NOT opaque", () => {
    // '.' selects a pane and ':' a window in tmux's target syntax — an agent id carrying either
    // would address something other than its own session, or nothing.
    expect(sessionNameFor("agent.1:2")).toBe("chimera-agent-1-2");
    expect(sessionNameFor("a/b c")).toBe("chimera-a-b-c");
  });
});

describe("TmuxTerminalHost.start", () => {
  it("creates a DETACHED session running the agent's command", async () => {
    const t = fakeTmux({ "has-session": { code: 1, stdout: "", stderr: "" } });
    const host = new TmuxTerminalHost(t.exec);
    const { session, adopted } = await host.start(spec);
    expect(session).toBe("chimera-wispy-otter");
    expect(adopted).toBe(false);
    const args = t.argsOf("new-session")!;
    expect(args).toContain("-d");                       // detached: it must outlive whoever started it
    expect(args.slice(args.indexOf("--"))).toEqual(["--", "claude", "--mcp-config", "/tmp/m.json"]);
  });

  it("passes the agent's identity through tmux -e, not through the daemon's own environment", async () => {
    // The daemon carries its own CHIMERA_* vars; inheriting them would let the DAEMON's identity
    // decide who the agent is. Same contamination the app's PTY strips for the operator shell.
    const t = fakeTmux({ "has-session": { code: 1, stdout: "", stderr: "" } });
    await new TmuxTerminalHost(t.exec).start(spec);
    const args = t.argsOf("new-session")!;
    expect(args).toContain("CHIMERA_AGENT_ID=wispy-otter");
    expect(args).toContain("CHIMERA_TREE_ID=tree-1");
  });

  it("ADOPTS a session that is already up instead of failing", async () => {
    // A daemon restart must not strand a running agent — this is the call it makes coming back up.
    const t = fakeTmux({ "has-session": { code: 0, stdout: "", stderr: "" } });
    const { adopted } = await new TmuxTerminalHost(t.exec).start(spec);
    expect(adopted).toBe(true);
    expect(t.argsOf("new-session")).toBeUndefined();   // nothing was re-created
  });

  it("reports tmux's own error rather than a generic failure", async () => {
    const t = fakeTmux({
      "has-session": { code: 1, stdout: "", stderr: "" },
      "new-session": { code: 1, stdout: "", stderr: "no space left on device\n" },
    });
    await expect(new TmuxTerminalHost(t.exec).start(spec)).rejects.toThrow(/no space left on device/);
  });
});

describe("every target is matched EXACTLY", () => {
  // tmux matches -t by PREFIX unless the target is written '=name'. Without it, an agent named
  // `a` would kill, capture from, or type into a session named `abc`. This is the destructive one.
  const cases: Array<[string, (h: TmuxTerminalHost) => Promise<unknown>]> = [
    ["has-session", (h) => h.isAlive("chimera-a")],
    ["kill-session", (h) => h.stop("chimera-a")],
    ["capture-pane", (h) => h.capture("chimera-a")],
    ["send-keys", (h) => h.sendKey("chimera-a", "Enter")],
  ];
  for (const [verb, run] of cases) {
    it(`${verb} addresses =session`, async () => {
      const t = fakeTmux();
      await run(new TmuxTerminalHost(t.exec));
      const args = t.argsOf(verb)!;
      expect(args[args.indexOf("-t") + 1]).toBe("=chimera-a");
    });
  }
});

describe("typing into a live agent", () => {
  it("sends a slash command as literal text, then Enter", async () => {
    const t = fakeTmux();
    await new TmuxTerminalHost(t.exec).sendCommand("chimera-a", "/compact");
    const typed = t.calls.filter((c) => c[1] === "send-keys");
    expect(typed[0]!).toEqual(["tmux", "send-keys", "-t", "=chimera-a", "-l", "--", "/compact"]);
    expect(typed[1]!.slice(-1)).toEqual(["Enter"]);
  });

  it("types text LITERALLY — a message containing a key name is not a keypress", async () => {
    // send-keys reads each argument as a key name first. Without -l, delivering the word
    // "Escape" to an agent would press Escape instead of typing it — and agent-to-agent mail is
    // arbitrary text.
    const t = fakeTmux();
    await new TmuxTerminalHost(t.exec).sendText("chimera-a", "press Escape then C-c");
    expect(t.argsOf("send-keys")!).toEqual(["tmux", "send-keys", "-t", "=chimera-a", "-l", "--", "press Escape then C-c"]);
  });

  it("pastes MULTI-LINE text through a bracketed paste instead of submitting at the first newline", async () => {
    // A literal newline submits the prompt: a three-line message would deliver its first line and
    // leave the rest half-typed. Bracketed paste is what a human pasting it would get.
    const t = fakeTmux();
    await new TmuxTerminalHost(t.exec).sendText("chimera-a", "line one\nline two");
    expect(t.argsOf("set-buffer")!).toEqual(["tmux", "set-buffer", "-b", "chimera-chimera-a", "--", "line one\nline two"]);
    const paste = t.argsOf("paste-buffer")!;
    expect(paste).toContain("-p");   // bracketed
    expect(paste).toContain("-d");   // and not left in tmux's paste history afterwards
    expect(paste[paste.indexOf("-t") + 1]).toBe("=chimera-a");
    expect(t.argsOf("send-keys")).toBeUndefined();
  });

  it("says nothing at all for an empty message", async () => {
    const t = fakeTmux();
    await new TmuxTerminalHost(t.exec).sendText("chimera-a", "");
    expect(t.calls).toEqual([]);
  });

  it("captures scrollback ABOVE the visible screen when asked", async () => {
    const t = fakeTmux();
    await new TmuxTerminalHost(t.exec).capture("chimera-a", 500);
    expect(t.argsOf("capture-pane")).toContain("-500");   // tmux counts history as negative rows
  });

  it("captures only the visible screen by default", async () => {
    const t = fakeTmux();
    await new TmuxTerminalHost(t.exec).capture("chimera-a");
    expect(t.argsOf("capture-pane")).not.toContain("-S");
  });
});

describe("degradation and discovery", () => {
  it("reports tmux as unavailable rather than throwing, so a daemon without it still boots", async () => {
    const t = fakeTmux({ "-V": { code: null, stdout: "", stderr: "ENOENT" } });
    expect(await new TmuxTerminalHost(t.exec).available()).toBe(false);
  });

  it("lists only chimera's own sessions — never touches the operator's", async () => {
    const t = fakeTmux({ "list-sessions": { code: 0, stdout: "chimera-a\nmy-work\nchimera-b\n", stderr: "" } });
    expect(await new TmuxTerminalHost(t.exec).list()).toEqual(["chimera-a", "chimera-b"]);
  });

  it("treats 'no server running' as an empty list, not an error", async () => {
    const t = fakeTmux({ "list-sessions": { code: 1, stdout: "", stderr: "no server running" } });
    expect(await new TmuxTerminalHost(t.exec).list()).toEqual([]);
  });

  it("hands the operator the exact command to sit down at an agent", async () => {
    expect(new TmuxTerminalHost(fakeTmux().exec).attachCommand("chimera-a")).toBe("tmux attach -t chimera-a");
  });
});
