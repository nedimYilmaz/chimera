import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// OWN-TURN-VISIBILITY — your own messages used to be the QUIETER of the two roles: the agent's
// header was --accent while yours was --muted, and both gutters were a similar dim blue-grey. In a
// long transcript the one thing you scroll back hunting for was the least visible thing on screen.
//
// The emphasis is carried by a `data-own` marker (the stylesheet hangs the tint, the wider rule and
// the coloured header off it). What is worth testing is not the colour but WHICH turns get it:
// role:"user" is not the same thing as "the human", because delivered mail from another agent and
// pushed signals render in that same lane. Marking those as yours would recreate the exact
// confusion this fixes, one level down.

const tailByAgent = vi.hoisted(() => new Map<string, unknown[]>());
vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "agent.tail" && params && typeof params["agentId"] === "string") {
      return tailByAgent.get(params["agentId"] as string) ?? [];
    }
    return {};
  }),
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

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof window === "undefined") {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    addEventListener: () => {}, removeEventListener: () => {},
    setInterval: () => 0, clearInterval: () => {},
  };
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;

import { TranscriptPanel } from "../src/components/TranscriptPanel";
import { appStore } from "../src/state/store";
import type { AgentView, TranscriptItem } from "@chimera/ui-state";

/** A real AgentView from the store, with a hand-built transcript spliced in. */
function agentWith(agentId: string, transcript: TranscriptItem[]): AgentView {
  appStore.dispatch({
    type: "agentRecords",
    records: [{ agentId, state: "running", accountName: "a", provider: "claude", costUsd: 0, createdAt: 1 }],
  } as never);
  return { ...appStore.getState().agents[agentId]!, transcript };
}

/** Every rendered turn's `data-own`, in transcript order — undefined where absent. */
function ownFlags(agent: AgentView): unknown[] {
  let r!: ReturnType<typeof create>;
  act(() => { r = create(React.createElement(TranscriptPanel, { agent })); });
  const out = r.root
    .findAll((n) => typeof n.props === "object" && n.props !== null && "data-bkey" in (n.props as object), { deep: true })
    .map((n) => (n.props as Record<string, unknown>)["data-own"]);
  act(() => r.unmount());
  return out;
}

describe("the human's own turn is marked apart", () => {
  it("marks a turn you sent", () => {
    const flags = ownFlags(agentWith("own-plain", [{ role: "user", text: "do the thing" }]));
    expect(flags).toEqual([true]);
  });

  it("does NOT mark a turn DELIVERED from another agent, though it renders in the same lane", () => {
    // This is the whole point of the gate. `from` set = it arrived from someone else.
    const flags = ownFlags(agentWith("own-delivered", [{ role: "user", text: "status?", from: "scout-1" }]));
    expect(flags).toEqual([undefined]);
  });

  it("does NOT mark a pushed signal", () => {
    const flags = ownFlags(agentWith("own-signal", [
      { role: "user", text: "[signal:deploy] green", from: "chimera" },
    ]));
    expect(flags).toEqual([undefined]);
  });

  it("does not mark the agent's own output", () => {
    const flags = ownFlags(agentWith("own-asst", [{ role: "assistant", text: "done", streaming: false }]));
    expect(flags).toEqual([undefined]);
  });

  it("marks only YOUR turns in a mixed thread", () => {
    const flags = ownFlags(agentWith("own-mixed", [
      { role: "user", text: "first" },
      { role: "assistant", text: "working", streaming: false },
      { role: "user", text: "from a peer", from: "peer" },
      { role: "user", text: "second" },
    ]));
    expect(flags).toEqual([true, undefined, undefined, true]);
  });

  it("still marks a FORCED send — bypassing the busy queue does not make it someone else's", () => {
    const flags = ownFlags(agentWith("own-forced", [{ role: "user", text: "now", forced: true }]));
    expect(flags).toEqual([true]);
  });
});

// OWN-TURN-MARKDOWN — your own turn was the last plain-text path in the transcript. An agent's
// turn and delivered mail from another agent both render through MessageBody, so the identical
// text formatted for everyone except you: a `backtick` you typed came back as three literal
// characters. What is asserted here is that it goes through the SAME pipeline, not how any
// particular block looks (markdown.test.ts owns that).

/** The rendered tree of an agent's transcript, as a JSON string. */
function renderedTree(agent: AgentView): string {
  let r!: ReturnType<typeof create>;
  act(() => { r = create(React.createElement(TranscriptPanel, { agent })); });
  const json = JSON.stringify(r.toJSON());
  act(() => r.unmount());
  return json;
}

describe("your own turn is formatted like everyone else's", () => {
  it("renders inline code instead of printing the backticks", () => {
    const tree = renderedTree(agentWith("md-code", [{ role: "user", text: "run `npm test` please" }]));
    expect(tree).toContain("npm test");
    expect(tree).not.toContain("`npm test`");
  });

  it("renders a fenced code block", () => {
    const tree = renderedTree(agentWith("md-fence", [
      { role: "user", text: "here:\n```sh\nls -la\n```" },
    ]));
    expect(tree).toContain("ls -la");
    expect(tree).not.toContain("```");
  });

  it("renders a heading and a list", () => {
    const tree = renderedTree(agentWith("md-blocks", [
      { role: "user", text: "## Plan\n- one\n- two" },
    ]));
    expect(tree).toContain("Plan");
    expect(tree).not.toContain("## Plan");
    expect(tree).toContain("one");
  });

  it("keeps plain text plain — this is not a licence to reformat what you typed", () => {
    const tree = renderedTree(agentWith("md-plain", [{ role: "user", text: "okay eline saglik" }]));
    expect(tree).toContain("okay eline saglik");
  });

  it("preserves a hard line break, the way a typed message expects", () => {
    // Markdown would normally fold a single newline into a space; the renderer's pre-wrap keeps it,
    // which matters because people compose multi-line messages in the box and expect them back.
    // Compared through JSON.stringify on BOTH sides — the tree is serialised, so the newline is an
    // escape sequence in it, not a literal one.
    const tree = renderedTree(agentWith("md-nl", [{ role: "user", text: "first line\nsecond line" }]));
    expect(tree).toContain(JSON.stringify("first line\nsecond line").slice(1, -1));
  });
});
