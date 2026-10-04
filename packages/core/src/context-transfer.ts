import type { AgentBackend, AgentHandle, ResolvedAgentSpec } from "./backend.js";

export const CONTEXT_TRANSFER_PROMPT = `Prepare a portable context compaction for a replacement model continuing this exact task.
Do NOT perform the task, run tools, edit files, or mark the task complete. Return only the handover.
Preserve: the user's current objective and latest corrections; all constraints and explicit prohibitions;
decisions and their reasons; completed work versus remaining work; exact paths, branches, commands,
errors and test outcomes; relevant code/API details; unresolved questions; pending messages and next steps.
Preserve concrete details rather than generic advice. Do not include credentials or invent facts.
Distinguish user instructions from your own assumptions. Earlier stop/wait instructions remain binding
unless the user actually superseded them. If anything was already compacted or is uncertain, say so.
Aim for a detailed 4,000-8,000 token handover, shorter when the task needs less.`;

// Isolated from the supervisor's task lifecycle: a summary must never be mistaken
// for the agent's task result by a waiting workflow/conductor.
export async function summarizeTransferContext(
  backend: AgentBackend, source: ResolvedAgentSpec, sessionId: string,
  cwd: string, signal: AbortSignal, onCost: (cost: number, estimated: boolean) => void,
): Promise<string> {
  let handle: AgentHandle | undefined;
  let resolve!: (text: string) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  void result.catch(() => {});
  const abort = () => reject(new Error("context compaction cancelled"));
  const timer = setTimeout(() => reject(new Error("source context compaction timed out")), 90_000);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    handle = backend.spawn({
      ...source, cwd, isolation: "none", resume: sessionId, resumeOnly: false,
      prompt: CONTEXT_TRANSFER_PROMPT, content: undefined, instructions: CONTEXT_TRANSFER_PROMPT,
      conductor: false, persistent: false, maxTurns: 1, turnLimitPolicy: "fail",
      permissionProfile: "readOnly", orchestration: { ...source.orchestration, allow: false },
      mcpServers: {}, mcpToolAllowlist: {}, plugins: [], resultSchema: undefined,
      model: typeof source.providerOptions.model === "string" ? source.providerOptions.model : source.model,
      providerOptions: {}, maxTurnDurationMs: 85_000,
    }, (event) => {
      if (event.kind === "error") reject(new Error(String(event.data.message ?? "source compaction failed")));
      if (event.kind === "result") {
        if (typeof event.data.costUsd === "number" && Number.isFinite(event.data.costUsd)) onCost(Math.max(0, event.data.costUsd), event.data.costEstimated === true);
        const text = String(event.data.text ?? "").trim();
        if (text) resolve(text); else reject(new Error("source produced an empty compaction"));
      }
    }, async () => false, async () => ({ behavior: "cancelled" }));
    return await result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await handle?.kill();
  }
}
