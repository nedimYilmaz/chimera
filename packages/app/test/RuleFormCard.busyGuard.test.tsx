import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// RULE-FORM-BUSY-GUARD — HookRuleFormCard and NotifyRuleFormCard both wrap an
// async onSubmit as `() => void`, so their own submit() can't await it: busy
// flips true then immediately back false in the same tick, before the RPC
// round-trip resolves. That silently defeats both the re-entrancy guard (a
// second Enter/click while saving fires a second concurrent write) and the
// disabled-button feedback (the button never visibly reads "saving"). Both
// forms mount through OverlayCard, which listens on `window` for Escape.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

import { HookRuleFormCard } from "../src/components/HookRuleFormCard";
import { NotifyRuleFormCard } from "../src/components/NotifyRuleFormCard";
import type { HookFormDraft } from "../src/state/commands.hooks";
import type { NotifyFormDraft } from "../src/state/commands.notify";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}
function byAttr(tree: TreeNode, attr: string): TreeNode[] {
  return findAll(tree, (n) => attr in n.props);
}

/** A controllable async onSubmit: doesn't resolve until `resolve()` is called. */
function deferredSubmit() {
  let calls = 0;
  let resolve!: () => void;
  const pending = new Promise<void>((r) => { resolve = r; });
  const onSubmit = () => { calls += 1; return pending; };
  return { onSubmit, resolve, get calls() { return calls; } };
}

const HOOK_DRAFT: HookFormDraft = {
  name: "r1", topic: "task.state", filterKey: "", filterValue: "",
  actions: [{ type: "notify", to: "", text: "", queue: "", prompt: "", role: "", command: "", timeoutSec: "60", channel: "toast", webhookUrl: "" }],
  enabled: true,
};

const NOTIFY_DRAFT: NotifyFormDraft = {
  name: "r1", kind: "task.state", filterKey: "", filterValue: "",
  channel: "toast", webhookUrl: "", throttleSec: "60", enabled: true,
};

describe("HookRuleFormCard — busy guard", () => {
  it("a second save click while the first is still pending does not call onSubmit again, and the button stays disabled", async () => {
    const d = deferredSubmit();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(HookRuleFormCard, {
          editing: null, draft: HOOK_DRAFT, error: null,
          onChange: () => {}, onAddAction: () => {}, onRemoveAction: () => {}, onUpdateAction: () => {},
          onSubmit: d.onSubmit, onClose: () => {},
        }),
      );
    });

    const clickSave = () => {
      const [btn] = byAttr(renderer.toJSON() as TreeNode, "data-hook-save");
      (btn!.props["onClick"] as () => void)();
    };

    await act(async () => { clickSave(); await Promise.resolve(); });
    expect(d.calls).toBe(1);

    const [btnAfterFirstClick] = byAttr(renderer.toJSON() as TreeNode, "data-hook-save");
    expect(btnAfterFirstClick!.props["disabled"]).toBe(true);

    await act(async () => { clickSave(); await Promise.resolve(); });
    expect(d.calls).toBe(1); // still 1 — the guard must block the re-entrant click

    await act(async () => { d.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const [btnAfterResolve] = byAttr(renderer.toJSON() as TreeNode, "data-hook-save");
    expect(btnAfterResolve!.props["disabled"]).toBeFalsy();
  });
});

describe("NotifyRuleFormCard — busy guard", () => {
  it("a second save click while the first is still pending does not call onSubmit again, and the button stays disabled", async () => {
    const d = deferredSubmit();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(NotifyRuleFormCard, {
          editing: null, draft: NOTIFY_DRAFT, error: null,
          onChange: () => {}, onSubmit: d.onSubmit, onClose: () => {},
        }),
      );
    });

    const clickSave = () => {
      const [btn] = byAttr(renderer.toJSON() as TreeNode, "data-notify-save");
      (btn!.props["onClick"] as () => void)();
    };

    await act(async () => { clickSave(); await Promise.resolve(); });
    expect(d.calls).toBe(1);

    const [btnAfterFirstClick] = byAttr(renderer.toJSON() as TreeNode, "data-notify-save");
    expect(btnAfterFirstClick!.props["disabled"]).toBe(true);

    await act(async () => { clickSave(); await Promise.resolve(); });
    expect(d.calls).toBe(1); // still 1 — the guard must block the re-entrant click

    await act(async () => { d.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const [btnAfterResolve] = byAttr(renderer.toJSON() as TreeNode, "data-notify-save");
    expect(btnAfterResolve!.props["disabled"]).toBeFalsy();
  });
});
