import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { PathPicker } from "../src/components/PathPicker";

// CWD-PICKER: the package's vitest config runs a bare node env (no jsdom,
// no `window` at all — see WorkflowFormCard.test.tsx's note on the same
// harness), which is exactly the "no Tauri runtime" case PathPicker must
// degrade gracefully under (same rule the DEV/browser mock bridge follows).
// This proves the fallback: the text input renders and stays fully
// functional, and the native "browse…" button is absent rather than
// rendered-but-broken.

type TreeNode = { type: string; props: Record<string, unknown>; children: TreeNode[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}

describe("PathPicker — fallback rendering (no Tauri runtime)", () => {
  it("renders the text input with the given value/placeholder and no browse button", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(PathPicker, { value: "/Users/dev/proj", onChange: () => {}, placeholder: "cwd" }),
      );
    });
    const tree = renderer.toJSON() as unknown as TreeNode[];
    const roots = Array.isArray(tree) ? tree : [tree];
    const inputs = roots.filter((n) => n.type === "input");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.props["value"]).toBe("/Users/dev/proj");
    expect(inputs[0]!.props["placeholder"]).toBe("cwd");
    const buttons = roots.filter((n) => n.type === "button");
    expect(buttons).toHaveLength(0);
  });

  it("typing in the input calls onChange with the new value (still editable without Tauri)", () => {
    let value = "";
    const onChange = (v: string) => { value = v; };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(PathPicker, { value: "", onChange }));
    });
    const tree = renderer.toJSON() as unknown as TreeNode[];
    const input = (Array.isArray(tree) ? tree : [tree]).find((n) => n.type === "input")!;
    act(() => {
      (input.props["onChange"] as (e: unknown) => void)({ target: { value: "~/code/proj" } });
    });
    expect(value).toBe("~/code/proj");
  });

  it("passes dataAttr through to the input as data-path-picker", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(PathPicker, { value: "", onChange: () => {}, dataAttr: "spawn-cwd" }),
      );
    });
    const tree = renderer.toJSON() as unknown as TreeNode[];
    const input = (Array.isArray(tree) ? tree : [tree]).find((n) => n.type === "input")!;
    expect(input.props["data-path-picker"]).toBe("spawn-cwd");
  });

  it("defaults to directory mode without requiring the mode prop", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(PathPicker, { value: "", onChange: () => {} }));
    });
    const tree = renderer.toJSON() as unknown as TreeNode[];
    const roots = Array.isArray(tree) ? tree : [tree];
    expect(roots.filter((n) => n.type === "input")).toHaveLength(1);
  });
});
