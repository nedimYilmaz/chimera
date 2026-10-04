import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { act, create } from "react-test-renderer";

// AGENT-MARK-VISIBILITY. Reported with three agents marked for a batch action and no way to see
// which: "the icons here are really barely visible — the marked agent's icon colour should change,
// you can't tell it's selected against the background."
//
// The mark box carried `.rowAction` alone, the class every row affordance shares, whose colour is
// --ghost (#3c424e — the palette's "barely-there hints" tone). ☑ and ☐ therefore painted
// identically, so the one thing a batch send/kill/hold must show before it runs — WHICH agents are
// in the set — was invisible.

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {}, removeEventListener: () => {},
    setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
}
if (typeof localStorage === "undefined") {
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
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
import styles from "../src/components/AgentList.module.css";
import { appStore } from "../src/state/store";

const MARKED = "mkvis001";
const PLAIN = "mkvis002";

/** Renders the list with MARKED marked and PLAIN merely selected — the two states that looked the
 *  same — and returns each row's mark button className. */
function markClassNames(): Record<string, string> {
  act(() => {
    appStore.dispatch({ type: "agentRecords", records: [
      { agentId: MARKED, state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 },
      { agentId: PLAIN, state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 2 },
    ] });
    appStore.dispatch({ type: "clearAgentMarks" });
    appStore.dispatch({ type: "toggleAgentMark", agentId: MARKED });
    appStore.dispatch({ type: "selectAgent", agentId: PLAIN });
  });
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(React.createElement(AgentList)); });
  const out: Record<string, string> = {};
  for (const btn of renderer.root.findAllByProps({ "data-agent-action": "agents.mark" })) {
    const id = btn.props["data-agent-marked"] === "1" ? "marked" : "unmarked";
    out[id] = String(btn.props["className"] ?? "");
  }
  return out;
}

describe("a marked agent's box is visibly different from an unmarked one", () => {
  it("gives the marked box its own class, not the shared row-affordance one alone", () => {
    // The defect exactly: both states resolved to the same className, so no stylesheet rule could
    // ever tell them apart however the colours were tuned.
    const cls = markClassNames();
    expect(cls["marked"]).toBeDefined();
    expect(cls["unmarked"]).toBeDefined();
    expect(cls["marked"]).not.toEqual(cls["unmarked"]);
    expect(cls["marked"]).toContain(styles.markActionOn);
    expect(cls["unmarked"]).not.toContain(styles.markActionOn);
  });

  it("still carries the shared affordance class, so the mark keeps the row's sizing and cursor", () => {
    // The new classes ADD to .rowAction rather than replacing it — padding, line-height and the
    // pointer cursor all live there, and a box that stopped matching its neighbours would be a
    // different bug.
    const cls = markClassNames();
    expect(cls["marked"]).toContain(styles.rowAction);
    expect(cls["unmarked"]).toContain(styles.rowAction);
  });
});

describe("the mark colours are actually distinct", () => {
  // Asserted against the stylesheet because this harness has no DOM and cannot compute a rendered
  // colour — same discipline as RoleBindingOverrideEditor's clamp test. The classes above prove the
  // two states are distinguishable AT ALL; these prove the distinction is a visible one.
  const css = readFileSync(join(__dirname, "../src/components/AgentList.module.css"), "utf8");
  const ruleFor = (name: string): string => {
    const at = css.indexOf(`.${name} {`);
    expect(at, `.${name} is not in the stylesheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };
  const colourOf = (rule: string): string => /color:\s*([^;]+);/.exec(rule)?.[1]?.trim() ?? "";

  it("lifts the unmarked box off --ghost", () => {
    // --ghost is documented in tokens.css as "barely-there hints". A control the operator has to
    // FIND before a batch action is not a hint.
    expect(ruleFor("markAction")).not.toContain("--ghost");
    expect(colourOf(ruleFor("markAction"))).not.toBe("");
  });

  it("paints the marked box a different colour from the unmarked one", () => {
    expect(colourOf(ruleFor("markActionOn"))).not.toBe("");
    expect(colourOf(ruleFor("markActionOn"))).not.toBe(colourOf(ruleFor("markAction")));
  });

  it("orders the mark rules AFTER .rowAction, which is what makes them win", () => {
    // Equal specificity (all single classes), so source order alone decides. Placed before
    // .rowAction they would parse fine, apply nothing, and the bug would silently return.
    expect(css.indexOf(".markAction {")).toBeGreaterThan(css.indexOf(".rowAction {"));
    expect(css.indexOf(".markActionOn {")).toBeGreaterThan(css.indexOf(".markAction {"));
  });
});
