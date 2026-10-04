import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// STALE-STATE-SWEEP: same bare window stub other overlay-card tests use — this
// package's vitest config runs a node env, no jsdom, and OverlayCard's esc-key
// effect needs a window to attach/detach listeners against.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

import { RoleFormCard, type RoleFormValues } from "../src/components/RoleFormCard";
import { CAPABILITY_NOTES } from "../src/copy";

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

const BASE: RoleFormValues = {
  name: "reviewer", model: "", permissionProfile: "", autonomy: "", instructions: "", plugins: "[]", mcpToolAllowlist: "{}",
  skills: "", effort: "high", account: "", provider: "", maxTurns: "", turnLimitPolicy: "", isolation: "",
  persistent: false, poolSize: "", orchestration: "{}", inherit: "{}", on: "{}", providerOptions: "{}", mcpServers: "{}",
};

let renderer: ReturnType<typeof create> | null = null;

async function renderWith(provider: string): Promise<ReturnType<typeof create>> {
  await act(async () => {
    renderer = create(
      React.createElement(RoleFormCard, {
        initial: { ...BASE, provider },
        onSubmit: async () => {},
        onClose: () => {},
      }),
    );
  });
  return renderer!;
}

async function renderWithValues(values: Partial<RoleFormValues>): Promise<ReturnType<typeof create>> {
  await act(async () => {
    renderer = create(
      React.createElement(RoleFormCard, {
        initial: { ...BASE, ...values },
        onSubmit: async () => {},
        onClose: () => {},
      }),
    );
  });
  return renderer!;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

// KIMI-BACKEND S6 (spec docs/superpowers/specs/2026-07-28-kimi-backend.md §11-S6): the
// role form's effort select must render the capability-downgrade note for a kimi-provider
// role, and must NOT render it for claude/codex/unset — an operator setting effort:"high"
// on any other provider must not see a note that only applies to kimi's coarse thinking
// on/off toggle.
describe("RoleFormCard — kimi effort downgrade note", () => {
  it("renders the note when provider is kimi", async () => {
    const r = await renderWith("kimi");
    const notes = byAttr(r.toJSON() as TreeNode, "data-kimi-effort-note");
    expect(notes).toHaveLength(1);
    expect((notes[0]!.children as string[]).join("")).toBe(CAPABILITY_NOTES.kimiEffortDowngrade);
  });

  it("does not render the note for claude", async () => {
    const r = await renderWith("claude");
    expect(byAttr(r.toJSON() as TreeNode, "data-kimi-effort-note")).toHaveLength(0);
  });

  it("does not render the note for codex", async () => {
    const r = await renderWith("codex");
    expect(byAttr(r.toJSON() as TreeNode, "data-kimi-effort-note")).toHaveLength(0);
  });

  it("does not render the note when provider is unset", async () => {
    const r = await renderWith("");
    expect(byAttr(r.toJSON() as TreeNode, "data-kimi-effort-note")).toHaveLength(0);
  });
});

// AGENT-AUTONOMY: the role form's autonomy select is next to permissionProfile; choosing "full"
// shows a note naming both what it silences (ask_human/ask_agent/ask_team, AskUserQuestion) and
// the explicit carve-out (the three forced-ask gates are untouched).
describe("RoleFormCard — autonomy field", () => {
  it("has a select field for autonomy, defaulting to \"\" (inherit \"ask\")", async () => {
    const r = await renderWith("claude");
    const field = byAttr(r.toJSON() as TreeNode, "data-field")
      .find((n) => n.props["data-field"] === "autonomy");
    expect(field).toBeTruthy();
    expect(field!.props["value"]).toBe("");
  });

  it("renders the carve-out note when autonomy is \"full\"", async () => {
    const r = await renderWithValues({ autonomy: "full" });
    const notes = byAttr(r.toJSON() as TreeNode, "data-autonomy-full-note");
    expect(notes).toHaveLength(1);
    const text = (notes[0]!.children as string[]).join("");
    expect(text).toContain("ask_human");
    expect(text).toContain("does not disable");
  });

  it("does not render the note when autonomy is unset", async () => {
    const r = await renderWithValues({ autonomy: "" });
    expect(byAttr(r.toJSON() as TreeNode, "data-autonomy-full-note")).toHaveLength(0);
  });
});
