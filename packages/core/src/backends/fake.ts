import { contentText } from "../message-delivery.js";
import type { AgentDelivery } from "@chimera/protocol";
import { randomUUID } from "node:crypto";
import type {
  AgentBackend, AgentHandle, BackendCapabilities, BackendEvent, ContentBlock, DialogDecider, EventSink, Image,
  PermissionDecider, RemoteControlHandleResult, ResolvedAgentSpec,
} from "../backend.js";

export type FakeStep =
  | { emit: BackendEvent }
  | { askPermission: { toolName: string; input?: unknown } }
  | { awaitSend: true }
  | { turn: { text?: string } }
  // F50 BUDGET-COVERAGE: billableUsage/costEstimated mirror what a real backend puts on its
  // terminal `result` (claude.ts/codex.ts) so a scenario can drive supervisor.ts's meterTurnCost
  // derivation — a token-only turn ($0 reported, real tokens) and the "this figure was already
  // table-derived" flag — without a live provider. Sparse like costUsd: absent unless set.
  | { end: { resultText: string; structuredOutput?: unknown; costUsd?: number; billableUsage?: Record<string, unknown>; costEstimated?: boolean } }
  // Stays alive (running, no terminal event) until close()/closeInput, then ends with EXACTLY
  // one `result` carrying this text -- no extra turn_complete, mirroring a REAL session's
  // closeInput tail (backends/generic.ts breaks its input loop and sinks a single `result`).
  // The default graceful tail below hard-codes a non-empty "fake:closed:<id>", so it cannot
  // express the "agent finished clean with NOTHING" case a truncated turn actually produces.
  | { awaitClose: { resultText: string } }
  // AGENT-FAILURE-REACHES-CONDUCTOR: exitCode/stderrTail are optional so a scenario can simulate
  // the structured diagnostic fields claude.ts/codex.ts attach to a real process-layer death,
  // without every existing { fail: { message } } caller needing to change.
  // KIMI-HANDSHAKE-CRASH-PARITY: phase is optional for the same reason — lets a scenario
  // simulate kimi.ts's `data.phase:"handshake"` tag (supervisor.onError's backend-crash override)
  // without touching any existing { fail: { message } } caller.
  | { fail: { message: string; exitCode?: number; stderrTail?: string; phase?: string } }
  // native-CLI-parity Phase 1 (Task N1): ergonomic agent_task step for daemon-level
  // functional tests. The generic { emit } already lets a test emit any event
  // (incl. agent_task) — this is convenience only.
  | { task: {
      taskId: string; toolUseId?: string; parentToolUseId?: string; subagentType?: string;
      workflowName?: string; taskType?: string; description?: string; status?: string; skipTranscript?: boolean;
      isBackgrounded?: boolean;
      // Task SHADOW-ACT: the rich per-task progress claude.ts forwards on agent_task
      // (folded into a shadow's activity panel). Sparse like the rest of this step.
      lastToolName?: string; summary?: string; error?: string;
      usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
    } }
  // native-CLI-parity Phase 2 (Task DLG1): fire-and-forget dialog trigger. Unlike askPermission
  // (which the step loop AWAITS), this must NOT be awaited here — the supervisor's decideDialog
  // parks on the pendingDialogs registry until the test calls supervisor.answerDialog(dialogId,
  // ...); awaiting it in the step loop would hang the scenario forever.
  | { dialog: { dialogId: string; dialogKind: string; payload?: Record<string, unknown> } };

export class FakeAgentBackend implements AgentBackend {
  readonly provider: string;
  readonly capabilities: BackendCapabilities = { supportsResume: true, supportsMcpServers: true, supportsSettingSources: true, supportsVoiceRealtime: false };
  public spawns: ResolvedAgentSpec[] = [];
  public deliveries: Array<{ text: string; delivery?: AgentDelivery; content?: ContentBlock[] }> = [];

  // REMOTE-CONTROL: default true (claude-shaped fake) so most scenarios get a handle
  // with a working remoteControl() for free; supervisor-cross-provider-style tests pass
  // false to simulate a provider (codex) whose handle has no live control surface for it.
  // REMOTE-CONTROL-CAPABILITY: optional rejection message so a test can simulate the
  // provider's live policy denial (e.g. "disabled by your organization's policy") without
  // a real credential — supervisor.remoteControl wraps whatever this handle throws.
  constructor(private scenarios: FakeStep[][], provider = "claude", private remoteControlSupported = true, private remoteControlReject?: string) {
    this.provider = provider;
  }

  spawn(spec: ResolvedAgentSpec, sink: EventSink, decidePermission: PermissionDecider, decideDialog?: DialogDecider): AgentHandle {
    this.spawns.push(spec);
    const steps: FakeStep[] = this.scenarios.shift() ?? [
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText: `fake:${spec.prompt}` } },
    ];
    let killed = false;
    // STEP-AGENT-ENDS-DONE: mirrors the real backend's closeInput — `closed` marks that no
    // further input will ever arrive; `doneEmitted` guards against sinking a terminal event
    // twice (e.g. an explicit `end` step followed by a close() that races it).
    let closed = false;
    let doneEmitted = false;
    const pendingSends: string[] = [];
    let wakeSend: ((text: string) => void) | null = null;
    let wakeClose: (() => void) | null = null;

    // A still-alive script finishes its CURRENT turn then its input ends — one final
    // synthetic result, exactly like a real backend's graceful closeInput (never "killed").
    const finishGracefully = () => {
      if (doneEmitted) return;
      doneEmitted = true;
      sink({ kind: "turn_complete", data: {} });
      sink({ kind: "result", data: { text: `fake:closed:${spec.agentId}` } });
    };

    const run = async () => {
      for (const step of steps) {
        if (killed) return;
        if ("emit" in step) sink(step.emit);
        else if ("askPermission" in step) {
          // WORKTREE-AGENT-WRITES-REACH-MAIN: decidePermission may return a string deny reason
          // instead of false — `=== true` (not truthiness) still means allow, since a non-empty
          // string is truthy but must still be treated as denied.
          const decision = await decidePermission({ requestId: randomUUID(), toolName: step.askPermission.toolName, input: step.askPermission.input ?? {} });
          if (killed) return;
          sink(decision === true ? { kind: "tool_call", data: { toolName: step.askPermission.toolName } }
                  // DENIED-TOOL-CALL-INVISIBLE: surface the string deny reason (when present) on
                  // the status event so a test can assert on the actual agent-facing message,
                  // exactly like claude.ts's real decideToolUse does with ToolDecision.message.
                  : { kind: "status", data: { denied: true, toolName: step.askPermission.toolName, ...(typeof decision === "string" ? { message: decision } : {}) } });
        } else if ("awaitSend" in step) {
          // Deliberately UNAWARE of `closed`: a script that scripts itself into a
          // literal awaitSend (e.g. a busy persistent worker mid-conversation) keeps
          // waiting for a real send() regardless of closeInput — retire()'s "graceful,
          // never hard-kills a busy worker" contract relies on this staying blocked.
          const buffered = pendingSends.shift();
          const text = buffered !== undefined
            ? buffered
            : await new Promise<string>((resolve) => { wakeSend = resolve; });
          if (killed) return;
          sink({ kind: "message_complete", data: { text: `echo:${text}` } });
        } else if ("turn" in step) {
          // Task A2: completes a task-turn (optionally emitting the turn's
          // text as message_complete) WITHOUT ending the agent — no `result`
          // event, so persistent/conductor specs stay "running" afterward.
          if (step.turn.text !== undefined) sink({ kind: "message_complete", data: { text: step.turn.text } });
          sink({ kind: "turn_complete", data: {} });
        } else if ("end" in step) {
          sink({ kind: "turn_complete", data: {} });
          sink({ kind: "result", data: {
            text: step.end.resultText,
            ...(step.end.structuredOutput !== undefined ? { structuredOutput: step.end.structuredOutput } : {}),
            ...(step.end.costUsd !== undefined ? { costUsd: step.end.costUsd } : {}),
            ...(step.end.billableUsage !== undefined ? { billableUsage: step.end.billableUsage } : {}),
            ...(step.end.costEstimated !== undefined ? { costEstimated: step.end.costEstimated } : {}),
          } });
          doneEmitted = true;
        } else if ("awaitClose" in step) {
          if (!closed) await new Promise<void>((resolve) => { wakeClose = resolve; });
          if (killed) return;
          doneEmitted = true;
          sink({ kind: "result", data: { text: step.awaitClose.resultText } });
          return;
        } else if ("fail" in step) {
          const { message, exitCode, stderrTail, phase } = step.fail;
          sink({
            kind: "error",
            data: {
              message, ...(exitCode !== undefined ? { exitCode } : {}), ...(stderrTail !== undefined ? { stderrTail } : {}),
              ...(phase !== undefined ? { phase } : {}),
            },
          });
          doneEmitted = true;
        } else if ("task" in step) {
          // Sparse by design: only the keys the caller explicitly set (mirrors the
          // exact-taskId-only test — no key present with an undefined value).
          const { taskId, toolUseId, parentToolUseId, subagentType, workflowName, taskType, description, status, skipTranscript, isBackgrounded, lastToolName, summary, error, usage } = step.task;
          const data: Record<string, unknown> = { taskId };
          if (toolUseId !== undefined) data["toolUseId"] = toolUseId;
          if (parentToolUseId !== undefined) data["parentToolUseId"] = parentToolUseId;
          if (subagentType !== undefined) data["subagentType"] = subagentType;
          if (workflowName !== undefined) data["workflowName"] = workflowName;
          if (taskType !== undefined) data["taskType"] = taskType;
          if (description !== undefined) data["description"] = description;
          if (status !== undefined) data["status"] = status;
          if (skipTranscript !== undefined) data["skipTranscript"] = skipTranscript;
          if (isBackgrounded !== undefined) data["isBackgrounded"] = isBackgrounded;
          if (lastToolName !== undefined) data["lastToolName"] = lastToolName;
          if (summary !== undefined) data["summary"] = summary;
          if (error !== undefined) data["error"] = error;
          if (usage !== undefined) data["usage"] = usage;
          sink({ kind: "agent_task", data });
        } else if ("dialog" in step) {
          void decideDialog?.({
            dialogId: step.dialog.dialogId, dialogKind: step.dialog.dialogKind,
            payload: step.dialog.payload ?? {},
          });
        }
      }
      // STEP-AGENT-ENDS-DONE: the script ran out of steps without an explicit end/fail —
      // this simulates a still-alive conductor/step-agent right after its last scripted
      // turn (mirrors a real session that would otherwise wait for its next input). Stay
      // "running" until close() (or kill()) actually tears it down, rather than silently
      // leaving `run()` to return with no terminal event at all.
      if (killed || doneEmitted) return;
      if (closed) { finishGracefully(); return; }
      await new Promise<void>((resolve) => { wakeClose = resolve; });
      if (killed) return;
      finishGracefully();
    };
    setTimeout(run, 0);

    const handle: AgentHandle = {
      deliver: async function(input) {
        if (input.type === "command") return this.send(input.text);
        const content = input.messages.flatMap(message => message.content);
        const send = input.mode === "steer" && this.steer ? this.steer : this.send;
        const images = content.filter(block => block.type === "image").map(({ type: _type, ...image }) => image);
        await send.call(this, contentText(content), images.length ? images : undefined, content, { messages: input.messages });
      },
      // IMAGE.PASTE / D9: additive optional params, accepted for AgentHandle
      // interface parity — the fake backend doesn't act on attachments (echo
      // behavior is by text only), so they're intentionally ignored here.
      send: async (text: string, images?: Image[], content?: ContentBlock[], delivery?: AgentDelivery) => {
        void images;
        this.deliveries.push({ text, content, delivery });
        if (wakeSend) { const wake = wakeSend; wakeSend = null; wake(text); }
        else pendingSends.push(text);            // never drop: buffer until the script reaches awaitSend
      },
      interrupt: async () => {},
      kill: async () => { killed = true; wakeSend = null; wakeClose = null; },
      // STEP-AGENT-ENDS-DONE: mirrors claude.ts's real close() for the "script ran out of
      // steps" tail wait (wakeClose) only — deliberately leaves a literal `awaitSend` block
      // (wakeSend) alone, since retire()'s busy-persistent-worker contract depends on that
      // staying blocked until a real send() arrives (see the awaitSend branch's comment).
      close: async () => {
        closed = true;
        if (wakeClose) { const wake = wakeClose; wakeClose = null; wake(); }
      },
      ...(this.remoteControlSupported ? {
        remoteControl: async (enable: boolean, name?: string): Promise<RemoteControlHandleResult> => {
          if (enable && this.remoteControlReject) throw new Error(this.remoteControlReject);
          return enable ? { sessionUrl: `https://fake.example/code/session_${name ?? spec.agentId}`, connectUrl: "https://fake.example/code" } : undefined;
        },
      } : {}),
    };
    return handle;
  }
}
