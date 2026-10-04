import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { FsReadResult } from "@chimera/protocol";

// FILE-PATH-LINKS — end-to-end through the real tokenizer + MessageBody +
// PathLink, with a MOCKED bridge (project.list/fs.read) standing in for the
// daemon round-trip. Mirrors MessageBody.link.test.tsx's harness (same
// react-test-renderer + vi.mock("../src/rpc/bridge") shape) — PathLink's
// dynamic `import("../rpc/bridge")` is intercepted by vi.mock exactly like a
// static import would be.
const root = "/repo";
const okResult: FsReadResult = {
  path: "src/foo.ts",
  encoding: "utf8",
  content: "export const x = 1;\n",
  sizeBytes: 21,
  binary: false,
  mediaType: null,
  truncated: false,
};

// PATH-LINK-TILDE-AND-SCOPE: a "~"-path that lives outside `root`, standing
// in for the reported bug's exact shape — resolved via the widened-root fs.read
// call ({path}, no `project`), never via the registered-project ({project,path}) one.
const widenedPath = "~/Documents/acmecorp/cost-report-2026-08-07.md";
const widenedResult: FsReadResult = {
  path: "/Users/alice/Documents/acmecorp/cost-report-2026-08-07.md",
  encoding: "utf8",
  content: "# coh detail\n",
  sizeBytes: 13,
  binary: false,
  mediaType: null,
  truncated: false,
};

// PATH-LINK-ONE-ROUNDTRIP: one rendered link is ONE `fs.resolve`, answered by the daemon after it
// has walked the candidate roots itself. This used to be project.list plus an fs.read PER
// registered project, with every miss coming back as a rejection.
const rpcCall = vi.fn(async (method: string, params?: unknown) => {
  if (method === "fs.resolve") {
    const p = params as { path: string };
    if (p.path === `${root}/src/foo.ts` || p.path === "src/foo.ts") return { project: "demo", relPath: "src/foo.ts", result: okResult };
    if (p.path === widenedPath) return { project: null, relPath: widenedResult.path, result: widenedResult };
    return null;   // a miss is null, not a throw — the "render as plain text" case
  }
  throw new Error(`unexpected method ${method}`);
});
vi.mock("../src/rpc/bridge", () => ({ rpcCall }));

const openPathViewer = vi.fn();
vi.mock("../src/state/pathRefs", async () => {
  const actual = await vi.importActual<typeof import("../src/state/pathRefs")>("../src/state/pathRefs");
  return { ...actual, openPathViewer };
});

const { MessageBody } = await import("../src/components/MessageBody");
const { resetPathResolutionCache, resetProjectRootsCache, WIDENED_ROOT_LABEL } = await import("../src/state/pathRefs");

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}

function flatText(node: TreeNode | string | null): string {
  if (node === null) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(flatText).join("");
}

async function renderAsync(text: string): Promise<TreeNode> {
  let root: ReturnType<typeof create>;
  act(() => {
    root = create(React.createElement(MessageBody, { text, done: true, rawView: false }));
  });
  // flush the resolvePathRefCached microtask chain (project.list then fs.read)
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
  return root!.toJSON() as unknown as TreeNode;
}

describe("MessageBody path rendering (FILE-PATH-LINKS)", () => {
  it("renders a resolvable path as clickable accent text, never a live <a>, after it resolves", async () => {
    const tree = await renderAsync("see /repo/src/foo.ts for details");
    expect(findAll(tree, (n) => n.type === "a")).toHaveLength(0);
    const clickable = findAll(tree, (n) => n.type === "span" && n.props["title"] === "demo: src/foo.ts");
    expect(clickable).toHaveLength(1);
    expect(flatText(clickable[0]!)).toBe("/repo/src/foo.ts");
  });

  it("clicking the resolved span opens the path viewer with the already-fetched content — no second round-trip", async () => {
    openPathViewer.mockClear();
    rpcCall.mockClear();
    const tree = await renderAsync("see /repo/src/foo.ts for details");
    const [span] = findAll(tree, (n) => n.type === "span" && n.props["title"] === "demo: src/foo.ts");
    const callsBeforeClick = rpcCall.mock.calls.length;
    act(() => {
      (span!.props["onClick"] as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
    });
    expect(openPathViewer).toHaveBeenCalledWith("demo", "src/foo.ts", okResult, null);
    // click is synchronous against the cache — no additional RPC calls fired.
    expect(rpcCall.mock.calls.length).toBe(callsBeforeClick);
  });

  it("a non-existent path never becomes clickable — stays plain text", async () => {
    const tree = await renderAsync("see /repo/src/missing.ts for details");
    expect(findAll(tree, (n) => n.props["title"] === "demo: src/missing.ts")).toHaveLength(0);
    const spans = findAll(tree, (n) => n.type === "span");
    expect(spans.some((n) => flatText(n).includes("/repo/src/missing.ts"))).toBe(true);
  });

  it("a path outside every registered project root never becomes clickable", async () => {
    const tree = await renderAsync("see /etc/passwd for details");
    expect(findAll(tree, (n) => typeof n.props["title"] === "string" && (n.props["title"] as string).includes("passwd"))).toHaveLength(0);
  });

  it("parses this repo's path:line convention and threads the line through to openPathViewer", async () => {
    openPathViewer.mockClear();
    const tree = await renderAsync("see /repo/src/foo.ts:12 for details");
    const [span] = findAll(tree, (n) => n.type === "span" && n.props["title"] === "demo: src/foo.ts");
    expect(span).toBeDefined();
    act(() => {
      (span!.props["onClick"] as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
    });
    expect(openPathViewer).toHaveBeenCalledWith("demo", "src/foo.ts", okResult, 12);
  });

  // CODE-CHIP-PATHS: this used to assert that a backticked path is NEVER clickable. That was
  // backwards in practice — backticks are how people correctly write a path in markdown, so the
  // rule made the CORRECT form the only unclickable one, while the same path unquoted became a
  // link. What the rule was really protecting is that code renders LITERALLY, and that still
  // holds: the chip is still a <code>, still contains the exact text, and is still not turned
  // into a path SPAN. It only gains a click once the target is confirmed to exist.
  it("keeps a backticked path as literal code — and makes it openable once it resolves", async () => {
    const tree = await renderAsync("run `/repo/src/foo.ts` now");
    // not a path span: the text is untouched, inside a code element
    expect(findAll(tree, (n) => n.type === "span" && n.props["title"] === "demo: src/foo.ts")).toHaveLength(0);
    const chip = findAll(tree, (n) => n.type === "code").find((n) => flatText(n) === "/repo/src/foo.ts");
    expect(chip).toBeDefined();
    // ...and it opens the same viewer a plain path link would
    openPathViewer.mockClear();
    act(() => {
      (chip!.props["onClick"] as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
    });
    expect(openPathViewer).toHaveBeenCalledWith("demo", "src/foo.ts", okResult, null);
  });

  it("leaves ordinary inline code exactly as it was — no title, no click, no request", async () => {
    // The filter that keeps this cheap: most inline code in a technical transcript is not a path,
    // and resolving each chip would be a daemon request per chip per message.
    const tree = await renderAsync("call `foo()` then `--flag`");
    for (const t of ["foo()", "--flag"]) {
      const chip = findAll(tree, (n) => n.type === "code").find((n) => flatText(n) === t);
      expect(chip, t).toBeDefined();
      expect(chip!.props["onClick"], t).toBeUndefined();
    }
  });

  // PATH-LINK-TILDE-AND-SCOPE — the reported bug's exact shape: a "~"-path
  // outside every registered project root (here `root` is "/repo", the
  // widened path is under "/Users/alice/...") still resolves clickable via
  // the widened-root fs.read call, and opens the SAME FileViewer/PathViewerCard.
  it("a ~-path outside every registered project resolves clickable via the widened-root fallback, and opens the viewer on click", async () => {
    openPathViewer.mockClear();
    const tree = await renderAsync(`see ${widenedPath} for details`);
    const clickable = findAll(tree, (n) => n.type === "span" && n.props["title"] === `${WIDENED_ROOT_LABEL}: ${widenedResult.path}`);
    expect(clickable).toHaveLength(1);
    expect(flatText(clickable[0]!)).toBe(widenedPath);
    act(() => {
      (clickable[0]!.props["onClick"] as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
    });
    expect(openPathViewer).toHaveBeenCalledWith(WIDENED_ROOT_LABEL, widenedResult.path, widenedResult, null);
  });

  it("a ~-path that resolves outside every allowed root (e.g. ~/.ssh/id_rsa) never becomes clickable", async () => {
    const tree = await renderAsync("see ~/.ssh/id_rsa for details");
    expect(findAll(tree, (n) => typeof n.props["title"] === "string" && (n.props["title"] as string).includes("id_rsa"))).toHaveLength(0);
    const spans = findAll(tree, (n) => n.type === "span");
    expect(spans.some((n) => flatText(n).includes("~/.ssh/id_rsa"))).toBe(true);
  });
});

// Each test above shares the module-level resolution/project caches
// (pathRefs.ts is a session singleton by design) — reset between tests so an
// earlier test's cached resolution/project list never leaks into a later one.
afterEach(() => {
  resetPathResolutionCache();
  resetProjectRootsCache();
});
