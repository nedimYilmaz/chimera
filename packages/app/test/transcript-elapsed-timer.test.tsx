import { describe, expect, it, vi, afterEach } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// ELAPSED-TIMER: the live thinking/streaming counters must read TRUE elapsed from
// the agent's turn-start ts (AgentView.busySince), NOT from component MOUNT time.
// The bug: useElapsedSec anchored on useRef(Date.now()) = mount, so opening a
// transcript for an agent that had been thinking 30s reset the counter to ~0.
// These tests pin Date.now to (turnStart + N) AT MOUNT — so a mount-anchored
// counter would read 0 — and assert the rendered line shows N, proving the anchor
// is busySince and mount time is irrelevant.

// TranscriptSegment transitively reaches the Tauri rpc/bridge (import-time
// listen()/invoke() side effects); stub it so this test only exercises rendering.
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

// The shared keyboard hook touches window.addEventListener; the package's vitest
// config runs a bare node env (no jsdom), so stub just what that effect needs.
// useTick's spinner drives off window.setInterval; elapsed itself is computed at
// RENDER (Date.now − busySince), so the interval need only exist, not fire.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
}

import { TranscriptSegment } from "../src/components/TranscriptSegment";
import { emptyAgent, type AgentView } from "@chimera/ui-state";

const TURN_START = 1_700_000_000_000; // fixed epoch-ms turn-start (busySince)

function busyAgent(over: Partial<AgentView> = {}): AgentView {
  return { ...emptyAgent("a1"), state: "running", busy: true, busySince: TURN_START, ...over };
}

/** All string descendants of the first node matching `pred`, concatenated. */
function textUnder(renderer: ReturnType<typeof create>, pred: (n: { props: Record<string, unknown> }) => boolean): string {
  const node = renderer.root.find(pred as never);
  const out: string[] = [];
  const walk = (children: unknown[]) => {
    for (const c of children) {
      if (typeof c === "string" || typeof c === "number") out.push(String(c));
      else if (c && typeof c === "object" && "children" in (c as Record<string, unknown>)) {
        walk((c as { children: unknown[] }).children);
      }
    }
  };
  walk(node.children as unknown[]);
  return out.join("");
}

function renderAt(now: number, agent: AgentView): ReturnType<typeof create> {
  const spy = vi.spyOn(Date, "now").mockReturnValue(now);
  let renderer!: ReturnType<typeof create>;
  try {
    act(() => {
      renderer = create(React.createElement(TranscriptSegment, { agent, canInterrupt: false, isLive: true }));
    });
  } finally {
    spy.mockRestore();
  }
  return renderer;
}

afterEach(() => vi.restoreAllMocks());

describe("TranscriptSegment elapsed timer anchors on busySince, not mount", () => {
  it("renders no named card for empty completed or streaming turns, then shows the first text delta", () => {
    const agent = busyAgent({ transcript: [
      { role: "assistant", text: "", streaming: false },
      { role: "assistant", text: " \n", streaming: true },
    ] });
    const renderer = renderAt(TURN_START + 30_000, agent);
    expect(renderer.root.findAll(n => n.props["data-msg-key"] !== undefined)).toHaveLength(0);
    expect(textUnder(renderer, n => n.props["data-thinking"] === true)).toContain("30s");
    act(() => renderer.update(React.createElement(TranscriptSegment, { agent: { ...agent, transcript: [agent.transcript[0]!, { role: "assistant", text: "Now visible", streaming: true }] }, canInterrupt: false, isLive: true })));
    expect(renderer.root.findAll(n => n.props["data-msg-key"] !== undefined)).toHaveLength(1);
    expect(renderer.root.findAll(n => n.props["data-thinking"] === true)).toHaveLength(0);
    act(() => renderer.unmount());
  });
  it("thinking line shows TRUE elapsed (30s) for an agent busy since T rendered at T+30s — not 0", () => {
    // Empty transcript + busy + isLive => showThinking (no streaming assistant tail).
    const renderer = renderAt(TURN_START + 30_000, busyAgent({ transcript: [] }));
    const line = textUnder(renderer, (n) => n.props["data-thinking"] === true);
    expect(line).toContain("thinking…");
    // A mount-anchored counter (the bug) would read "0s" here; busySince gives 30s.
    expect(line).toContain("30s");
  });

  it("streaming line shows TRUE elapsed (42s) for an agent streaming since T rendered at T+42s", () => {
    // A streaming assistant tail => StreamingLine (and suppresses the thinking line).
    const agent = busyAgent({ transcript: [{ role: "assistant", text: "partial", streaming: true }] });
    const renderer = renderAt(TURN_START + 42_000, agent);
    const line = textUnder(renderer, (n) => typeof n.props["className"] === "string" && /streamingLine/.test(n.props["className"] as string));
    expect(line).toContain("streaming");
    expect(line).toContain("42s");
  });

  it("falls back to mount time (0s) when busySince is absent — a brand-new turn whose first event ts has not landed", () => {
    const renderer = renderAt(TURN_START + 30_000, busyAgent({ transcript: [], busySince: undefined }));
    const line = textUnder(renderer, (n) => n.props["data-thinking"] === true);
    // Mount === now here (Date.now pinned), so mount-anchored fallback reads 0s.
    expect(line).toContain("0s");
  });
});
