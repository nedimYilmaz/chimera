import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localLinkTarget } from "../src/components/linkUrl";
import { closePathViewer, pathViewerLocal, resetPathResolutionCache } from "../src/state/pathRefs";

const rpcCall = vi.fn(async (_method: string, { path }: { path: string }) => path.includes("missing") ? null : ({
  project: "chimera", relPath: path, result: { path, encoding: "utf8", content: "# Guide", binary: false, sizeBytes: 7, mediaType: null, truncated: false },
}));
const openArtifactUrl = vi.fn();
vi.mock("../src/rpc/bridge", () => ({ rpcCall, openArtifactUrl }));
const { MessageBody } = await import("../src/components/MessageBody");
const { Markdown } = await import("../src/components/Markdown");
let tree: ReactTestRenderer;
afterEach(() => { act(() => tree?.unmount()); closePathViewer(); resetPathResolutionCache(); vi.clearAllMocks(); });

for (const variant of ["transcript", "result"]) describe(`${variant} local Markdown links`, () => {
  async function render(text: string) {
    await act(async () => { tree = create(variant === "transcript" ? <MessageBody text={text} done rawView={false} /> : <Markdown text={text} />); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  it.each([
    ["/Users/alice/chimera/docs/design-workspace.md", null],
    ["/Users/alice/chimera/docs/quality/2026-09-15/design-workspace/design-split.png", null],
    ["<docs/My Guide.md:12>", 12],
    ["docs/My%20Guide.md:12:3", 12],
    ["README.md", null],
  ])("opens %s through the confined resolver", async (url, line) => {
    await render(`[Kullanım rehberi](${url})`);
    const link = tree.root.findByProps({ role: "button" });
    expect(link.children).toEqual(["Kullanım rehberi"]);
    expect(tree.root.findAllByType("a")).toHaveLength(0);
    act(() => link.props.onClick({ stopPropagation() {} }));
    expect(pathViewerLocal.getState().selected?.path).toBe(localLinkTarget(String(url))?.path);
    expect(pathViewerLocal.getState().line).toBe(line);
    expect(rpcCall).toHaveBeenCalledWith("fs.resolve", { path: localLinkTarget(String(url))?.path });
    expect(openArtifactUrl).not.toHaveBeenCalled();
  });
  it("supports keyboard activation and leaves unreadable files inert", async () => {
    await render("[Open](docs/guide.md) [Missing](docs/missing.md)");
    const links = tree.root.findAllByProps({ role: "button" });
    expect(links).toHaveLength(1);
    expect(links[0]!.props.tabIndex).toBe(0);
    act(() => links[0]!.props.onKeyDown({ key: "Enter", preventDefault() {}, stopPropagation() {}, repeat: false }));
    expect(pathViewerLocal.getState().selected?.path).toBe("docs/guide.md");
  });
});

it.each(["javascript:alert", "file:///tmp/test.md", "data:text/html,test", "//host/file.md", "#heading", "%00/tmp/file.md", "%ZZ", "vscode://file/tmp/test.md"])("does not reinterpret %s as a local file", (url) => {
  expect(localLinkTarget(url)).toBeNull();
});

it("drops the old clickable target while a streamed destination is resolving", async () => {
  await act(async () => { tree = create(<MessageBody text="[Guide](docs/old.md)" done rawView={false} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(tree.root.findAllByProps({ role: "button" })).toHaveLength(1);
  let finish!: (value: null) => void;
  rpcCall.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => { tree.update(<MessageBody text="[Guide](docs/missing.md)" done rawView={false} />); });
  expect(tree.root.findAllByProps({ role: "button" })).toHaveLength(0);
  await act(async () => { finish(null); });
  expect(tree.root.findAllByProps({ role: "button" })).toHaveLength(0);
});
