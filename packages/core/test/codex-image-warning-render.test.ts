import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { normalizeCodexEvent } from "@chimera/core/backends/codex";
import { initialState, reduce } from "../../ui-state/src/index.js";
import { TranscriptSegment } from "../../app/src/components/TranscriptSegment.js";

// Exercise the existing system-row renderer without launching the desktop app.
vi.mock("../../app/src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => ({})), subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}), onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"), readArtifactSnapshot: vi.fn(async () => ""),
  openArtifactSnapshot: vi.fn(async () => {}), openArtifactUrl: vi.fn(async () => {}),
  setDockBadge: vi.fn(async () => {}), exportCsv: vi.fn(async () => ""), checkpointFilesSince: vi.fn(async () => 0),
}));
const appRequire = createRequire(new URL("../../app/package.json", import.meta.url));
const React = appRequire("react");
const { act, create } = appRequire("react-test-renderer");
vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, setInterval: () => 0, clearInterval() {} });
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

describe("Codex native image omission visibility", () => {
  it.each(["scan-limit", "record-too-large", "ambiguous-turn"])("renders %s visibly outside the tool strip", reason => {
    const row = normalizeCodexEvent({ type: "image_output.warning", reason });
    if (!row || Array.isArray(row)) throw new Error("Expected one system warning");
    const state = reduce(initialState, { type: "event", event: { ...row, agentId: "owner", seq: 1, ts: 1 } });
    let rendered: any;
    try {
      act(() => { rendered = create(React.createElement(TranscriptSegment, { agent: state.agents.owner, events: [], canInterrupt: false, isLive: false })); });
      const blocks = rendered.root.findAll((node: any) => node.props["data-block"] !== undefined);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].children).toEqual([`Codex native image output omitted (${reason}).`]);
      expect(rendered.root.findAll((node: any) => node.props["data-tool-strip"] !== undefined)).toHaveLength(0);
    } finally { if (rendered) act(() => rendered.unmount()); }
  });
});
