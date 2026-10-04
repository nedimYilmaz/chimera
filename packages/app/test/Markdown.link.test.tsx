import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

const openArtifactUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/rpc/bridge", () => ({ openArtifactUrl }));

const { Markdown } = await import("../src/components/Markdown");

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}

// CLICKABLE-LINKS: proves the existing no-anchor guarantee still holds after
// wiring links up to the OS opener — a live <a> in the webview could
// navigate the app shell away from itself, so the renderer must never emit one.
describe("Markdown link rendering", () => {
  it("never renders an <a> element for a link span", () => {
    let root: ReturnType<typeof create>;
    act(() => {
      root = create(<Markdown text="see [docs](https://example.com/docs) for more" />);
    });
    const tree = root!.toJSON() as unknown as TreeNode;
    expect(findAll(tree, (n) => n.type === "a")).toHaveLength(0);
  });

  it("clicking an http(s) link span opens it via the opener command", async () => {
    let root: ReturnType<typeof create>;
    act(() => {
      root = create(<Markdown text="see [docs](https://example.com/docs) for more" />);
    });
    const tree = root!.toJSON() as unknown as TreeNode;
    const [span] = findAll(tree, (n) => n.type === "span" && n.props["title"] === "https://example.com/docs");
    expect(span).toBeDefined();
    act(() => {
      (span!.props["onClick"] as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(openArtifactUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("does not attach a click handler for a non-http(s) link span", () => {
    let root: ReturnType<typeof create>;
    act(() => {
      root = create(<Markdown text="see [danger](javascript:alert) here" />);
    });
    const tree = root!.toJSON() as unknown as TreeNode;
    const [span] = findAll(tree, (n) => n.type === "span" && n.props["title"] === "javascript:alert");
    expect(span).toBeDefined();
    expect(span!.props["onClick"]).toBeUndefined();
  });
});

// BARE-URL-AUTOLINK — a plain https URL with no [text](url) wrapper gets the
// same openable class/click handler as an explicit markdown link.
describe("Markdown bare-URL autolink rendering", () => {
  it("gives a bare https URL the openable class and a click handler", async () => {
    let root: ReturnType<typeof create>;
    act(() => {
      root = create(<Markdown text="see https://example.com/docs for more" />);
    });
    const tree = root!.toJSON() as unknown as TreeNode;
    const [span] = findAll(tree, (n) => n.type === "span" && n.props["title"] === "https://example.com/docs");
    expect(span).toBeDefined();
    expect(String(span!.props["className"])).toContain("linkOpenable");
    act(() => {
      (span!.props["onClick"] as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(openArtifactUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("does not attach a click handler or openable class to a bare non-http(s) scheme", () => {
    let root: ReturnType<typeof create>;
    act(() => {
      root = create(<Markdown text="see file:///etc/passwd here" />);
    });
    const tree = root!.toJSON() as unknown as TreeNode;
    // A bare file: URL never autolinks (only http/https do) — it stays plain text,
    // so there is no link span with that title at all.
    const spans = findAll(tree, (n) => n.type === "span" && n.props["title"] === "file:///etc/passwd");
    expect(spans).toHaveLength(0);
  });
});
