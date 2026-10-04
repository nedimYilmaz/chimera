import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// TRANSCRIPT-SCROLL-JUMP — render-level proof (not just the pure blockKeyOf.
// test.ts unit tests) that a live append through the REAL reducer/store
// pipeline (a) leaves earlier blocks' data-bkey unchanged (the same DOM node
// survives, which is what lets the native CSS scroll-anchor and the
// content-visibility height cache keep working) and (b) that
// useTranscriptScroll's follow-vs-hold logic is untouched by the key fix: a
// reader scrolled up stays put, near-bottom still auto-follows.
//
// Harness follows TopBar.overflow.test.tsx's ResizeObserver stub +
// TranscriptPanel.test.tsx's rpc/bridge mock; createNodeMock gives the
// `data-transcript-body` scroller a persistent, mutable fake DOM node (scroll
// geometry the test drives directly) — every other ref resolves to `{}` (or
// null via the default), matching how HostToolsCard/FlowPane's own scroll
// tests do it.

// captured so tests can fire the content-resize pin observer directly —
// FakeResizeObserver.instances is reset per-test (see beforeEach below).
let roInstances: FakeResizeObserver[] = [];
class FakeResizeObserver {
  cb: () => void;
  observedTargets: unknown[] = [];
  constructor(cb: () => void) {
    this.cb = cb;
    roInstances.push(this);
  }
  observe(target: unknown): void { this.observedTargets.push(target); }
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof window === "undefined") {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    // ThinkingLine/StreamingLine's useTick spinner touches these unconditionally
    // once a turn is busy/streaming — no real ticking needed for this suite.
    setInterval: () => 0,
    clearInterval: () => {},
  };
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;

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

import { TranscriptPanel } from "../src/components/TranscriptPanel";
import { appStore } from "../src/state/store";

// `lastSeq` (the tail-replay-vs-live-subscribe dedupe guard) is a GLOBAL field
// on UiState, not per-agent — a `type:"event"` dispatch with a seq the shared
// appStore singleton has already seen (from an EARLIER test in this file,
// any agentId) is silently dropped. A single ever-increasing counter across
// the whole file avoids that; backfillHistory/prependHistory replay into
// their OWN scratch state so they don't need to share this counter, but using
// it everywhere is simplest and still correct.
let seqCounter = 0;
function ev(kind: string, agentId: string, ts: number, data: Record<string, unknown> = {}) {
  seqCounter += 1;
  return { seq: seqCounter, ts, engineId: "local", agentId, kind, data };
}

// prependHistory's OWN freshness gate is separate: it keeps only events whose
// seq is strictly below the target agent's `historyMinSeq` (the low-water
// mark backfillHistory set) — a PER-AGENT field, unrelated to the global
// lastSeq counter `ev()` feeds. A literal small seq (never touched by the
// auto-counter, which only ever grows) trivially satisfies that for a
// simulated "older page".
function evOlderThan(seq: number, kind: string, agentId: string, ts: number, data: Record<string, unknown> = {}) {
  return { seq, ts, engineId: "local", agentId, kind, data };
}

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };
function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) { if (typeof c !== "string") findAll(c, pred, out); }
  return out;
}
function textOf(node: TreeNode): string {
  const parts: string[] = [];
  for (const c of node.children ?? []) parts.push(typeof c === "string" ? c : textOf(c));
  return parts.join("");
}

// A persistent, mutable fake scroller — the SAME object every render as long
// as the real `data-transcript-body` div is never unmounted (which is
// exactly the invariant under test).
const bodyInnerEl = {};
const bodyEl = {
  scrollTop: 0,
  scrollHeight: 0,
  clientHeight: 0,
  firstElementChild: bodyInnerEl,
  addEventListener() {},
  removeEventListener() {},
};
function resetBodyEl(clientHeight: number, scrollHeight: number, scrollTop: number): void {
  bodyEl.clientHeight = clientHeight;
  bodyEl.scrollHeight = scrollHeight;
  bodyEl.scrollTop = scrollTop;
}
const createNodeMock = (element: { props?: Record<string, unknown> }) =>
  element.props?.["data-transcript-body"] !== undefined ? bodyEl : {};

let renderer: ReturnType<typeof create> | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  resetBodyEl(0, 0, 0);
  roInstances = [];
});

function contentResizeObserver(): FakeResizeObserver {
  const hit = roInstances.find((ro) => ro.observedTargets.includes(bodyInnerEl));
  if (!hit) throw new Error("content ResizeObserver was never registered");
  return hit;
}

function soloAgent(agentId: string): void {
  appStore.dispatch({
    type: "agentRecords",
    records: [{ agentId, state: "running", accountName: "acct", provider: "claude", costUsd: 0, createdAt: 1 }],
  });
}

function mountAgent(agentId: string): void {
  act(() => {
    renderer = create(
      React.createElement(TranscriptPanel, { agent: appStore.getState().agents[agentId] }),
      { createNodeMock },
    );
  });
}

function rerenderAgent(agentId: string): void {
  act(() => {
    renderer!.update(React.createElement(TranscriptPanel, { agent: appStore.getState().agents[agentId] }));
  });
}

function bkeyFor(text: string): string | undefined {
  const tree = renderer!.toJSON() as TreeNode;
  const hit = findAll(tree, (n) => typeof n.props["data-bkey"] === "string").find((b) => textOf(b).includes(text));
  return hit?.props["data-bkey"] as string | undefined;
}

function scrollBody(): { props: Record<string, unknown> } {
  return renderer!.root.findByProps({ "data-transcript-body": true }) as unknown as { props: Record<string, unknown> };
}

describe("TranscriptPanel — TRANSCRIPT-SCROLL-JUMP: block keys through the real reducer pipeline", () => {
  it("a live streamed turn (message_delta -> message_complete) leaves the EARLIER turn's data-bkey unchanged", () => {
    const agentId = "scroll-append-1";
    soloAgent(agentId);
    act(() => {
      appStore.dispatch({
        type: "backfillHistory",
        agentId,
        events: [
          ev("message_delta", agentId, 10, { text: "turn one" }),
          ev("message_complete", agentId, 10, { text: "turn one" }),
        ] as never,
      });
    });

    mountAgent(agentId);
    const keyBefore = bkeyFor("turn one");
    expect(keyBefore).toBeDefined();

    // A brand new turn streams in — the EXACT trigger the operator reported
    // ("the conversation suddenly jumps upward" when output starts).
    act(() => {
      appStore.dispatch({ type: "event", event: ev("message_delta", agentId, 20, { text: "turn " }) as never, stampTs: true });
      appStore.dispatch({ type: "event", event: ev("message_delta", agentId, 21, { text: "turn two" }) as never, stampTs: true });
    });
    rerenderAgent(agentId);
    expect(bkeyFor("turn one")).toBe(keyBefore); // unchanged mid-stream

    act(() => {
      appStore.dispatch({ type: "event", event: ev("message_complete", agentId, 22, { text: "turn two" }) as never, stampTs: true });
    });
    rerenderAgent(agentId);

    expect(bkeyFor("turn one")).toBe(keyBefore); // still unchanged after the turn finalizes
    expect(bkeyFor("turn two")).toBeDefined();
    expect(bkeyFor("turn two")).not.toBe(keyBefore);
  });

  it("prependHistory (older rows) leaves the LIVE turn's data-bkey unchanged, even after a prior live append", () => {
    const agentId = "scroll-prepend-1";
    soloAgent(agentId);
    act(() => {
      appStore.dispatch({
        type: "backfillHistory",
        agentId,
        events: [
          ev("message_delta", agentId, 100, { text: "recent turn" }),
          ev("message_complete", agentId, 100, { text: "recent turn" }),
        ] as never,
      });
    });
    mountAgent(agentId);

    // a live append first (the append-stability half of the invariant)...
    act(() => {
      appStore.dispatch({ type: "event", event: ev("message_delta", agentId, 110, { text: "newest turn" }) as never, stampTs: true });
      appStore.dispatch({ type: "event", event: ev("message_complete", agentId, 110, { text: "newest turn" }) as never, stampTs: true });
    });
    rerenderAgent(agentId);
    const recentKey = bkeyFor("recent turn");
    const newestKey = bkeyFor("newest turn");
    expect(recentKey).toBeDefined();
    expect(newestKey).toBeDefined();

    // ...then older history prepends to the front (the background older-page walk).
    // seq 1/2 are guaranteed below historyMinSeq (the min seq of the "recent
    // turn" backfill above, whatever the shared auto-counter gave it).
    act(() => {
      appStore.dispatch({
        type: "prependHistory",
        agentId,
        events: [
          evOlderThan(1, "message_delta", agentId, 50, { text: "ancient turn" }),
          evOlderThan(2, "message_complete", agentId, 50, { text: "ancient turn" }),
        ] as never,
      });
    });
    rerenderAgent(agentId);

    // neither previously-mounted block's key moved — the prepend bug
    // TRANSCRIPT-TAIL-FIRST fixed stays fixed.
    expect(bkeyFor("recent turn")).toBe(recentKey);
    expect(bkeyFor("newest turn")).toBe(newestKey);
    expect(bkeyFor("ancient turn")).toBeDefined();
    expect(new Set([bkeyFor("ancient turn"), recentKey, newestKey]).size).toBe(3); // all disjoint
  });
});

describe("TranscriptPanel — scroll follow-vs-hold across a live append (useTranscriptScroll unaffected by the key fix)", () => {
  it("scrolled up reading history: an append does NOT force-scroll the pane to the bottom", () => {
    const agentId = "scroll-hold-1";
    soloAgent(agentId);
    resetBodyEl(200, 1000, 0); // clientHeight=200, scrollHeight=1000 (mount still auto-pins to the bottom once)
    act(() => {
      appStore.dispatch({
        type: "backfillHistory",
        agentId,
        events: [
          ev("message_delta", agentId, 10, { text: "turn one" }),
          ev("message_complete", agentId, 10, { text: "turn one" }),
        ] as never,
      });
    });
    mountAgent(agentId);
    expect(bodyEl.scrollTop).toBe(1000); // opening a transcript pins to the bottom once, as before

    // the reader now scrolls up, away from the bottom (a real scroll event
    // moves scrollTop first; onScroll just reacts to the new position).
    bodyEl.scrollTop = 0;
    act(() => { (scrollBody().props["onScroll"] as () => void)(); });
    expect(bodyEl.scrollTop).toBe(0);

    // new output streams in — scrollHeight would grow in a real DOM.
    bodyEl.scrollHeight = 1200;
    act(() => {
      appStore.dispatch({ type: "event", event: ev("message_delta", agentId, 20, { text: "turn two" }) as never, stampTs: true });
    });
    rerenderAgent(agentId);

    expect(bodyEl.scrollTop).toBe(0); // stayed put — no forced jump to the bottom
  });

  it("near the bottom: an append still auto-follows to the new bottom", () => {
    const agentId = "scroll-follow-1";
    soloAgent(agentId);
    resetBodyEl(200, 1000, 0);
    act(() => {
      appStore.dispatch({
        type: "backfillHistory",
        agentId,
        events: [
          ev("message_delta", agentId, 10, { text: "turn one" }),
          ev("message_complete", agentId, 10, { text: "turn one" }),
        ] as never,
      });
    });
    mountAgent(agentId);

    // still within NEAR_BOTTOM_PX of the bottom (gap = 1000-780-200 = 20 <= 32).
    bodyEl.scrollTop = 780;
    act(() => { (scrollBody().props["onScroll"] as () => void)(); });

    bodyEl.scrollHeight = 1300; // new content grew the scroll height
    act(() => {
      appStore.dispatch({ type: "event", event: ev("message_delta", agentId, 20, { text: "turn two" }) as never, stampTs: true });
    });
    rerenderAgent(agentId);

    expect(bodyEl.scrollTop).toBe(1300); // followed the tail to the new bottom
  });
});

// TRANSCRIPT-OPEN-NOT-AT-BOTTOM — content-visibility: auto reserves only a
// 48px placeholder per not-yet-rendered block until it paints for real, so
// the initial `scrollTop = scrollHeight` pin lands short of the TRUE bottom.
// A ResizeObserver on the content element (not the scroll container, which
// never resizes) re-pins as those placeholders resolve to real height.
describe("TranscriptPanel — re-pin to the true bottom as content-visibility placeholders resolve", () => {
  it("initial pin lands at the true bottom once geometry settles (content grows AFTER mount, e.g. placeholders resolving)", () => {
    const agentId = "scroll-repin-1";
    soloAgent(agentId);
    resetBodyEl(200, 1000, 0); // mount-time pin: scrollHeight=1000 (mostly 48px placeholders)
    act(() => {
      appStore.dispatch({
        type: "backfillHistory",
        agentId,
        events: [
          ev("message_delta", agentId, 10, { text: "turn one" }),
          ev("message_complete", agentId, 10, { text: "turn one" }),
        ] as never,
      });
    });
    mountAgent(agentId);
    expect(bodyEl.scrollTop).toBe(1000); // the naive first pin — short of the true bottom

    const ro = contentResizeObserver();
    // placeholders resolve to real height across a couple of resize ticks
    bodyEl.scrollHeight = 1800;
    act(() => ro.cb());
    expect(bodyEl.scrollTop).toBe(1800);

    bodyEl.scrollHeight = 2400; // true bottom
    act(() => ro.cb());
    expect(bodyEl.scrollTop).toBe(2400);

    // geometry has settled — one more tick with no height change is a no-op
    act(() => ro.cb());
    expect(bodyEl.scrollTop).toBe(2400);
  });

  it("re-pinning stops the moment the operator scrolls away from the bottom", () => {
    const agentId = "scroll-repin-2";
    soloAgent(agentId);
    resetBodyEl(200, 1000, 0);
    act(() => {
      appStore.dispatch({
        type: "backfillHistory",
        agentId,
        events: [ev("message_delta", agentId, 10, { text: "turn one" })] as never,
      });
    });
    mountAgent(agentId);
    expect(bodyEl.scrollTop).toBe(1000);

    // operator scrolls up, away from the bottom, mid-settle
    bodyEl.scrollTop = 50;
    act(() => { (scrollBody().props["onScroll"] as () => void)(); });

    const ro = contentResizeObserver();
    bodyEl.scrollHeight = 2400; // more placeholders resolve
    act(() => ro.cb());

    expect(bodyEl.scrollTop).toBe(50); // never yanked back down
  });

  it("re-pinning is bounded — stops after MAX_REPINS even if geometry keeps changing", () => {
    const agentId = "scroll-repin-3";
    soloAgent(agentId);
    resetBodyEl(200, 1000, 0);
    act(() => {
      appStore.dispatch({
        type: "backfillHistory",
        agentId,
        events: [ev("message_delta", agentId, 10, { text: "turn one" })] as never,
      });
    });
    mountAgent(agentId);

    const ro = contentResizeObserver();
    // simulate pathological, never-settling growth well past MAX_REPINS (60)
    for (let i = 0; i < 100; i++) {
      bodyEl.scrollHeight += 10;
      act(() => ro.cb());
    }
    const stoppedAt = bodyEl.scrollTop;
    // one more tick with growth must be a no-op — the budget is exhausted
    bodyEl.scrollHeight += 10;
    act(() => ro.cb());
    expect(bodyEl.scrollTop).toBe(stoppedAt);
  });

  it("a prepend while scrolled up still anchors correctly (unaffected by the content-resize observer)", () => {
    const agentId = "scroll-repin-4";
    soloAgent(agentId);
    resetBodyEl(200, 1000, 0);
    act(() => {
      appStore.dispatch({
        type: "backfillHistory",
        agentId,
        events: [
          ev("message_delta", agentId, 100, { text: "recent turn" }),
          ev("message_complete", agentId, 100, { text: "recent turn" }),
        ] as never,
      });
    });
    mountAgent(agentId);

    bodyEl.scrollTop = 300; // scrolled up, away from the bottom
    act(() => { (scrollBody().props["onScroll"] as () => void)(); });

    bodyEl.scrollHeight = 1400; // the prepend adds height above the viewport
    act(() => {
      appStore.dispatch({
        type: "prependHistory",
        agentId,
        events: [
          evOlderThan(1, "message_delta", agentId, 50, { text: "ancient turn" }),
          evOlderThan(2, "message_complete", agentId, 50, { text: "ancient turn" }),
        ] as never,
      });
    });
    rerenderAgent(agentId);

    // anchored: scrollTop shifted by exactly the height the prepend added (400)
    expect(bodyEl.scrollTop).toBe(700);
  });

  it("live append while pinned at the bottom still follows, and the content-resize observer keeps working afterward", () => {
    const agentId = "scroll-repin-5";
    soloAgent(agentId);
    resetBodyEl(200, 1000, 0);
    act(() => {
      appStore.dispatch({
        type: "backfillHistory",
        agentId,
        events: [ev("message_delta", agentId, 10, { text: "turn one" })] as never,
      });
    });
    mountAgent(agentId);
    expect(bodyEl.scrollTop).toBe(1000);

    bodyEl.scrollHeight = 1600;
    act(() => {
      appStore.dispatch({ type: "event", event: ev("message_delta", agentId, 20, { text: "turn two" }) as never, stampTs: true });
    });
    rerenderAgent(agentId);
    expect(bodyEl.scrollTop).toBe(1600); // tail-follow still works

    const ro = contentResizeObserver();
    bodyEl.scrollHeight = 2000; // late-resolving block (e.g. shiki highlight) after the append
    act(() => ro.cb());
    expect(bodyEl.scrollTop).toBe(2000);
  });
});
