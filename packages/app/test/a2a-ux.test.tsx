import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import type { NormalizedEvent } from "@chimera/protocol";

// Same import-time Tauri side-effect stub + window stub the TranscriptPanel test
// uses — these components transitively reach store.ts → rpc/bridge.
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

import { A2AIndicator } from "../src/components/A2AIndicator";
import { A2ATicker } from "../src/components/A2ATicker";
import { TranscriptPanel } from "../src/components/TranscriptPanel";
import { appStore } from "../src/state/store";
import { projectsLocal } from "../src/state/commands.projects";
import { agentName } from "../src/state/selectors";
import type { AgentView } from "@chimera/ui-state";

let seq = 100;
const deliverEvent = (to: string, from: string, text: string): NormalizedEvent =>
  ({ ts: 1_700_000_000_000 + ++seq, seq: ++seq, agentId: to, kind: "status", data: { delivered: true, from, text } } as NormalizedEvent);

const emit = (e: NormalizedEvent) => act(() => { appStore.dispatch({ type: "event", event: e }); });
const rows = (r: ReactTestRenderer) => r.root.findAll((n) => (n.props as Record<string, unknown>)["data-a2a-indicator-row"] !== undefined);
const strings = (n: ReactTestInstance): string[] => n.findAll(() => true).flatMap((x) => (x.children as unknown[]).filter((c): c is string => typeof c === "string"));

// ===========================================================================
// PART 2 — the ephemeral live-traffic indicator (deterministic: onAnimationEnd)
// ===========================================================================
describe("PART2 app — A2AIndicator lifecycle", () => {
  it("renders nothing on mount (seeds the feed — no history replay)", () => {
    emit(deliverEvent("recvA", "sendA", "seed-only")); // history exists BEFORE mount
    let r!: ReactTestRenderer;
    act(() => { r = create(<A2AIndicator />); });
    expect(rows(r).length).toBe(0);
    act(() => r.unmount());
  });

  it("a new agent→agent delivery animates in a '<sender> ⇒ <receiver> · snippet' row", () => {
    let r!: ReactTestRenderer;
    act(() => { r = create(<A2AIndicator />); });   // mount first (seeds empty)
    emit(deliverEvent("recvB", "sendB", "handing off the build"));
    const row = rows(r);
    expect(row.length).toBe(1);
    const txt = strings(row[0]!).join(" ");
    expect(txt).toContain("⇒");
    expect(txt).toContain("handing off the build");
    expect(txt).toContain(agentName("sendB"));
    act(() => r.unmount());
  });

  it("fades out on animationEnd (the row unmounts — no leftover)", () => {
    let r!: ReactTestRenderer;
    act(() => { r = create(<A2AIndicator />); });
    emit(deliverEvent("recvC", "sendC", "bye"));
    expect(rows(r).length).toBe(1);
    act(() => { (rows(r)[0]!.props as { onAnimationEnd: () => void }).onAnimationEnd(); });
    expect(rows(r).length).toBe(0);
    act(() => r.unmount());
  });

  it("a burst STACKS but never grows past 3 rows (bounded)", () => {
    let r!: ReactTestRenderer;
    act(() => { r = create(<A2AIndicator />); });
    for (let i = 0; i < 6; i++) emit(deliverEvent(`recvD${i}`, `sendD${i}`, `m${i}`));
    expect(rows(r).length).toBe(3);
    act(() => r.unmount());
  });

  it("clicking a row jumps to the SENDER's transcript (selectAgent)", () => {
    let r!: ReactTestRenderer;
    act(() => { r = create(<A2AIndicator />); });
    emit(deliverEvent("recvE", "sendE", "look here"));
    act(() => { (rows(r)[0]!.props as { onClick: () => void }).onClick(); });
    expect(appStore.getState().selectedAgentId).toBe("sendE");
    act(() => r.unmount());
  });
});

// ===========================================================================
// PART 1 — the pinned ticker BAR is gone; the history overlay is still reachable
// ===========================================================================
describe("PART1 app — no ticker bar, history overlay reachable", () => {
  it("renders nothing while the history overlay is closed (the pinned bar is retired)", () => {
    projectsLocal.set({ a2aHistoryOpen: false });
    let r!: ReactTestRenderer;
    act(() => { r = create(<A2ATicker />); });
    expect(r.root.findAll((n) => (n.props as Record<string, unknown>)["data-a2a-ticker"] !== undefined)).toHaveLength(0);
    expect(r.toJSON()).toBeNull();
    act(() => r.unmount());
  });

  it("shows the ⇄ a2a history overlay (with the exchange) when a2aHistoryOpen is set — the retained entry point", () => {
    emit(deliverEvent("recvF", "sendF", "history entry"));
    projectsLocal.set({ a2aHistoryOpen: true });
    let r!: ReactTestRenderer;
    act(() => { r = create(<A2ATicker />); });
    const overlay = r.root.findAll((n) => (n.props as Record<string, unknown>)["data-a2a-history"] !== undefined);
    expect(overlay).toHaveLength(1);
    expect(strings(overlay[0]!).join(" ")).toContain("history entry");
    act(() => r.unmount());
    projectsLocal.set({ a2aHistoryOpen: false });
  });
});

// ===========================================================================
// PART 3 — delivered turn: @mention header + collapsed body + expand round-trip
// ===========================================================================
function agentWithDelivery(text: string, from: string): AgentView {
  return {
    agentId: "viewer-1", state: "running", account: "main", provider: "claude", model: "m",
    conductor: false, costUsd: 0, lastEventTs: 5, pendingQuestion: null,
    transcript: [{ role: "user", text, from }],
    tools: [],
  } as AgentView;
}

describe("PART3 app — delivered @mention + collapsed body", () => {
  it("the source renders as an @name mention chip whose click navigates to the sender", () => {
    let r!: ReactTestRenderer;
    act(() => { r = create(<TranscriptPanel agent={agentWithDelivery("please review", "sender-x")} />); });
    const chips = r.root.findAll((n) => typeof n.props["className"] === "string" && /mention/.test(n.props["className"] as string));
    expect(chips.length).toBeGreaterThanOrEqual(1);
    // the chip carries the sender's friendly name and navigates on click
    expect(strings(chips[0]!).some((s) => s.includes(agentName("sender-x")))).toBe(true);
    act(() => { (chips[0]!.props as { onClick: (e: { stopPropagation: () => void }) => void }).onClick({ stopPropagation: () => {} }); });
    expect(appStore.getState().selectedAgentId).toBe("sender-x");
    act(() => r.unmount());
  });

  it("a long delivered body is COLLAPSED by default and expands on the affordance click (round-trip)", () => {
    const long = "line one\nline two\nline three\nline four";
    let r!: ReactTestRenderer;
    act(() => { r = create(<TranscriptPanel agent={agentWithDelivery(long, "sender-y")} />); });
    const toggle = () => r.root.findAll((n) => (n.props as Record<string, unknown>)["data-delivery-toggle"] !== undefined);
    // collapsed: the toggle exists, the tail line is hidden
    expect(toggle()).toHaveLength(1);
    const bodyText = () => r.root.findAll((n) => typeof n.props["className"] === "string" && /userText/.test(n.props["className"] as string)).flatMap((n) => strings(n)).join(" ");
    expect(bodyText()).toContain("line one");
    expect(bodyText()).not.toContain("line four");
    // expand
    act(() => { (toggle()[0]!.props as { onClick: () => void }).onClick(); });
    expect(bodyText()).toContain("line four");
    // collapse again (round-trip)
    act(() => { (toggle()[0]!.props as { onClick: () => void }).onClick(); });
    expect(bodyText()).not.toContain("line four");
    act(() => r.unmount());
  });

  it("a short delivered body renders in full with no expand affordance", () => {
    let r!: ReactTestRenderer;
    act(() => { r = create(<TranscriptPanel agent={agentWithDelivery("just one short line", "sender-z")} />); });
    expect(r.root.findAll((n) => (n.props as Record<string, unknown>)["data-delivery-toggle"] !== undefined)).toHaveLength(0);
    act(() => r.unmount());
  });

  // DELIVERY-MD-RENDER: a delivered agent turn formats through the SAME MessageBody
  // markdown pipeline as an assistant turn (not flat plain text).
  it("a short delivered body markdown-renders (bold → <b>), like an assistant turn", () => {
    let r!: ReactTestRenderer;
    act(() => { r = create(<TranscriptPanel agent={agentWithDelivery("a **bold** report", "sender-md")} />); });
    // MessageBody renders **bold** as a <b> element — a plain-text render would have none.
    expect(r.root.findAll((n) => n.type === "b").length).toBeGreaterThanOrEqual(1);
    act(() => r.unmount());
  });

  it("an EXPANDED long delivered body markdown-renders (a table); COLLAPSED stays a plain teaser", () => {
    const table = "intro line\n\n| a | b |\n| - | - |\n| 1 | 2 |";
    let r!: ReactTestRenderer;
    act(() => { r = create(<TranscriptPanel agent={agentWithDelivery(table, "sender-tbl")} />); });
    const toggle = () => r.root.findAll((n) => (n.props as Record<string, unknown>)["data-delivery-toggle"] !== undefined);
    const tables = () => r.root.findAll((n) => n.type === "table");
    // collapsed: a mid-cut preview must NOT markdown-render (that would shred the table)
    expect(toggle()).toHaveLength(1);
    expect(tables()).toHaveLength(0);
    // expanded: the markdown table renders through MessageBody
    act(() => { (toggle()[0]!.props as { onClick: () => void }).onClick(); });
    expect(tables().length).toBeGreaterThanOrEqual(1);
    act(() => r.unmount());
  });
});
