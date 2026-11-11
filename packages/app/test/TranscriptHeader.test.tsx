import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TranscriptHeader } from "../src/components/TranscriptHeader";

// WORKFLOW-UI-2 (header parity) — TranscriptHeader is the SHARED component
// extracted verbatim out of TranscriptPanel.tsx's former inline header
// (headerTop: name/id button + state chip; chipRow: model/account/cost/ctx
// meter + sparkline + "↑N more" hint). TranscriptPanel itself can't be
// rendered in this package's vitest harness (bare node env, no jsdom/window —
// see PathPicker.test.tsx's note — and TranscriptPanel's own effects touch
// window/ResizeObserver/getComputedStyle unconditionally on mount), so THIS
// suite is the structure proof for that consumer: both TranscriptPanel and
// StitchedTranscriptPanel (see StitchedTranscriptPanel.test.tsx's own header
// assertions) feed the identical prop shape into this one component, so a
// single rendered structure here covers both call sites byte-for-byte.

const baseProps = {
  name: "codex-9",
  fullId: "codex-9-full-id",
  state: "◐ running",
  tone: "success" as const,
  overBudget: false,
  model: "claude-opus-4-8",
  effort: "high",
  account: "acct-a",
  costUsd: 1.2345,
  usageTotal: 4200,
  // R2 (ctx meter effective-limit): the caller-resolved denominator (previously ctxPct
  // resolved this itself from `model` — now the caller does, via effectiveContextLimitForAgent).
  // 200k matches the pre-existing "no model" default so untouched assertions below stay valid.
  limit: 200_000,
  ring: [] as number[],
  hint: { above: 0, below: 0 },
  detailOpen: false,
  onToggleDetail: () => {},
  onAction: () => {},
};

function renderHeader(props: Partial<React.ComponentProps<typeof TranscriptHeader>> = {}) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(TranscriptHeader, { ...baseProps, ...props }));
  });
  return renderer;
}

/** Every node whose className string matches `pattern` — CSS module class
 * names are hashed at build time (e.g. "_stateChip_x1y2"), so every class
 * lookup here matches by substring, not exact equality. */
function byClass(renderer: ReturnType<typeof create>, pattern: RegExp): ReactTestInstance[] {
  return renderer.root.findAll((n) => typeof n.props["className"] === "string" && pattern.test(n.props["className"] as string));
}

describe("TranscriptHeader — headerTop (name/id button + state chip)", () => {
  it("keeps execution mode in the composer rather than duplicating it in the header", () => {
    const r = renderHeader({ executionMode: "plan" });
    expect(r.root.findAll(n => n.props["data-execution-mode"])).toHaveLength(0);
    act(() => r.unmount());
  });
  it("offers one voice-history toggle that reflects explicit visibility", () => {
    const onToggleVoiceHistory = vi.fn();
    const renderer = renderHeader({ onToggleVoiceHistory });
    const buttons = renderer.root.findAllByProps({ "aria-label": "Show voice history" });
    expect(buttons).toHaveLength(1);
    act(() => buttons[0]!.props.onClick());
    expect(onToggleVoiceHistory).toHaveBeenCalledOnce();
    act(() => renderer.update(<TranscriptHeader {...baseProps} voiceHistoryOpen onToggleVoiceHistory={onToggleVoiceHistory} />));
    expect(renderer.root.findByProps({ "aria-label": "Hide voice history" }).props["aria-pressed"]).toBe(true);
    act(() => renderer.unmount());
  });
  it("reflects the remote connection and toggles it without opening a panel", () => {
    const onAction = vi.fn();
    const r = renderHeader({ onAction });
    const button = () => r.root.findByProps({ "aria-label": "remote control" });
    expect(button().props["aria-pressed"]).toBe(false);
    act(() => button().props.onClick());
    expect(onAction).toHaveBeenCalledWith("system.remoteControl");
    act(() => r.update(<TranscriptHeader {...baseProps} remoteControlEnabled remoteControlActive />));
    expect(button().props["aria-expanded"]).toBeUndefined();
    expect(button().props["aria-pressed"]).toBe(true);
    expect(button().props.title).toContain("Disable");
    act(() => r.unmount());
  });
  it("blocks repeated remote requests until acknowledgement", async () => {
    let finish!: () => void;
    const onAction = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const r = renderHeader({ onAction, resourceAgentId: "pending-agent" });
    const button = () => r.root.findByProps({ "aria-label": "remote control" });
    act(() => { button().props.onClick(); button().props.onClick(); });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(button().props.disabled).toBe(true);
    await act(async () => { finish(); });
    expect(button().props.disabled).toBe(false);
    act(() => r.unmount());
  });
  it("reflects the selected agent's terminal dock and dispatches the existing toggle", () => {
    const onAction = vi.fn();
    const r = renderHeader({ terminalOpen: true, onAction });
    const button = () => r.root.findByProps({ "aria-label": "toggle terminal" });
    expect(button().props["aria-pressed"]).toBe(true);
    expect(button().props.title).toContain("Hide terminal");
    act(() => button().props.onClick());
    expect(onAction).toHaveBeenCalledWith("terminal.toggle");
    act(() => r.update(<TranscriptHeader {...baseProps} terminalOpen={false} />));
    expect(button().props["aria-expanded"]).toBe(false);
    expect(button().props["aria-pressed"]).toBe(false);
    act(() => r.unmount());
  });
  it("shows compaction only while busy and prevents duplicate submissions", () => {
    const r = renderHeader({ compacting: true });
    const button = () => r.root.findByProps({ "aria-label": "compact context now" });
    expect(button().props.disabled).toBe(true);
    expect(button().props["aria-busy"]).toBe(true);
    expect(button().props["data-active"]).toBe(true);
    expect(button().props["aria-pressed"]).toBeUndefined();
    act(() => r.update(<TranscriptHeader {...baseProps} compacting={false} />));
    expect(button().props.disabled).toBe(false);
    expect(button().props["data-active"]).toBe(false);
    act(() => r.unmount());
  });
  it("renders the name, full id, and a collapsed detail glyph", () => {
    const renderer = renderHeader();
    const toggle = renderer.root.findByProps({ "data-agent-detail-toggle": true });
    expect(toggle.props["aria-expanded"]).toBe(false);
    expect(toggle.props["aria-label"]).toBe("codex-9 — show agent detail");
    const texts = toggle.findAllByType("span").map((s) => s.children.join(""));
    expect(texts).toContain("codex-9");
    expect(texts).toContain("codex-9-full-id");
    expect(texts).toContain("▸");
  });

  it("flips the glyph and aria-label, and fires onToggleDetail, when detailOpen", () => {
    const onToggleDetail = vi.fn();
    const renderer = renderHeader({ detailOpen: true, onToggleDetail });
    const toggle = renderer.root.findByProps({ "data-agent-detail-toggle": true });
    expect(toggle.props["aria-expanded"]).toBe(true);
    expect(toggle.props["aria-label"]).toBe("codex-9 — hide agent detail");
    act(() => (toggle.props["onClick"] as () => void)());
    expect(onToggleDetail).toHaveBeenCalledTimes(1);
  });

  it("omits duplicate lifecycle status while retaining the soft-limit warning", () => {
    const r = renderHeader({ state: "◐ running", overBudget: true, search: <input aria-label="History search" /> });
    expect(byClass(r, /stateChip/)).toHaveLength(0);
    expect(r.root.findByProps({ "aria-label": "History search" })).toBeDefined();
    expect(r.root.findByProps({ "data-soft-limit-warning": true }).children.join("")).toContain("soft limit");
    act(() => r.unmount());
  });
});

describe("TranscriptHeader — chipRow (model/account/cost/ctx meter + sparkline + hint)", () => {
  it("renders model/effort/account chips only when provided", () => {
    const withAll = renderHeader({ model: "claude-opus-4-8", effort: "high", account: "acct-a" });
    const withNone = renderHeader({ model: undefined, effort: undefined, account: undefined });
    // model/effort/account/cost chips all share the SAME `.chip` class — only
    // cost (always rendered) survives when the three action chips are absent.
    expect(byClass(withAll, /^_?chip/).length).toBe(byClass(withNone, /^_?chip/).length + 3);
  });

  it.each([
    ["system.model", "system.model"],
    ["system.effort", "system.effort"],
    ["system.accountSwitch", "system.accountSwitch"],
    ["system.remoteControl", "system.remoteControl"],
    ["system.compact", "system.compact"],
  ])("%s button dispatches the existing action id", (dataAction, actionId) => {
    const onAction = vi.fn();
    const renderer = renderHeader({ onAction });
    const button = renderer.root.findByProps({ "data-transcript-action": dataAction });

    act(() => button.props["onClick"]());

    expect(onAction).toHaveBeenCalledWith(actionId);
  });

  // WORKFLOW-HEADER-CHIPS-DEAD: a workflow's stitched view only lets model/effort/account
  // apply while the step's agent is actually live — chipsInteractive=false must render
  // plain non-interactive text (no button, no data-transcript-action, no dispatch) instead
  // of a `▾` control connected to nothing.
  it.each([
    ["system.model", "model:"],
    ["system.effort", "effort:"],
    ["system.accountSwitch", "account:"],
  ])("chipsInteractive=false renders %s as static text, not a button", (actionId, textPrefix) => {
    const onAction = vi.fn();
    const renderer = renderHeader({ onAction, chipsInteractive: false });
    expect(renderer.root.findAllByProps({ "data-transcript-action": actionId })).toHaveLength(0);
    const [staticChip] = renderer.root.findAllByProps({ "data-transcript-static": actionId });
    expect(staticChip).toBeDefined();
    expect(staticChip!.type).not.toBe("button");
    expect(staticChip!.findAllByType("button")).toHaveLength(0);
    expect(staticChip!.children.join("")).toContain(textPrefix);
  });

  it("chipsInteractive defaults to true (single-agent mode unaffected)", () => {
    const renderer = renderHeader();
    expect(renderer.root.findAllByProps({ "data-transcript-action": "system.model" })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ "data-transcript-static": "system.model" })).toHaveLength(0);
  });

  it("cost chip always renders, formatted via fmtCost", () => {
    const renderer = renderHeader({ costUsd: 1.2345 });
    const all = renderer.root.findAllByType("span").map((s) => s.children.join(""));
    expect(all.some((t) => t.includes("1.23"))).toBe(true);
  });

  it("ctx meter percent/tokens render, and the sparkline only shows once the ring has samples", () => {
    const noRing = renderHeader({ usageTotal: 4200, ring: [] });
    expect(byClass(noRing, /^_?spark/)).toHaveLength(0);

    const withRing = renderHeader({ usageTotal: 4200, ring: [10, 20, 30] });
    const [spark] = byClass(withRing, /^_?spark/);
    expect(spark!.children.join("").length).toBeGreaterThan(0);
  });

  it("the '↑N more' hint only renders when above/below is non-zero", () => {
    const none = renderHeader({ hint: { above: 0, below: 0 } });
    expect(byClass(none, /moreHint/)).toHaveLength(0);

    const some = renderHeader({ hint: { above: 3, below: 0 } });
    const [hint] = byClass(some, /moreHint/);
    expect(hint!.children.join("")).toContain("↑ 3 more");
  });

  // R2 (unified cache-aware token/ctx/cost metrics): ctx% is now driven by the SEPARATE
  // `fullContext` prop (+ the model's real context window), not `usageTotal` — the tokens
  // figure next to it still reads from usageTotal, proving the two are independently wired.
  // `{ctxPct(...)}` renders as its OWN child, stringified by React (JSX doesn't concatenate an
  // expression container with adjacent literal text: "50" and "% · " are two separate
  // items in the ctx span's children array) — check for that exact string among every span's
  // immediate children, rather than parsing rendered strings.
  function hasCtxPercentChild(r: ReturnType<typeof create>, pct: number): boolean {
    return r.root.findAllByType("span").some((s) => s.children.includes(String(pct)));
  }

  it("ctx% uses fullContext + the caller-resolved limit, independent of usageTotal", () => {
    // A cumulative total cannot substitute for missing current-context telemetry.
    const noFullContext = renderHeader({ usageTotal: 100_000, limit: 200_000 });
    expect(hasCtxPercentChild(noFullContext, 50)).toBe(false);   // 100k / 200k (opus window)

    // fullContext, when provided, WINS over usageTotal for ctx% (usageTotal still renders,
    // just in the dimmed throughput slot now — see the consistent-basis test below).
    const withFullContext = renderHeader({ usageTotal: 999_999, fullContext: 200_000, limit: 400_000 });
    // if fullContext were ignored (bug: still basing ctx% on usageTotal), this would clamp to
    // 100 instead (999_999 / 400_000 limit > 100%) — 50 only appears when fullContext wins.
    expect(hasCtxPercentChild(withFullContext, 50)).toBe(true);    // 200k / 400k (synthetic limit prop, not the real gpt-5.6-sol window)
    expect(hasCtxPercentChild(withFullContext, 100)).toBe(false);
    // usageTotal still renders (now in the ghost/throughput slot, not the primary figure) —
    // fmtTokens(999_999) === "1000k".
    expect(withFullContext.root.findAllByType("b").some((s) => s.children.includes("1000k"))).toBe(true);
  });

  it("renders current context against the authoritative 922k limit", () => {
    const r = renderHeader({ usageTotal: 9_000_000, fullContext: 100_000, limit: 922_000 });
    expect(hasCtxPercentChild(r, 10)).toBe(true);
    expect(hasCtxPercentChild(r, 100)).toBe(false);
    expect(r.root.findAllByType("span").some((s) => s.children.includes("100k"))).toBe(true);
    expect(r.root.findAllByType("span").some((s) => s.children.includes("922k"))).toBe(true);
  });

  it("renders unknown current context without converting billable throughput into 100% occupancy", () => {
    const r = renderHeader({ usageTotal: 9_000_000, fullContext: null, limit: 922_000 });
    const ctx = byClass(r, /^_?ctx/).find((node) => node.children.join("").includes("ctx"));
    expect(ctx?.children.join("")).toContain("unknown");
    expect(hasCtxPercentChild(r, 100)).toBe(false);
    expect(r.root.findAllByType("span").some((s) => s.children.includes("922k"))).toBe(true);
  });

  // R2 (ctx meter consistency): the primary figure next to the percentage must now SHARE the
  // percentage's own basis (fullContext/limit) — the "ctx 100% · 5.6k" inconsistency this fixes
  // was the number shown here being usageTotal (a DIFFERENT basis than the bar).
  it("the primary figure next to ctx% is fullContext/limit (used/limit), not usageTotal", () => {
    const r = renderHeader({ usageTotal: 5600, fullContext: 198_000, limit: 200_000 });
    expect(hasCtxPercentChild(r, 99)).toBe(true);   // 198k / 200k, floored
    // "{fmtTokens(fullContext)}/{fmtTokens(limit)}" compiles to separate children, each an
    // isolated string in a span's children array — same "isolated child" shape hasCtxPercentChild
    // already relies on (JSX doesn't concatenate adjacent expression/literal children).
    expect(r.root.findAllByType("span").some((s) => s.children.includes("198k"))).toBe(true);
    expect(r.root.findAllByType("span").some((s) => s.children.includes("200k"))).toBe(true);
    // usageTotal (5.6k) still renders, but nowhere claims to BE the ctx basis — it shows in the
    // dimmed ghost slot alongside the throughput sparkline it already described.
    expect(r.root.findByProps({ "data-token-total": true }).findByType("b").children.join("")).toBe("5.6k");
    expect(r.root.findAllByProps({ "data-token-rate": true })).toHaveLength(0);
  });
});
describe("TranscriptHeader permission summary", () => {
  it.each(["full", "acceptEdits", "readOnly"])("keeps normal %s permission in details without a duplicate chip", permissionProfile => {
    const r = renderHeader({ permissionProfile, permissionRequest: "auto" });
    expect(r.root.findAll(n => n.props["data-permission-tone"])).toHaveLength(0);
    expect(JSON.stringify(r.toJSON())).toContain(`Permissions: `);
    act(() => r.unmount());
  });
});

describe("Transcript metric basis disclosure", () => {
  it("distinguishes the effective compaction basis from the actual provider session window", () => {
    const r = renderHeader({ fullContext: 225000, limit: 450000, contextLimits: { source: "codex", sessionWindow: 475000, compactAt: 450000, requestedWindow: 500000, maxWindow: 1050000 } });
    expect(r.root.findByProps({ "data-context-meter": "known" }).props.title).toContain("effective context limit");
    const detail = r.root.findByProps({ "data-context-detail": true });
    expect(detail.children.join("")).toContain("effective context limit");
    expect(detail.findAllByType("span").map(s => s.children.join(""))).toContain("450k");
    expect(r.root.findByProps({ "data-context-limits": true }).children.join("")).toContain("Active session 475k");
    act(() => r.unmount());
  });
  it("uses unknown for absent current context instead of a zero counter", () => {
    const r = renderHeader({ fullContext: null, limit: 450000 });
    expect(r.root.findByProps({ "data-context-detail": true }).findAllByType("span")[0]!.children.join("")).toBe("unknown");
    act(() => r.unmount());
  });
});

it("keeps a measured prompt counter when only the denominator is unknown", () => {
  const r = renderHeader({ fullContext: 200000, limit: 0 });
  expect(r.root.findByProps({ "data-context-meter": "unknown" })).toBeDefined();
  expect(r.root.findByProps({ "data-context-detail": true }).findAllByType("span").map(s => s.children.join(""))).toEqual(["200k", "unknown"]);
  act(() => r.unmount());
});


it.each(["pending", "failed", "unverified", "applied"] as const)("renders truthful %s application copy", profileStatus => {
  const renderer = renderHeader({ permissionProfile: "readOnly", permissionRequest: "tui", permissionAppliedToRunningProcess: false,
    permissionApplication: { version: 1, requestedProfile: "readOnly", effectiveProfile: "full", profileStatus, requestedRouting: "tui", routingStatus: profileStatus === "applied" ? "applied" : "bypassed", transport: "app-server", nativeApprovals: true, ...(profileStatus === "failed" ? { error: "policy rejected" } : {}) } });
  const chip = renderer.root.findAllByType("span").find(node => typeof node.props.title === "string" && node.props.title.startsWith("Requested:"))!;
  if (profileStatus === "applied") {
    expect(chip).toBeUndefined();
    act(() => renderer.unmount());
    return;
  }
  expect(chip.props.title).toContain("effective: full");
  expect(chip.props.title).not.toContain("respawn required");
  expect(chip.children.join("")).toContain(profileStatus === "pending" ? "next turn pending" : profileStatus === "failed" ? "apply failed" : profileStatus === "unverified" ? "profile unverified" : "");
  act(() => renderer.unmount());
});

it("exec submitted copy keeps effective policy unknown and routing unavailable", () => {
  const r = renderHeader({ permissionProfile: "readOnly", permissionRequest: "tui", permissionApplication: { version: 2, requestedProfile: "readOnly", submittedProfile: "readOnly", submittedVersion: 2, profileStatus: "unverified", requestedRouting: "tui", routingStatus: "unsupported", transport: "exec", nativeApprovals: false } });
  const chip = r.root.findAllByType("span").find(n => typeof n.props.title === "string" && n.props.title.startsWith("Requested:"))!;
  expect(chip.props.title).toContain("effective: unknown");
  expect(chip.props.title).toContain("Exec submitted readOnly (generation 2)");
  expect(chip.props.title).toContain("no native approval hooks");
  expect(chip.children.join("")).toContain("routing unavailable");
  expect(chip.children.join("")).not.toContain("next turn pending");
  act(() => r.unmount());
});


it("fresh exec full/auto profile uncertainty is neutral and still inspectable", () => {
  const r = renderHeader({ permissionProfile: "full", permissionRequest: "auto", permissionAppliedToRunningProcess: false,
    permissionApplication: { version: 0, requestedProfile: "full", submittedProfile: "full", submittedVersion: 0, profileStatus: "unverified", requestedRouting: "auto", routingStatus: "unsupported", transport: "exec", nativeApprovals: false } });
  const chip = r.root.findByProps({ "data-permission-tone": "info" });
  expect(chip.children.join("")).toContain("profile unverified");
  expect(chip.children.join("")).not.toContain("⚠");
  expect(chip.props.title).toContain("effective: unknown");
  expect(chip.props.title).toContain("Exec submitted full (generation 0)");
  act(() => r.unmount());
});


describe("conversation control placement", () => {
  it("keeps lifecycle controls and duplicate paused status out of the conversation header", () => {
    const r = renderHeader({ lifecycleState: "running" });
    expect(r.root.findAll(n => n.props["data-agent-lifecycle"])).toHaveLength(0);
    expect(r.root.findByProps({ "data-agent-detail-toggle": true })).toBeTruthy();
    act(() => r.update(<TranscriptHeader {...baseProps} state="⏸ paused" lifecycleState="paused" />));
    expect(r.root.findAllByProps({ "aria-label": "⏸ paused" })).toHaveLength(0);
    expect(r.root.findByProps({ "aria-label": "remote control" }).findByType("svg")).toBeTruthy();
    act(() => r.unmount());
  });
});
