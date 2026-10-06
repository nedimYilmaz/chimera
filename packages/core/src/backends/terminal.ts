// TERMINAL-RUNTIME — the agent as a real CLI on a real PTY, exposed to the rest of chimera as an
// ordinary AgentBackend.
//
// Implementing it against AgentBackend rather than beside the supervisor is what makes this cheap:
// spawn/kill/records/mailbox/deliverTo all keep working untouched, and `send()` — the method the
// supervisor already calls to hand an agent a message from another agent — becomes "type it into
// the terminal". Agent-to-agent messaging works here for free, because it was never coupled to the
// SDK; it is coupled to this interface.
//
// WHAT IS DIFFERENT, stated where a reader will hit it:
//   - No structured event stream. The CLI renders to its own screen, so there are no per-token
//     deltas, no tool_call/tool_result, and no permission callback — permissions are answered in
//     the terminal, by whoever is watching it. The transcript for these agents IS the screen.
//   - No usage push. The CLI still records full per-message token counts in its own transcript
//     file, so cost/ctx are recoverable by reading it; nothing here does that yet.
//   - resume is the tmux session itself: it outlives the daemon, and start() adopts it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDelivery, ContentBlock } from "@chimera/protocol";
import type { AgentBackend, AgentHandle, BackendCapabilities, EventSink, Image, ResolvedAgentSpec } from "../backend.js";
import { deliveryContent, requireTextContent, withMessageInput } from "../message-delivery.js";
import { TmuxTerminalHost, sessionNameFor } from "../terminal-runtime.js";

/** Which CLI a provider is driven by when it runs in a terminal. An unlisted provider is a real
 *  error rather than a guess: launching the wrong binary would look like the agent silently
 *  failing to start. */
const CLI_FOR_PROVIDER: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  kimi: "kimi",
};

/** The provider's own "compact now" command, typed in as an operator would. Absent for a provider
 *  that has none — AgentSupervisor.compact then refuses honestly instead of no-opping. */
const COMPACT_COMMAND: Record<string, string> = {
  claude: "/compact",
  kimi: "/compact",
};

export type TerminalBackendDeps = {
  host?: TmuxTerminalHost;
  /** $CHIMERA_HOME — where the per-agent MCP config is written. */
  home: string;
  /** Absolute path to chimera-mcp.js, so a terminal agent reaches the same tools an SDK one does. */
  mcpBin: string;
  /** node, to run it with. Defaults to whatever is running the daemon. */
  nodeBin?: string;
};

export class TerminalAgentBackend implements AgentBackend {
  readonly provider = "terminal";
  // supportsResume: the SESSION persists, which is a stronger form of the same guarantee — but it
  // is not the SDK's resume-by-id, and claiming it would mislead the supervisor's respawn paths.
  readonly capabilities: BackendCapabilities = {
    supportsResume: false, supportsMcpServers: true, supportsSettingSources: false, supportsVoiceRealtime: false,
  };

  private host: TmuxTerminalHost;

  constructor(private deps: TerminalBackendDeps) {
    this.host = deps.host ?? new TmuxTerminalHost();
  }

  validateInput(content: ContentBlock[]): void { requireTextContent(content); }

  spawn(spec: ResolvedAgentSpec, sink: EventSink): AgentHandle {
    const session = sessionNameFor(spec.agentId);
    const cli = CLI_FOR_PROVIDER[spec.resolvedProvider];
    const started = (async (): Promise<void> => {
      if (!cli) throw new Error(`no terminal CLI known for provider "${spec.resolvedProvider}"`);
      if (!(await this.host.available())) {
        throw new Error("tmux is not installed — a terminal-runtime agent needs it to outlive the app (brew install tmux)");
      }
      const mcpConfig = this.writeMcpConfig(spec);
      const { adopted } = await this.host.start({
        agentId: spec.agentId,
        cwd: spec.cwd,
        command: cli,
        args: this.argsFor(spec, mcpConfig),
        env: spec.env,
      });
      sink({
        kind: "agent_started",
        data: {
          provider: spec.resolvedProvider, runtime: "terminal", session, adopted,
          // The operator's way in. Surfaced rather than left to be reconstructed.
          attach: this.host.attachCommand(session),
        },
      });
    })();
    // A start failure must reach the supervisor as an error EVENT, not an unhandled rejection —
    // the supervisor's crash/failover handling keys off the sink, not off this promise.
    started.catch((err) => sink({ kind: "error", data: { message: (err as Error).message ?? String(err) } }));

    const afterStart = async (fn: () => Promise<void>): Promise<void> => {
      // Every control below has to wait for the session to exist: typing into a session that is
      // still being created is silently dropped by tmux.
      try { await started; } catch { return; }
      await fn();
    };

    return withMessageInput({
      // COMPACTION: backend.ts defines compactCommand as "chimera ASKING the provider's own agent
      // loop to compact, the same way an operator typing /compact into the native CLI does". Here
      // that is not an analogy — it is literally what happens. Per provider, because the command
      // is theirs: codex has none, and inventing one would produce a silent no-op.
      ...(COMPACT_COMMAND[spec.resolvedProvider] !== undefined
        ? { compactCommand: COMPACT_COMMAND[spec.resolvedProvider]! }
        : {}),
      // The supervisor calls this to deliver a mailbox batch — an operator message, or mail from
      // another agent. Typed in and submitted, exactly as a human would.
      send: (text: string, _images?: Image[], _content?: ContentBlock[], delivery?: AgentDelivery) =>
        afterStart(() => this.host.sendCommand(session, requireTextContent(deliveryContent(text, _images, _content, delivery)))),
      // Escape is the CLI's own "stop what you are doing" and leaves the session alive. Ctrl-C
      // would be a coarser signal that can take the process down — a different operation, and the
      // supervisor already has kill() for that.
      interrupt: () => afterStart(() => this.host.sendKey(session, "Escape")),
      kill: () => afterStart(() => this.host.stop(session)),
      close: () => afterStart(() => this.host.stop(session)),
    });
  }

  /** The chimera MCP server, wired exactly as the SDK path wires it — same stdio server, same
   *  identity env — so a terminal agent is a first-class member of the fleet rather than a process
   *  that happens to be running nearby. */
  private writeMcpConfig(spec: ResolvedAgentSpec): string {
    const dir = join(this.deps.home, "terminal-agents");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${spec.agentId}.mcp.json`);
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        ...spec.mcpServers,
        chimera: {
          type: "stdio",
          command: this.deps.nodeBin ?? process.execPath,
          args: [this.deps.mcpBin],
          env: spec.env,
        },
      },
    }, null, 2));
    return path;
  }

  private argsFor(spec: ResolvedAgentSpec, mcpConfig: string): string[] {
    const args = ["--mcp-config", mcpConfig, "--strict-mcp-config"];
    if (spec.model) args.push("--model", spec.model);
    // The agent's opening instruction. Passed as the initial prompt so the terminal starts on the
    // work rather than on an empty prompt someone has to notice and fill in.
    if (spec.prompt) args.push(requireTextContent(deliveryContent(spec.prompt, undefined, spec.content, spec.initialDelivery)));
    return args;
  }
}
