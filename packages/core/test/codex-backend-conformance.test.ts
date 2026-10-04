import { CodexAgentBackend, type CodexThreadEvent } from "@chimera/core/backends/codex";
import type { ResolvedAgentSpec } from "@chimera/core/backend";
import { fakeCodex, cxSpec } from "./codex-backend-helpers.js";
import { runBackendConformance } from "./backend-conformance.js";

const USAGE1 = { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 };

const HAPPY_TURN: CodexThreadEvent[] = [
  { type: "thread.started", thread_id: "th-1" },
  { type: "turn.completed", usage: USAGE1 },
];

// A turn whose stream never yields another event until its AbortSignal fires — this is what
// makes interrupt() actually have something to abort (mirrors codex-backend.test.ts's own
// "interrupt aborts the current turn" scenario).
function hangingTurn(): CodexThreadEvent[] {
  return Object.assign([] as CodexThreadEvent[], { hang: true });
}

const RECOVERED_TURN: CodexThreadEvent[] = [
  { type: "item.completed", item: { id: "a", type: "agent_message", text: "recovered" } },
  { type: "turn.completed", usage: USAGE1 },
];

runBackendConformance({
  label: "CodexAgentBackend",
  makeSpec: (overrides) => cxSpec((overrides ?? {}) as Record<string, unknown>) as ResolvedAgentSpec,
  makeHappyPathBackend: () => new CodexAgentBackend({ codexFactory: fakeCodex([HAPPY_TURN]).factory }),

  supportsInterrupt: true,
  // interruptGraceMs well above the suite's own settle() windows — no timing coupling, mirrors
  // codex-backend.test.ts's "grace far above settle()" comment.
  makeInterruptibleBackend: () => new CodexAgentBackend({
    codexFactory: fakeCodex([hangingTurn(), RECOVERED_TURN]).factory,
    interruptGraceMs: 1000,
  }),

  // Documented in codex.ts: the Codex SDK has no canUseTool/native-dialog equivalent — neither
  // decider is ever invoked, permissionProfile is enforced via the sandbox instead.
  supportsPermissionDecider: false,
  supportsDialogDecider: false,
});
