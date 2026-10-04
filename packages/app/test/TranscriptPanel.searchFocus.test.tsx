import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// SEARCHBOX-UNCLICKABLE (b/d): opening the transcript search must land focus
// in the input (autoFocus), and closing it must return focus to the toggle
// button that reopens it — not strand it on a node that's about to unmount.
vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => ({})),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  readArtifactSnapshot: vi.fn(async () => ""),
  openArtifactSnapshot: vi.fn(async () => {}),
  openArtifactUrl: vi.fn(async () => {}),
  setDockBadge: vi.fn(async () => {}),
  exportCsv: vi.fn(async () => ""),
  checkpointFilesSince: vi.fn(async () => 0),
}));

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;

import { TranscriptPanel } from "../src/components/TranscriptPanel";
import { appStore } from "../src/state/store";

const focusCalls: string[] = [];
function createNodeMock(el: { props?: Record<string, unknown> }) {
  if (el.props?.["data-transcript-search-toggle"] !== undefined) return { focus: () => focusCalls.push("toggle") };
  if (el.props?.["data-transcript-search"] !== undefined) return { focus: () => focusCalls.push("input") };
  return {};
}

let renderer: ReturnType<typeof create> | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  focusCalls.length = 0;
});

function soloAgent(agentId: string) {
  appStore.dispatch({
    type: "agentRecords",
    records: [{ agentId, state: "done", accountName: "acct", provider: "claude", costUsd: 0, createdAt: 1 }],
  });
  appStore.dispatch({ type: "backfillHistory", agentId, events: [] });
  return appStore.getState().agents[agentId]!;
}

describe("TranscriptPanel search focus (SEARCHBOX-UNCLICKABLE)", () => {
  it("opening search autoFocuses the input; closing returns focus to the toggle", () => {
    const agentId = "search-focus-1";
    const agent = soloAgent(agentId);

    act(() => { renderer = create(React.createElement(TranscriptPanel, { agent }), { createNodeMock }); });

    const toggle = renderer!.root.findByProps({ "data-transcript-search-toggle": true });
    act(() => { (toggle.props["onClick"] as () => void)(); });

    const input = renderer!.root.findByProps({ "data-transcript-search": "" });
    expect(input.props["autoFocus"]).toBe(true);

    const closeButton = renderer!.root.findByProps({ "aria-label": "close search" });
    act(() => { (closeButton.props["onClick"] as () => void)(); });

    expect(focusCalls).toEqual(["toggle"]);
    expect(() => renderer!.root.findByProps({ "data-transcript-search-toggle": true })).not.toThrow();
  });
});
