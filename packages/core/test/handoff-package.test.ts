import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { buildHandoffPackage } from "@chimera/core/handoff-package";
import type { AgentRecord } from "@chimera/core/supervisor";

// CROSS-PROVIDER-HANDOFF: buildHandoffPackage is the pure, unit-testable core of the
// portable-brief mechanism — mechanical extraction (no LLM), ranked frequency->recency,
// char-budgeted per the target model's context window. This exercises it directly, without
// the full supervisor.handoff() plumbing (that's supervisor-handoff.test.ts).

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: "agent-1", accountName: "main", provider: "claude", state: "running",
    depth: 0, treeId: "agent-1", createdAt: Date.now(), principal: "local", attempts: [],
    costUsd: 0, parentId: null, projectId: null,
    spec: {
      prompt: "original brief text", cwd: "/tmp/x", isolation: "worktree",
      account: "main", model: "claude-sonnet-5", permissionProfile: "acceptEdits",
      autonomy: "ask", acknowledgeCodexFullAccessRisk: false, maxTurns: 40,
      turnLimitPolicy: "fail", inherit: { settingSources: [] }, mcpServers: {},
      plugins: [], orchestration: { allow: false, maxDepth: 2 }, crossProviderFailover: false,
      deliverTo: null, maxBudgetUsd: null, conductor: false, session: false, persistent: false,
      on: { permissionRequest: "auto" }, providerOptions: {}, resume: null, resumeOnly: false,
      cause: null,
    } as unknown as AgentRecord["spec"],
    ...overrides,
  } as AgentRecord;
}

describe("buildHandoffPackage", () => {
  it("carries the original brief verbatim and the operator note", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-handoffpkg-"));
    const events = new EventLog(dir);
    const record = makeRecord();
    const pkg = buildHandoffPackage({ record, events, effectiveCwd: dir, targetModel: "gpt-5-codex", targetProvider: "codex", note: "hurry" });
    expect(pkg.text).toContain("original brief text");
    expect(pkg.text).toContain("hurry");
    expect(pkg.text).toContain("Re-orient from the repository");
    expect(pkg.text).toContain("What is NOT known");
  });

  it("ranks anchors by frequency then recency, capped per category", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-handoffpkg-"));
    const events = new EventLog(dir);
    const record = makeRecord();
    // "feature/ABC-1" mentioned 3x (most frequent), "feature/XYZ-9" once.
    events.append({ agentId: "agent-1", kind: "message_complete", data: { text: "working on feature/ABC-1" } });
    events.append({ agentId: "agent-1", kind: "tool_call", data: { input: { branch: "feature/ABC-1" } } });
    events.append({ agentId: "agent-1", kind: "message_complete", data: { text: "still on feature/ABC-1, also saw feature/XYZ-9 mentioned" } });

    const pkg = buildHandoffPackage({ record, events, effectiveCwd: dir, targetModel: "gpt-5-codex", targetProvider: "codex" });
    expect(pkg.text).toContain("feature/ABC-1");
    expect(pkg.text).toContain("feature/XYZ-9");
    const idxAbc = pkg.text.indexOf("feature/ABC-1");
    const idxXyz = pkg.text.indexOf("feature/XYZ-9");
    // both appear on the same "Branches:" line; ABC-1 (freq 3) must be listed before XYZ-9 (freq 1)
    expect(idxAbc).toBeLessThan(idxXyz);
  });

  it("never fabricates tool-call history — only narrative text and the anchor index feed the package", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-handoffpkg-"));
    const events = new EventLog(dir);
    const record = makeRecord();
    events.append({ agentId: "agent-1", kind: "tool_call", data: { toolName: "Bash", input: { command: "rm -rf /should-not-appear-as-a-call" } } });
    const pkg = buildHandoffPackage({ record, events, effectiveCwd: dir, targetModel: "gpt-5-codex", targetProvider: "codex" });
    // the raw command text may appear only inside the mechanical anchor extraction (as data),
    // never framed as something the NEW agent itself already did.
    expect(pkg.text).not.toContain("tool_call");
    expect(pkg.text).not.toMatch(/you (already )?ran\b/i);
  });

  it("hard-truncates to the target model's char budget and announces it", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-handoffpkg-"));
    const events = new EventLog(dir);
    const record = makeRecord({ spec: { ...makeRecord().spec, prompt: "x".repeat(500_000) } });
    // a tiny context window forces a tiny budget regardless of prompt size
    const pkg = buildHandoffPackage({ record, events, effectiveCwd: dir, targetModel: "tiny-model", targetProvider: "codex", catalog: { contextWindow: () => 2000, pricing: () => undefined } });
    expect(pkg.text.length).toBeLessThan(10_000);
    expect(pkg.dropped.length).toBeGreaterThan(0);
    expect(pkg.text).toContain("hard-truncated");
  });

  it("describes (never replays) content blocks the original prompt carried", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-handoffpkg-"));
    const events = new EventLog(dir);
    const record = makeRecord({ spec: { ...makeRecord().spec, content: [{ type: "text", text: "hi" }, { type: "image", source: {} }] } as unknown as AgentRecord["spec"] });
    const pkg = buildHandoffPackage({ record, events, effectiveCwd: dir, targetModel: "gpt-5-codex", targetProvider: "codex" });
    expect(pkg.text).toContain("2 content block(s)");
    expect(pkg.text).toContain("NOT carried forward");
  });
});
