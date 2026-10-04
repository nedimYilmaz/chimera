import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { NormalizedEvent } from "@chimera/protocol";

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const rpcImpl = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  if (method === "agent.permissionRespond") return {};
  if (method === "agent.answerQuestion") return {};
  if (method === "queue.status") return { spec: { name: "work" }, counts: {}, tasks: [] };
  return [];
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { InboxScreen } from "../src/screens/InboxScreen";
import { appStore } from "../src/state/store";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

// FEATURE-9: appStore is a real module-level singleton (no reset hook), and this
// suite dispatches synthetic daemon events directly into it (bypassing RPC) to seed
// state — same technique the ui-state reducer tests use. Two consequences:
//  1. the empty-state case MUST run first, before any other test's feed() calls —
//     it's the only test that can observe a genuinely empty inbox.
//  2. every id used below is prefixed uniquely per test (s1-, s2-, ...) so leftover
//     state from an earlier test can never collide with a later test's own rows.
let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}): NormalizedEvent => {
  seq += 1;
  return { ts: 1_000_000 + seq, seq, agentId, kind, data };
};
const feed = (e: NormalizedEvent) => act(() => { appStore.dispatch({ type: "event", event: e }); });

let mounted: ReturnType<typeof create> | null = null;

beforeEach(() => {
  rpcImpl.mockClear();
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("InboxScreen", () => {
  it("shows the empty-state hint when nothing is pending (must run before any other test seeds state)", async () => {
    expect(appStore.getState().pendingPermissions).toEqual([]);
    act(() => { mounted = create(React.createElement(InboxScreen)); });
    await flush();
    const hint = mounted!.root.findAll((n) => typeof n.props["children"] === "string" && n.props["children"] === "nothing needs you right now");
    expect(hint.length).toBeGreaterThan(0);
  });

  it("renders permission/question/approval/failed-task rows, grouped blocking-before-waiting", async () => {
    feed(ev("s1-a1", "permission_request", { requestId: "s1-r1", toolName: "Bash", input: { cmd: "ls" }, policy: "tui" }));
    feed(ev("s1-a2", "agent_question", { questionId: "s1-q1", prompt: "pick one", options: [{ id: "x", label: "X" }] }));
    feed(ev("s1-a3", "agent_question", {
      questionId: "s1-q2", prompt: "ship it?", options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
      default: { optionIds: ["reject"] }, gate: "approval",
    }));
    feed(ev("task:s1-t1", "status", { taskId: "s1-t1", queue: "work", state: "failed", error: "boom", subject: "fix it" }));

    act(() => { mounted = create(React.createElement(InboxScreen)); });
    await flush();
    const root = mounted!.root;

    for (const id of ["permission:s1-r1", "question:s1-q1", "approval:s1-q2", "task_failed:s1-t1"]) {
      expect(root.findAll((n) => n.props["data-inbox-row"] === id)).toHaveLength(1);
    }

    // blocking-tier rows (permission/question/approval) all precede the
    // waiting-tier failed-task row in document order.
    const order = root.findAll((n) => typeof n.props["data-inbox-row"] === "string").map((n) => n.props["data-inbox-row"] as string);
    const taskIdx = order.indexOf("task_failed:s1-t1");
    for (const blockingId of ["permission:s1-r1", "question:s1-q1", "approval:s1-q2"]) {
      expect(order.indexOf(blockingId)).toBeLessThan(taskIdx);
    }
  });

  it("Allow on a permission row calls agent.permissionRespond and the row disappears once answered", async () => {
    feed(ev("s2-a1", "permission_request", { requestId: "s2-r1", toolName: "Write", input: { path: "x" }, policy: "tui" }));
    act(() => { mounted = create(React.createElement(InboxScreen)); });
    await flush();

    const row = mounted!.root.find((n) => n.props["data-inbox-row"] === "permission:s2-r1");
    const allowBtn = row.find((n) => n.props["data-inbox-allow"] !== undefined);
    act(() => { allowBtn.props.onClick(); });
    await flush();

    expect(rpcImpl).toHaveBeenCalledWith("agent.permissionRespond", { requestId: "s2-r1", allow: true });
    expect(mounted!.root.findAll((n) => n.props["data-inbox-row"] === "permission:s2-r1")).toHaveLength(0);
  });

  it("an option click on a plain question row calls agent.answerQuestion and the row disappears once answered", async () => {
    feed(ev("s3-a1", "agent_question", { questionId: "s3-q1", prompt: "go?", options: [{ id: "yes", label: "Yes" }] }));
    act(() => { mounted = create(React.createElement(InboxScreen)); });
    await flush();

    const row = mounted!.root.find((n) => n.props["data-inbox-row"] === "question:s3-q1");
    const optBtn = row.find((n) => n.props["data-inbox-option"] === "yes");
    act(() => { optBtn.props.onClick(); });
    await flush();

    expect(rpcImpl).toHaveBeenCalledWith("agent.answerQuestion", { questionId: "s3-q1", answer: { optionIds: ["yes"] } });
    expect(mounted!.root.findAll((n) => n.props["data-inbox-row"] === "question:s3-q1")).toHaveLength(0);
  });

  it("Approve on an approval-gate row sends optionIds:['approve']", async () => {
    feed(ev("s4-a1", "agent_question", {
      questionId: "s4-q1", prompt: "ship it?", options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
      default: { optionIds: ["reject"] }, gate: "approval",
    }));
    act(() => { mounted = create(React.createElement(InboxScreen)); });
    await flush();

    const row = mounted!.root.find((n) => n.props["data-inbox-row"] === "approval:s4-q1");
    const approveBtn = row.find((n) => n.props["data-inbox-approve"] !== undefined);
    act(() => { approveBtn.props.onClick(); });
    await flush();

    expect(rpcImpl).toHaveBeenCalledWith("agent.answerQuestion", { questionId: "s4-q1", answer: { optionIds: ["approve"] } });
  });
});
