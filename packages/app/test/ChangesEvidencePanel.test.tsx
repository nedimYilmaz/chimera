import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { TaskEvidence } from "@chimera/protocol";
import { ChangesEvidencePanel } from "../src/components/ChangesEvidencePanel";

// FEATURE-10 (Changes & Evidence Review) — no bridge.ts mock needed here (unlike
// TaskInspector.test.tsx): this component never imports ArtifactChip/rpc-bridge.

function flattenText(node: { children?: unknown }): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === "string") { parts.push(n); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n && typeof n === "object" && "children" in n) walk((n as { children?: unknown }).children);
  };
  walk(node);
  return parts.join("");
}

function render(props: { evidence: TaskEvidence | null; loading: boolean; error: string | null }) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(ChangesEvidencePanel, props));
  });
  return renderer;
}

const evidence = (over: Partial<TaskEvidence> = {}): TaskEvidence => ({
  taskId: "t1", queue: "work", state: "done", workflow: null, steps: [], artifacts: [], provenance: [],
  ...over,
});

describe("ChangesEvidencePanel", () => {
  it("renders loading… while loading", () => {
    const r = render({ evidence: null, loading: true, error: null });
    expect(flattenText(r.root.findByProps({ "data-evidence-panel": true }))).toContain("loading…");
  });

  it("renders the error text instead of steps/provenance when the fetch failed", () => {
    const r = render({ evidence: null, loading: false, error: "network down" });
    expect(flattenText(r.root.findByProps({ "data-evidence-panel": true }))).toContain("network down");
  });

  it("renders a passed step with its glyph and a failed step with its glyph + reason", () => {
    const data = evidence({
      steps: [
        { stepIndex: 0, stepId: "s0", title: "build", agentId: "a1", startedAt: 0, endedAt: 1000, outcome: "passed", reason: null, handoffSummary: null, gate: null },
        { stepIndex: 1, stepId: "s1", title: "test", agentId: "a1", startedAt: 1000, endedAt: 2000, outcome: "failed", reason: "exit 1", handoffSummary: null, gate: null },
      ],
    });
    const r = render({ evidence: data, loading: false, error: null });
    const passed = r.root.findByProps({ "data-evidence-step": "s0" });
    const failed = r.root.findByProps({ "data-evidence-step": "s1" });
    expect(flattenText(passed)).toContain("●");
    expect(flattenText(failed)).toContain("✗");
    expect(flattenText(failed)).toContain("exit 1");
  });

  it("renders a provenance entry's file list with status glyphs and ±counts", () => {
    const data = evidence({
      provenance: [{
        worktreeKey: "agent-1", branch: "chimera/agent-1", mainRepo: "/repo", agentIds: ["agent-1"],
        diff: {
          available: true, source: "live", baseSha: "a", headSha: "b", mergeCommitSha: null,
          files: [{ path: "src/a.ts", status: "added", insertions: 5, deletions: 0 }],
          statText: "", truncated: false, dirty: 0,
        },
      }],
    });
    const r = render({ evidence: data, loading: false, error: null });
    const fileRow = r.root.findByProps({ "data-evidence-file": "src/a.ts" });
    expect(flattenText(fileRow)).toContain("src/a.ts");
    expect(flattenText(fileRow)).toContain("+5");
  });

  it("renders the reason text (no file list) for an unavailable diff", () => {
    const data = evidence({
      provenance: [{
        worktreeKey: "agent-1", branch: "chimera/agent-1", mainRepo: null, agentIds: [],
        diff: { available: false, reason: "no live worktree and no merge commit found" },
      }],
    });
    const r = render({ evidence: data, loading: false, error: null });
    const entry = r.root.findByProps({ "data-evidence-provenance": "agent-1" });
    expect(flattenText(entry)).toContain("no diff available: no live worktree and no merge commit found");
    expect(() => r.root.findByProps({ "data-evidence-file": "src/a.ts" })).toThrow();
  });

  it("renders a hint when there is no provenance at all", () => {
    const r = render({ evidence: evidence(), loading: false, error: null });
    expect(flattenText(r.root.findByProps({ "data-evidence-panel": true }))).toContain("no provenance available");
  });
});
