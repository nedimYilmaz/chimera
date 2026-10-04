import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { emptyAgent, type AgentView } from "@chimera/ui-state";

import { AgentDetailPanel } from "../src/components/AgentDetailPanel";

// R2 (ctx meter effective-limit): AgentDetailPanel had ZERO prior test coverage (verified —
// Collapse.test.tsx's only "AgentDetailPanel" hit is a comment) despite being one of the two
// real consumers of the ctx%/used-limit consistency fix (mirrors TranscriptHeader.test.tsx). No
// window-dependent effects here (unlike TranscriptPanel), so it renders fine in this package's
// bare node-env vitest harness.

function agent(over: Partial<AgentView> = {}): AgentView {
  return { ...emptyAgent("ag-1"), ...over };
}

function render(agentView: AgentView, status: Record<string, unknown> | null = null) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      React.createElement(AgentDetailPanel, { agent: agentView, status, loading: false, onClose: () => {} }),
    );
  });
  return renderer;
}

function usageRowText(renderer: ReturnType<typeof create>): string {
  // Row renders {label} then {children} as sibling spans inside one .row div — find the "usage"
  // label span, walk up to its row container, then join every descendant span's text (mirrors
  // how a real user reads the rendered line).
  const label = renderer.root.findAllByType("span").find((n) => n.children.includes("usage"));
  const row = label!.parent!;
  return row.findAllByType("span").map((s) => s.children.join("")).join("");
}

describe("AgentDetailPanel — usage row (R2 ctx meter consistency)", () => {
  it("ctx% and the used/limit figure share the SAME basis (fullContext), not usageTotal", () => {
    const a = agent({
      costUsd: 1.5,
      usage: { input: 190_000, output: 500, cacheRead: 8_000, cacheCreation: 0 },   // fullContext = 198_000
      ctxUsage: { input: 190_000, output: 500, cacheRead: 8_000, cacheCreation: 0 },
      model: "claude-opus-4-8",   // native window 200_000, no effectiveContextLimit on the record
    });
    const text = usageRowText(render(a));
    expect(text).toContain("ctx 99%");        // 198_000 / 200_000, floored
    expect(text).toContain("198k/200k");      // used/limit — the SAME basis the % is computed from
    // usageTotal (input+output = 190_500) is a DIFFERENT number from fullContext — must still
    // show, but only in the separately-labeled billable figure, never masquerading as the ctx
    // basis (the "5.6k tok · ctx 100%" inconsistency this fixes).
    expect(text).toContain("191k fresh + output");
  });

  it("effectiveContextLimit (an operator-configured compactionThreshold) wins over the model's native window", () => {
    const a = agent({
      usage: { input: 90_000, output: 0, cacheRead: 0, cacheCreation: 0 },
      ctxUsage: { input: 90_000, output: 0, cacheRead: 0, cacheCreation: 0 },
      model: "gpt-5.6-sol",              // native window 1_050_000
      effectiveContextLimit: 90_000,     // configured threshold, smaller than the native window
    });
    const text = usageRowText(render(a));
    expect(text).toContain("ctx 100%");    // 90k / 90k configured, NOT 90k / 1.05M native
    expect(text).toContain("90.0k/90.0k");
  });

  it("no current context yet: renders unknown even when billable usage exists", () => {
    const a = agent({ usage: { input: 9_000_000, output: 10, cacheRead: 0, cacheCreation: 0 }, ctxUsage: null, model: "claude-opus-4-8", effectiveContextLimit: 922_000 });
    const text = usageRowText(render(a));
    expect(text).toContain("ctx unknown");
    expect(text).not.toContain("ctx 100%");
    expect(text).toContain("—/922k");
  });

  it("close button fires onClose", () => {
    const onClose = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(AgentDetailPanel, { agent: agent(), status: null, loading: false, onClose }),
      );
    });
    const close = renderer.root.findByProps({ "data-agent-detail-close": true });
    act(() => (close.props["onClick"] as () => void)());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ROLES-UNIFY §6.3/§9.2: the sessionRoleOverrides audit line is READ-ONLY (no
// edit control — decision #2, §1: no retroactive respawn) plus a "spawn
// another like this" action. The callback is a plain prop (onSpawnAnotherLikeThis),
// not a direct appStore/composerLocal import — keeps this component free of
// window-dependent bridge side effects (see the file-header comment); the
// real wiring lives in TranscriptPanel.tsx, which already owns that store access.
describe("AgentDetailPanel — role audit line (ROLES-UNIFY §6.3)", () => {
  it("renders no role row for a plain (non-session-role) spawn", () => {
    const renderer = render(agent({ sessionRole: undefined }));
    expect(renderer.root.findAllByProps({ "data-spawn-again-like-this": true }).length).toBe(0);
  });

  it("shows the spawned-from role and '(no overrides)' when none were recorded", () => {
    const renderer = render(agent({ sessionRole: "aws", sessionRoleOverrides: null }));
    const chip = renderer.root.findByProps({ "data-spawn-again-like-this": true });
    const rowText = chip.parent!.findAllByType("span").map((s) => s.children.join("")).join("");
    expect(rowText).toContain("spawned from");
    expect(rowText).toContain("aws");
    expect(rowText).toContain("(no overrides)");
  });

  it("shows each overridden field when sessionRoleOverrides is non-empty", () => {
    const renderer = render(agent({ sessionRole: "review", sessionRoleOverrides: { model: "claude-opus-5", effort: "high" } }));
    const chip = renderer.root.findByProps({ "data-spawn-again-like-this": true });
    const rowText = chip.parent!.findAllByType("span").map((s) => s.children.join("")).join("");
    expect(rowText).toContain("model=claude-opus-5");
    expect(rowText).toContain("effort=high");
    expect(rowText).not.toContain("no overrides");
  });

  it("'spawn another like this' calls onSpawnAnotherLikeThis with the role name, never a live edit", () => {
    const onSpawnAnotherLikeThis = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(AgentDetailPanel, {
          agent: agent({ sessionRole: "triage", sessionRoleOverrides: { model: "claude-haiku-4-5" } }),
          status: null, loading: false, onClose: () => {}, onSpawnAnotherLikeThis,
        }),
      );
    });
    const chip = renderer.root.findByProps({ "data-spawn-again-like-this": true });
    act(() => (chip.props["onClick"] as () => void)());
    expect(onSpawnAnotherLikeThis).toHaveBeenCalledTimes(1);
    expect(onSpawnAnotherLikeThis).toHaveBeenCalledWith("triage");
  });

  it("is a no-op (never throws) when onSpawnAnotherLikeThis is omitted — no half-built edit control", () => {
    const renderer = render(agent({ sessionRole: "blank" }));
    const chip = renderer.root.findByProps({ "data-spawn-again-like-this": true });
    expect(() => act(() => (chip.props["onClick"] as () => void)())).not.toThrow();
  });
});

// F41.2: the measured cache-write span appends " over <servers>" when AgentRecord.toolSurfaceServers
// (F41.1) landed non-empty — the servers that actually contributed to the first-turn prompt this
// figure was billed against, not just chimera's own core-tier tools.
describe("AgentDetailPanel — tool surface row (F41 servers clause)", () => {
  function toolSurfaceRowText(renderer: ReturnType<typeof create>): string {
    const label = renderer.root.findAllByType("span").find((n) => n.children.includes("tool surface"));
    const row = label!.parent!;
    return row.findAllByType("span").map((s) => s.children.join("")).join("");
  }

  it("appends ' over <servers>' to the measured span when toolSurfaceServers is non-empty", () => {
    const renderer = render(agent({ toolSurfaceCacheWriteTokens: 4200, toolSurfaceServers: ["chimera", "github"] }));
    const text = toolSurfaceRowText(renderer);
    expect(text).toContain("first-turn cache write 4.2k tok (measured) over chimera, github");
  });

  it("omits the clause entirely when toolSurfaceServers is empty or absent", () => {
    const renderer = render(agent({ toolSurfaceCacheWriteTokens: 4200, toolSurfaceServers: [] }));
    const text = toolSurfaceRowText(renderer);
    expect(text).toContain("first-turn cache write 4.2k tok (measured)");
    expect(text).not.toContain(" over ");
  });
});
