import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { TaskEvidence } from "@chimera/protocol";

// Regression coverage for the "review room renders a red [object Object]" bug: an
// unknown-method review.get (older daemon, review.get is a newer rpc than evidence.get)
// must NOT take the whole room down — the diff still renders, and the findings/decision
// rail degrades to a friendly note. Mirrors WorkflowStudio.test.tsx's real-store harness
// (real appStore singleton, rpc/bridge mocked out, bare window shim — this package's
// vitest env is plain node, no jsdom).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => ({})),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { ReviewRoomScreen } from "../src/screens/ReviewRoomScreen";
import styles from "../src/screens/ReviewRoomScreen.module.css";
import { appStore } from "../src/state/store";
import { rpcCall } from "../src/rpc/bridge";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

// Walk the react-test-renderer tree collecting every node whose className
// contains the given CSS-module class (module hashes embed the key, e.g.
// "_filePath_ab12"), so we can assert layout classes are actually applied.
function findByClass(node: TreeNode | string | null, cls: string, out: TreeNode[] = []): TreeNode[] {
  if (node === null || typeof node === "string" || !cls) return out;
  const className = node.props?.className;
  if (typeof className === "string" && className.split(/\s+/).includes(cls)) out.push(node);
  for (const child of node.children ?? []) findByClass(child, cls, out);
  return out;
}

function textOf(node: TreeNode | string | null): string {
  if (node === null) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join("");
}

function renderRoom() {
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(React.createElement(ReviewRoomScreen)); });
  return renderer.toJSON() as TreeNode;
}

const evidence: TaskEvidence = {
  taskId: "t1", queue: "q", state: "done", workflow: null, steps: [], artifacts: [],
  provenance: [{
    worktreeKey: "w", branch: "chimera/w", mainRepo: "/r", agentIds: ["a1"],
    diff: {
      available: true, source: "merged", baseSha: "a", headSha: "b", mergeCommitSha: "c",
      files: [], patchTruncated: false, statText: "", truncated: false, dirty: null,
      patches: [{
        path: "a.ts", oldPath: null, status: "modified", language: "typescript", binary: false, truncated: false,
        hunks: [{ id: "h1", header: "@@ -1,1 +1,1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ kind: "addition", oldLine: null, newLine: 1, text: "hi" }] }],
      }],
    },
  }],
};

afterEach(() => {
  act(() => { appStore.dispatch({ type: "reviewRoomClose" }); });
});

describe("ReviewRoomScreen — degraded review.get (old daemon)", () => {
  it("renders the diff and a friendly note instead of a bare [object Object] error", () => {
    act(() => {
      appStore.dispatch({ type: "reviewRoomOpen", taskId: "t1" });
      appStore.dispatch({
        type: "reviewRoomLoaded",
        taskId: "t1",
        evidence,
        session: null,
        sessionError: "review unavailable — daemon predates review RPCs (restart chimerad)",
      });
    });
    const tree = renderRoom();
    const text = textOf(tree);
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("hi"); // the diff hunk's line content — proof the diff still renders
    expect(text).toContain("review unavailable — daemon predates review RPCs (restart chimerad)");
    expect(text).not.toContain("no findings yet"); // findings/decision rail is degraded away
  });

  it("still renders the full findings/decision rail when review.get succeeds", () => {
    act(() => {
      appStore.dispatch({ type: "reviewRoomOpen", taskId: "t1" });
      appStore.dispatch({
        type: "reviewRoomLoaded",
        taskId: "t1",
        evidence,
        session: { taskId: "t1", findings: [], decision: null, revision: 0, updatedAt: 0 },
        sessionError: null,
      });
    });
    const text = textOf(renderRoom());
    expect(text).toContain("no findings yet");
  });
});

// REVIEW-ROOM-UNBOUND-TASKS: when every provenance entry's diff is unavailable (a plain task
// that landed direct-on-main, an abandoned task, no captured git evidence), there is no selected
// file, so the diff pane must degrade to the per-branch "why" rows (data-review-unavailable) that
// carry the daemon's human-readable reason verbatim — NOT the bare "no patch available" fallback.
const unavailableEvidence: TaskEvidence = {
  taskId: "t1", queue: "q", state: "done", workflow: null, steps: [], artifacts: [],
  provenance: [{
    worktreeKey: "w", branch: "chimera/w", mainRepo: null, agentIds: ["a1"],
    diff: {
      available: false,
      reason: "landed directly on main (isolation:\"none\") — no task branch or worktree was created for this task",
    },
  }],
};

describe("ReviewRoomScreen — unavailable provenance (no patch to review)", () => {
  it("renders the per-branch reason rows when evidence has only unavailable provenance", () => {
    act(() => {
      appStore.dispatch({ type: "reviewRoomOpen", taskId: "t1" });
      appStore.dispatch({
        type: "reviewRoomLoaded",
        taskId: "t1",
        evidence: unavailableEvidence,
        session: { taskId: "t1", findings: [], decision: null, revision: 0, updatedAt: 0 },
        sessionError: null,
      });
    });
    const tree = renderRoom();
    const text = textOf(tree);
    expect(text).toContain("no patch to review");     // the unavailable-block heading
    expect(text).toContain("chimera/w");              // the per-branch label
    expect(text).toContain("landed directly on main"); // the daemon's verbatim reason
    expect(text).not.toContain("no patch available");  // NOT the bare fallback
  });
});

// REVIEW-ROOM-POLISH: GitHub-like density. The changed-files list must keep each
// entry on one line — the path lives in a dedicated .filePath span (nowrap +
// left-truncating ellipsis, see the module CSS) rather than bare text that wraps
// — and diff lines use the compact grid layout (.context/.addition/.deletion),
// with each row's full path reachable via the button title.
describe("ReviewRoomScreen — GitHub-like layout", () => {
  it("renders file rows as single-line entries and diff rows in the compact grid", () => {
    act(() => {
      appStore.dispatch({ type: "reviewRoomOpen", taskId: "t1" });
      appStore.dispatch({
        type: "reviewRoomLoaded",
        taskId: "t1",
        evidence,
        session: { taskId: "t1", findings: [], decision: null, revision: 0, updatedAt: 0 },
        sessionError: null,
      });
    });
    const tree = renderRoom();

    // File list: path rendered in its own truncating span, not as wrapping text.
    const pathNodes = findByClass(tree, styles.filePath);
    expect(pathNodes.length).toBe(1);
    expect(textOf(pathNodes[0])).toContain("a.ts");
    // Full path stays reachable on the button even though the span truncates.
    const titled = (function collect(node: TreeNode | string | null, acc: string[]): string[] {
      if (node && typeof node !== "string") {
        if (node.props?.title === "a.ts") acc.push("a.ts");
        for (const c of node.children ?? []) collect(c, acc);
      }
      return acc;
    })(tree, []);
    expect(titled).toContain("a.ts");

    // Diff body: the single addition line uses the compact grid row class.
    const addRows = findByClass(tree, styles.addition);
    expect(addRows.length).toBe(1);
    // Two gutter <span> columns precede the highlighted code in each row.
    const gutters = (addRows[0].children ?? []).filter((c): c is TreeNode => typeof c !== "string" && c.type === "span");
    expect(gutters.length).toBe(2);
  });
});

// THREADED-FINDINGS: review.finding.add/resolve and the sessionsByTask slice existed since the
// review room shipped, but no UI ever called them — the rail only showed a static count. These
// findings could never be created. Now the rail lists findings with a resolve action, and a
// comment form on the selected file calls review.finding.add.
describe("ReviewRoomScreen — threaded findings", () => {
  it("renders open and resolved findings with a resolve action only on open ones", () => {
    act(() => {
      appStore.dispatch({ type: "reviewRoomOpen", taskId: "t1" });
      appStore.dispatch({
        type: "reviewRoomLoaded",
        taskId: "t1",
        evidence,
        session: {
          taskId: "t1",
          findings: [
            { id: "f1", taskId: "t1", path: "a.ts", hunkId: "h1", parentId: null, authorAgentId: "agent-1", severity: "blocking", body: "fix this", status: "open", createdAt: 0, updatedAt: 0, resolvedBy: null },
            { id: "f2", taskId: "t1", path: "a.ts", hunkId: "h1", parentId: null, authorAgentId: "agent-1", severity: "note", body: "already handled", status: "resolved", createdAt: 0, updatedAt: 0, resolvedBy: "agent-2" },
          ],
          decision: null, revision: 1, updatedAt: 0,
        },
        sessionError: null,
      });
    });
    const tree = renderRoom();
    const text = textOf(tree);
    expect(text).toContain("fix this");
    expect(text).toContain("already handled");
    expect(text).toContain("resolved · agent-2");
    const openRow = tree ? (function find(node: TreeNode | string | null): TreeNode | null {
      if (node === null || typeof node === "string") return null;
      if (node.props?.["data-finding"] === "f1") return node;
      for (const c of node.children ?? []) { const r = find(c); if (r) return r; }
      return null;
    })(tree) : null;
    expect(openRow).not.toBeNull();
    expect(textOf(openRow)).toContain("resolve");
    const resolvedRow = (function find(node: TreeNode | string | null): TreeNode | null {
      if (node === null || typeof node === "string") return null;
      if (node.props?.["data-finding"] === "f2") return node;
      for (const c of node.children ?? []) { const r = find(c); if (r) return r; }
      return null;
    })(tree);
    expect((resolvedRow?.children ?? []).some((c) => typeof c !== "string" && c.type === "button")).toBe(false);
  });

  it("submitting the comment form calls review.finding.add for the selected file", async () => {
    const mockedRpcCall = vi.mocked(rpcCall);
    mockedRpcCall.mockImplementation(async (method: string) => {
      if (method === "review.finding.add") return { id: "f1", taskId: "t1", path: "a.ts", hunkId: "h1", parentId: null, authorAgentId: null, severity: "note", body: "hello", status: "open", createdAt: 0, updatedAt: 0, resolvedBy: null };
      if (method === "review.get") return { taskId: "t1", findings: [], decision: null, revision: 1, updatedAt: 0 };
      return {};
    });
    act(() => {
      appStore.dispatch({ type: "reviewRoomOpen", taskId: "t1" });
      appStore.dispatch({
        type: "reviewRoomLoaded", taskId: "t1", evidence,
        session: { taskId: "t1", findings: [], decision: null, revision: 0, updatedAt: 0 },
        sessionError: null,
      });
    });
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(ReviewRoomScreen)); });
    const textarea = renderer.root.findByType("textarea");
    act(() => { textarea.props.onChange({ target: { value: "hello" } }); });
    const commentButton = renderer.root.findAllByType("button").find((b) => b.children.join("") === "comment");
    expect(commentButton).toBeTruthy();
    await act(async () => { commentButton!.props.onClick(); });
    const addCall = mockedRpcCall.mock.calls.find(([m]) => m === "review.finding.add");
    expect(addCall?.[1]).toMatchObject({ taskId: "t1", path: "a.ts", hunkId: "h1", severity: "note", body: "hello" });
    mockedRpcCall.mockReset();
  });
});

// FINDING-ERROR-SILENT: submitFinding/resolveFindingClick had no .catch at all — a rejected
// review.finding.add/resolve RPC vanished silently (findingBusy reset via .finally, but no
// error shown), same silent-failure class as DECIDE-BUSY-GUARD below one action earlier.
// Also asserts the RPC-ERROR-TEXT extraction: a plain {code,message} rejection (the daemon's
// real shape, never a JS Error) must render the message, not "[object Object]".
describe("ReviewRoomScreen — finding error feedback", () => {
  it("shows the error and clears busy when review.finding.add rejects with a daemon-shaped error", async () => {
    const mockedRpcCall = vi.mocked(rpcCall);
    mockedRpcCall.mockImplementation(async (method: string) => {
      if (method === "review.finding.add") throw { code: "queue_dead", message: "queue is dead" };
      return {};
    });
    act(() => {
      appStore.dispatch({ type: "reviewRoomOpen", taskId: "t1" });
      appStore.dispatch({
        type: "reviewRoomLoaded", taskId: "t1", evidence,
        session: { taskId: "t1", findings: [], decision: null, revision: 0, updatedAt: 0 },
        sessionError: null,
      });
    });
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(ReviewRoomScreen)); });
    const textarea = renderer.root.findByType("textarea");
    act(() => { textarea.props.onChange({ target: { value: "hello" } }); });
    const commentButton = renderer.root.findAllByType("button").find((b) => b.children.join("") === "comment")!;
    await act(async () => { commentButton.props.onClick(); await Promise.resolve(); await Promise.resolve(); });
    const text = textOf(renderer.toJSON() as TreeNode);
    expect(text).toContain("queue is dead");
    expect(text).not.toContain("[object Object]");
    expect(renderer.root.findAllByType("button").find((b) => b.children.join("") === "comment")!.props.disabled).toBe(false);
    mockedRpcCall.mockReset();
  });

  it("shows the error when review.finding.resolve rejects", async () => {
    const mockedRpcCall = vi.mocked(rpcCall);
    mockedRpcCall.mockImplementation(async (method: string) => {
      if (method === "review.finding.resolve") throw { code: "not_found", message: "finding vanished" };
      return {};
    });
    act(() => {
      appStore.dispatch({ type: "reviewRoomOpen", taskId: "t1" });
      appStore.dispatch({
        type: "reviewRoomLoaded", taskId: "t1", evidence,
        session: {
          taskId: "t1",
          findings: [{ id: "f1", taskId: "t1", path: "a.ts", hunkId: "h1", parentId: null, authorAgentId: "agent-1", severity: "note", body: "fix this", status: "open", createdAt: 0, updatedAt: 0, resolvedBy: null }],
          decision: null, revision: 0, updatedAt: 0,
        },
        sessionError: null,
      });
    });
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(ReviewRoomScreen)); });
    const resolveButton = renderer.root.findAllByType("button").find((b) => b.children.join("") === "resolve")!;
    await act(async () => { resolveButton.props.onClick(); await Promise.resolve(); await Promise.resolve(); });
    const text = textOf(renderer.toJSON() as TreeNode);
    expect(text).toContain("finding vanished");
    expect(text).not.toContain("[object Object]");
    mockedRpcCall.mockReset();
  });
});

// DECIDE-BUSY-GUARD: accept/request-changes had neither a double-submit guard nor error
// feedback — a rejected review.decide RPC vanished silently and a fast double-click could
// fire it twice. Mirrors the RULE-FORM-BUSY-GUARD coverage above for the findings form.
describe("ReviewRoomScreen — decide busy guard and error feedback", () => {
  it("disables the decide buttons while in flight and shows the error on rejection", async () => {
    const mockedRpcCall = vi.mocked(rpcCall);
    let resolveDecide!: (v: unknown) => void;
    mockedRpcCall.mockImplementation((method: string) => {
      if (method === "review.decide") return new Promise((resolve, reject) => { resolveDecide = reject; });
      return Promise.resolve({});
    });
    act(() => {
      appStore.dispatch({ type: "reviewRoomOpen", taskId: "t1" });
      appStore.dispatch({
        type: "reviewRoomLoaded", taskId: "t1", evidence,
        session: { taskId: "t1", findings: [], decision: null, revision: 0, updatedAt: 0 },
        sessionError: null,
      });
    });
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(ReviewRoomScreen)); });
    const acceptButton = renderer.root.findAllByType("button").find((b) => b.children.join("") === "accept")!;
    act(() => { acceptButton.props.onClick(); });
    expect(renderer.root.findAllByType("button").find((b) => b.children.join("") === "accept")!.props.disabled).toBe(true);
    await act(async () => { resolveDecide(new Error("daemon unreachable")); await Promise.resolve(); });
    const text = textOf(renderer.toJSON() as TreeNode);
    expect(text).toContain("daemon unreachable");
    expect(renderer.root.findAllByType("button").find((b) => b.children.join("") === "accept")!.props.disabled).toBe(false);
    mockedRpcCall.mockReset();
  });
});

// LIVE DIFF (Review Room watches a running agent): an in_progress task badges as "● live" and,
// with no diff yet, gets the soft "no changes yet" placeholder — never the hard "no patch
// available"/"no patch to review" wording reserved for a task that's actually finished.
const liveEmptyEvidence: TaskEvidence = {
  taskId: "t2", queue: "q", state: "in_progress", workflow: null, steps: [], artifacts: [],
  provenance: [{
    worktreeKey: "w2", branch: "chimera/w2", mainRepo: "/r", agentIds: ["a1"],
    diff: { available: true, source: "live", baseSha: "a", headSha: "a", mergeCommitSha: null, files: [], patches: [], patchTruncated: false, statText: "", truncated: false, dirty: 0 },
  }],
};

describe("ReviewRoomScreen — live in_progress task", () => {
  it("shows the live badge and a soft 'no changes yet' placeholder, not a hard failure", () => {
    act(() => {
      appStore.dispatch({ type: "reviewRoomOpen", taskId: "t2" });
      appStore.dispatch({ type: "reviewRoomLoaded", taskId: "t2", evidence: liveEmptyEvidence, session: null, sessionError: null });
    });
    const text = textOf(renderRoom());
    expect(text).toContain("● live");
    expect(text).toContain("no changes yet");
    expect(text).not.toContain("no patch available");
    expect(text).not.toContain("no patch to review");
  });

  it("does NOT show the live badge for a landed (done) task", () => {
    act(() => {
      appStore.dispatch({ type: "reviewRoomOpen", taskId: "t1" });
      appStore.dispatch({ type: "reviewRoomLoaded", taskId: "t1", evidence, session: null, sessionError: null });
    });
    const text = textOf(renderRoom());
    expect(text).not.toContain("● live");
  });

  it("polls evidence.get on an interval while open on an in_progress task, and stops once it lands", async () => {
    vi.useFakeTimers();
    const mockedRpcCall = vi.mocked(rpcCall);
    const landedEvidence: TaskEvidence = { ...liveEmptyEvidence, state: "done" };
    mockedRpcCall.mockImplementation(async (method: string) => {
      if (method === "evidence.get") return landedEvidence as unknown;
      return {};
    });
    act(() => {
      appStore.dispatch({ type: "reviewRoomOpen", taskId: "t2" });
      appStore.dispatch({ type: "reviewRoomLoaded", taskId: "t2", evidence: liveEmptyEvidence, session: null, sessionError: null });
    });
    renderRoom();
    const callsBefore = mockedRpcCall.mock.calls.filter(([m]) => m === "evidence.get").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(mockedRpcCall.mock.calls.filter(([m]) => m === "evidence.get").length).toBeGreaterThan(callsBefore);
    expect(appStore.getState().reviewRoom.evidenceByTask["t2"]?.state).toBe("done");

    // now landed — a further tick must NOT fire another evidence.get poll.
    const callsAfterLanding = mockedRpcCall.mock.calls.filter(([m]) => m === "evidence.get").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(mockedRpcCall.mock.calls.filter(([m]) => m === "evidence.get").length).toBe(callsAfterLanding);
    vi.useRealTimers();
  });
});
