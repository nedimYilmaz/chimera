import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { AgentView } from "@chimera/ui-state";

// R2 (inline sub-agent/workflow surfacing): the app-side rendering half of the feature — see
// PLAN.md items 1-3. No existing app-level shadow test predates this file (packages/core already
// covers the daemon-side routing).
//
// Same shims/mocks CommandPalette.test.tsx uses for anything that renders AgentList (this
// package's vitest env is plain node, no jsdom/Tauri context) — required for the AgentList render
// tests below; AgentShadowPane's own tests don't need them (it never mounts a live rpc round-trip)
// but sharing one file keeps the mocks in one place.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
}
if (typeof localStorage === "undefined") {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => { backing.set(k, v); },
    removeItem: (k: string) => { backing.delete(k); },
  };
}

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => []),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { AgentList } from "../src/components/AgentList";
import { AgentShadowPane } from "../src/components/AgentShadowPane";
import { appStore } from "../src/state/store";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function flattenText(node: TreeNode | string | null | undefined): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(flattenText).join("");
}

const baseAgent = (over: Partial<AgentView> = {}): AgentView => ({
  agentId: "shadow:parent-1:T1", state: "running", conductor: false, costUsd: 0,
  lastEventTs: 0, transcript: [], tools: [], pendingQuestion: null,
  shadow: true, label: "code-reviewer",
  ...over,
} as AgentView);

function renderPane(agent: AgentView) {
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(React.createElement(AgentShadowPane, { agent })); });
  return flattenText(renderer.toJSON() as TreeNode);
}

describe("AgentShadowPane — rich sub-agent card (R2 item 2)", () => {
  it("renders real usage (tokens/tool uses/duration) instead of placeholders", () => {
    const text = renderPane(baseAgent({
      shadowInfo: { subagentType: "code-reviewer", totalTokens: 1234, toolUses: 3, durationMs: 4500 },
    }));
    expect(text).toContain("1.2k tok");
    expect(text).toContain("3 tool uses");
    expect(text).toMatch(/4\.5s|5s/); // fmtDurationSec formatting — either is a faithful ~4.5s render
  });

  it("renders a subagentType chip stating plainly what kind of sub-agent this is", () => {
    const text = renderPane(baseAgent({ shadowInfo: { subagentType: "code-reviewer" } }));
    expect(text).toContain("code-reviewer");
    expect(text).toContain("native sub-agent");
  });

  it("does NOT render the attached-workflow section for a plain sub-agent (subagentType, no workflowName)", () => {
    const text = renderPane(baseAgent({ shadowInfo: { subagentType: "code-reviewer" } }));
    expect(text).not.toContain("attached workflow");
  });
});

describe("AgentShadowPane — attached-workflow view (R2 item 3)", () => {
  it("renders a distinct attached-workflow section with the workflow name and a live status dot", () => {
    const text = renderPane(baseAgent({
      agentId: "shadow:parent-1:W1", label: "spec",
      shadowInfo: { workflowName: "spec" },
    }));
    expect(text).toContain("⧉");
    expect(text).toContain("spec");
    expect(text).toContain("attached workflow");
  });

  it("does NOT render a subagentType chip for a workflow shadow (workflowName, no subagentType)", () => {
    const text = renderPane(baseAgent({
      agentId: "shadow:parent-1:W1", label: "spec",
      shadowInfo: { workflowName: "spec" },
    }));
    // "attached workflow" appears in the sub-label AND the badge — subagentType never does.
    expect(text).not.toContain("code-reviewer");
  });
});

// SHADOW-WORKFLOW-VISIBILITY: the AgentShadowPane body branch — a workflow shadow mounts the live
// AgentWorkflowInspect inner-agent inspector in place of the static "no transcript of its own" note;
// a native sub-agent (subagentType, no workflowName) keeps that static note. AgentWorkflowInspect's
// own polling degrades to its "read on demand from the run's transcript directory" note until a
// snapshot lands (rpcCall is mocked to a bare array above), which is the marker we assert on.
describe("AgentShadowPane — workflow shadow mounts AgentWorkflowInspect (SHADOW-WORKFLOW-VISIBILITY)", () => {
  it("a workflow shadow renders the AgentWorkflowInspect inspector, not the static 'no transcript' note", () => {
    const text = renderPane(baseAgent({
      agentId: "shadow:parent-1:W1", label: "spec",
      shadowInfo: { workflowName: "spec" },
    }));
    // AgentWorkflowInspect's degrade note (distinct wording from AgentShadowPane's own note).
    expect(text).toContain("read on demand");
    expect(text).not.toContain("the shadow has no transcript of its own");
  });

  it("a native sub-agent (subagentType, no workflowName) keeps the static 'no transcript' note", () => {
    const text = renderPane(baseAgent({ shadowInfo: { subagentType: "code-reviewer" } }));
    expect(text).toContain("the shadow has no transcript of its own");
    expect(text).not.toContain("read on demand");
  });
});

// ---------- AgentList row: real usage on a shadow, not "—"/"$0.00" (R2 item 1) ----------

afterEach(() => {
  act(() => appStore.dispatch({ type: "agentRecords", records: [] }));
});

function renderList() {
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(React.createElement(AgentList)); });
  return flattenText(renderer.toJSON() as TreeNode);
}

describe("AgentList — shadow row cost/tokens (R2 item 1)", () => {
  it("shows the real captured token count and '—' (not '$0.00') for a shadow's cost", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [
          { agentId: "parent-1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, treeId: "parent-1", depth: 0 },
          {
            agentId: "shadow:parent-1:T1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 2,
            treeId: "parent-1", depth: 1, shadow: true, label: "code-reviewer",
            shadowInfo: { subagentType: "code-reviewer", totalTokens: 1234 },
          },
        ],
      });
    });
    const text = renderList();
    // Scope the "$0.00" check to the SHADOW row specifically — the real parent row
    // legitimately shows $0.00 (its own actual costUsd is 0, unrelated to this feature).
    const shadowRow = text.slice(text.indexOf("code-reviewer"));
    expect(shadowRow).toContain("1.2k");
    expect(shadowRow.slice(0, shadowRow.indexOf("1.2k"))).not.toContain("$0.00");
  });

  it("keeps attached workflows out of the fleet list while retaining their inspectable record", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [
          { agentId: "parent-1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, treeId: "parent-1", depth: 0 },
          {
            agentId: "shadow:parent-1:W1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 2,
            treeId: "parent-1", depth: 1, shadow: true, label: "spec",
            shadowInfo: { workflowName: "spec" },
          },
        ],
      });
    });
    const text = renderList();
    expect(text).not.toContain("⧉");
    expect(appStore.getState().agents["shadow:parent-1:W1"]?.shadowInfo?.workflowName).toBe("spec");
  });
});
