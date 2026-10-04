import { AgentSpecSchema } from "@chimera/protocol";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { ResolvedAgentSpec } from "@chimera/core/backend";
import { runBackendConformance } from "./backend-conformance.js";

function fakeSpec(overrides: Partial<ResolvedAgentSpec> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/repo", isolation: "none" }),
    agentId: "fake-conformance-1", accountName: "fake-main", resolvedProvider: "claude",
    env: {}, depth: 0,
    ...overrides,
  } as ResolvedAgentSpec;
}

const HAPPY: FakeStep[] = [{ end: { resultText: "ok" } }];

runBackendConformance({
  label: "FakeAgentBackend",
  makeSpec: fakeSpec,
  makeHappyPathBackend: () => new FakeAgentBackend([HAPPY]),

  // FakeAgentBackend's interrupt() is a deliberate no-op (fake.ts: `interrupt: async () => {}`) —
  // it exists to drive supervisor-scheduling tests, not to model the interrupt/grace loop.
  supportsInterrupt: false,

  supportsPermissionDecider: true,
  makePermissionScenario: () => new FakeAgentBackend([[
    { askPermission: { toolName: "conformance-tool" } },
    { end: { resultText: "done" } },
  ]]),

  supportsDialogDecider: true,
  makeDialogScenario: () => new FakeAgentBackend([[
    { dialog: { dialogId: "conformance-dialog", dialogKind: "test" } },
    { end: { resultText: "done" } },
  ]]),
});
