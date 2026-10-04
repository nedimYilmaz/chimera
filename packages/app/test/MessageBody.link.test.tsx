import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

const openArtifactUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/rpc/bridge", () => ({ openArtifactUrl }));

const { MessageBody } = await import("../src/components/MessageBody");

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}

function render(text: string): TreeNode {
  let root: ReturnType<typeof create>;
  act(() => {
    root = create(<MessageBody text={text} done rawView={false} />);
  });
  return root!.toJSON() as unknown as TreeNode;
}

// CLICKABLE-LINKS: the transcript renderer's inline link span must never be a
// live <a> (that could navigate the app shell away from itself), must hand an
// http(s) url to the OS opener, and must leave a disallowed scheme inert.
describe("MessageBody link rendering", () => {
  it("never renders an <a> element for a link span", () => {
    const tree = render("see [docs](https://example.com/docs) for more");
    expect(findAll(tree, (n) => n.type === "a")).toHaveLength(0);
  });

  it("clicking an http(s) link span opens it via the opener command", async () => {
    openArtifactUrl.mockClear();
    const tree = render("see [docs](https://example.com/docs) for more");
    const [span] = findAll(tree, (n) => n.type === "span" && n.props["title"] === "https://example.com/docs");
    expect(span).toBeDefined();
    act(() => {
      (span!.props["onClick"] as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(openArtifactUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("stops propagation so a link click never also triggers the row click", () => {
    const tree = render("see [docs](https://example.com/docs) for more");
    const [span] = findAll(tree, (n) => n.type === "span" && n.props["title"] === "https://example.com/docs");
    const stopPropagation = vi.fn();
    act(() => {
      (span!.props["onClick"] as (e: { stopPropagation: () => void }) => void)({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("does not attach a click handler for a non-http(s) link span", () => {
    const tree = render("see [danger](javascript:alert) here");
    const [span] = findAll(tree, (n) => n.type === "span" && n.props["title"] === "javascript:alert");
    expect(span).toBeDefined();
    expect(span!.props["onClick"]).toBeUndefined();
  });
});

// BARE-URL-AUTOLINK — the transcript's main renderer (this component, not the
// minimal Markdown.tsx used for tool "result:" text) must autolink a plain
// https URL exactly like an explicit [text](url) span.
describe("MessageBody bare-URL autolink rendering", () => {
  it("gives a bare https URL a click handler that opens it via the opener command", async () => {
    openArtifactUrl.mockClear();
    const tree = render("see https://example.com/docs for more");
    const [span] = findAll(tree, (n) => n.type === "span" && n.props["title"] === "https://example.com/docs");
    expect(span).toBeDefined();
    act(() => {
      (span!.props["onClick"] as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(openArtifactUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("trims trailing sentence punctuation off a bare URL", () => {
    const tree = render("docs are at https://example.com/docs.");
    expect(findAll(tree, (n) => n.type === "span" && n.props["title"] === "https://example.com/docs")).toHaveLength(1);
    expect(findAll(tree, (n) => n.type === "span" && n.props["title"] === "https://example.com/docs.")).toHaveLength(0);
  });

  it("does not attach a click handler to a bare non-http(s) scheme (never autolinked)", () => {
    const tree = render("see file:///etc/passwd here");
    expect(findAll(tree, (n) => n.type === "span" && n.props["title"] === "file:///etc/passwd")).toHaveLength(0);
  });
});
