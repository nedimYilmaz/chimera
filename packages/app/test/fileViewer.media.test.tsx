import { afterEach, expect, it, vi } from "vitest";
import React from "react";
import { act, create } from "react-test-renderer";
import type { FsSelectedFile } from "../src/state/commands.projects";

vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
vi.stubGlobal("document", { body: {}, documentElement: { style: {} } });
vi.mock("react-dom", () => ({ createPortal: (children: unknown) => children }));
vi.mock("../src/rpc/bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/rpc/bridge")>(),
  prepareLocalMedia: vi.fn(), openLocalFile: vi.fn(),
}));
import { prepareLocalMedia, openLocalFile } from "../src/rpc/bridge";
import { FileViewer } from "../src/screens/FileViewer";

const file = (name = "movie.mp4", mediaType = "video/mp4"): FsSelectedFile => ({ path: name, status: "ok", result: {
  path: name, absolutePath: `/project/${name}`, binary: true, mediaType, content: "", encoding: "utf8", sizeBytes: 500, truncated: false,
} });
let tree: ReturnType<typeof create>;
afterEach(() => { act(() => tree?.unmount()); vi.clearAllMocks(); });
async function render(selected = file()) {
  await act(async () => { tree = create(<FileViewer selected={selected} onClose={() => {}} />); });
}

it("uses canonical paths, displays video controls and recovers from a codec error", async () => {
  vi.mocked(prepareLocalMedia).mockResolvedValue("asset://movie");
  await render();
  expect(prepareLocalMedia).toHaveBeenCalledWith("/project/movie.mp4");
  const video = tree.root.findByType("video");
  expect(video.props).toMatchObject({ controls: true, preload: "metadata", src: "asset://movie" });
  expect(video.props.autoPlay).toBeUndefined();
  act(() => video.props.onError());
  expect(tree.root.findAllByType("video")).toHaveLength(0);
  expect(tree.root.findByProps({ "data-media-fallback": true })).toBeTruthy();
  await act(async () => { await tree.root.findByProps({ "data-file-open": true }).props.onClick(); });
  expect(openLocalFile).toHaveBeenCalledWith("/project/movie.mp4", false);
});

it("opens unsupported documents externally or reveals them, without requesting a media grant", async () => {
  await render(file("slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"));
  expect(prepareLocalMedia).not.toHaveBeenCalled();
  await act(async () => { await tree.root.findByProps({ "data-file-reveal": true }).props.onClick(); });
  expect(openLocalFile).toHaveBeenCalledWith("/project/slides.pptx", true);
});

it("keeps a native open failure visible and recoverable", async () => {
  vi.mocked(openLocalFile).mockRejectedValueOnce(new Error("gone"));
  await render(file("report.pdf", "application/pdf"));
  await act(async () => { await tree.root.findByProps({ "data-file-open": true }).props.onClick(); });
  expect(tree.root.findByProps({ role: "alert" }).children.join("")).toContain("Show in folder");
  expect(tree.root.findByProps({ "data-file-reveal": true }).props.disabled).toBe(false);
});

it("does not attach a stale video URL after switching files", async () => {
  let finish!: (url: string) => void;
  vi.mocked(prepareLocalMedia).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  await act(async () => { tree.update(<FileViewer selected={file("report.pdf", "application/pdf")} onClose={() => {}} />); });
  await act(async () => { finish("asset://stale"); });
  expect(tree.root.findAllByType("video")).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).not.toContain("asset://stale");
});
