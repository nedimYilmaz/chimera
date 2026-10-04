import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// MD-FILE-VIEWER: the project file viewer showed a .md file as syntax-highlighted SOURCE — every
// `#`, `**` and table pipe on screen, in the one format this app already knows how to render.
//
// Same plain-node harness the other app render tests use (no jsdom). createPortal needs a document
// with a body, and Shiki must not be loaded for real.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {}, removeEventListener: () => {},
    setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
}
if (typeof document === "undefined") {
  (globalThis as unknown as { document: unknown }).document = { body: {}, documentElement: { style: {} } };
}
// Render the portal's children in place — the tree is what is under test, not where it mounts.
vi.mock("react-dom", () => ({ createPortal: (children: unknown) => children }));
vi.mock("../src/screens/fileHighlight", () => ({
  highlightFile: vi.fn(async () => null),
  HIGHLIGHT_LINE_CLASS: "hl",
}));

import { FileViewer } from "../src/screens/FileViewer";
import type { FsSelectedFile } from "../src/state/commands.projects";

const MD = "# Title\n\nsome **bold** prose\n";

const file = (path: string, content: string): FsSelectedFile => ({
  status: "ok",
  path,
  result: { content, binary: false, truncated: false, sizeBytes: content.length },
} as unknown as FsSelectedFile);

let mounted: ReturnType<typeof create> | null = null;
afterEach(() => { act(() => mounted?.unmount()); mounted = null; });

const render = (el: React.ReactElement): ReturnType<typeof create> => {
  act(() => { mounted = create(el); });
  return mounted!;
};
const has = (t: ReturnType<typeof create>, props: Record<string, unknown>): boolean => {
  try { t.root.findByProps(props); return true; } catch { return false; }
};

describe("a markdown file is RENDERED, not listed as source", () => {
  it("renders the document for a .md file", () => {
    const t = render(<FileViewer selected={file("/p/notes.md", MD)} onClose={() => {}} />);
    expect(has(t, { "data-file-viewer-markdown": true })).toBe(true);
    // and the raw markers are gone from what is shown
    expect(JSON.stringify(t.toJSON())).not.toContain("# Title");
    expect(JSON.stringify(t.toJSON())).toContain("Title");
  });

  it("leaves every other file as source — this is not a change to how code is shown", () => {
    const t = render(<FileViewer selected={file("/p/main.ts", "const a = 1;")} onClose={() => {}} />);
    expect(has(t, { "data-file-viewer-markdown": true })).toBe(false);
    expect(has(t, { "data-file-viewer-raw-toggle": true })).toBe(false);
  });

  it("offers a toggle back to the source, because that is what you want before editing", () => {
    const t = render(<FileViewer selected={file("/p/notes.md", MD)} onClose={() => {}} />);
    const toggle = t.root.findByProps({ "data-file-viewer-raw-toggle": true });
    act(() => toggle.props["onClick"]());
    expect(has(t, { "data-file-viewer-markdown": true })).toBe(false);
    expect(JSON.stringify(t.toJSON())).toContain("# Title");
  });

  it("shows the SOURCE when opened at a line — a rendered document has no line 42", () => {
    // Honouring the line and rendering the document are mutually exclusive; the line is the more
    // specific request, so it wins, and the toggle is disabled rather than silently ignored.
    const t = render(<FileViewer selected={file("/p/notes.md", MD)} onClose={() => {}} highlightLine={2} />);
    expect(has(t, { "data-file-viewer-markdown": true })).toBe(false);
    expect(t.root.findByProps({ "data-file-viewer-raw-toggle": true }).props["disabled"]).toBe(true);
  });
});
