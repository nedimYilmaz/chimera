import { describe, expect, it } from "vitest";
import type { FsReadResult } from "@chimera/protocol";
import { classifyFileView, languageForPath, truncationBannerText, type FileView } from "../src/state/selectors.fileviewer";
import type { FsSelectedFile } from "../src/state/commands.projects";

const okResult = (overrides: Partial<FsReadResult> = {}): FsReadResult => ({
  path: "src/main.rs",
  encoding: "utf8",
  content: "fn main() {}",
  sizeBytes: 12,
  binary: false,
  mediaType: null,
  truncated: false,
  ...overrides,
});

describe("languageForPath", () => {
  it("maps common code extensions to shiki language ids", () => {
    expect(languageForPath("src/main.rs")).toBe("rust");
    expect(languageForPath("app/tool.py")).toBe("python");
    expect(languageForPath("src/index.ts")).toBe("typescript");
    expect(languageForPath("components/Foo.tsx")).toBe("tsx");
  });

  it("recognizes extension-less conventional filenames", () => {
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
    expect(languageForPath("nested/Makefile")).toBe("makefile");
  });

  it("returns null for an unmapped extension or a dotfile", () => {
    expect(languageForPath("data.xyz")).toBeNull();
    expect(languageForPath(".gitignore")).toBeNull();
    expect(languageForPath("README")).toBeNull();
  });
});

describe("classifyFileView — routes an FsSelectedFile to a viewer pane", () => {
  it("text → the text pane, with a shiki lang derived from the path", () => {
    const selected: FsSelectedFile = { path: "src/main.rs", status: "ok", result: okResult() };
    const view = classifyFileView(selected);
    expect(view).toEqual<FileView>({
      kind: "text",
      content: "fn main() {}",
      lang: "rust",
      truncated: false,
      sizeBytes: 12,
      shownBytes: 12,
    });
  });

  it("image (binary + a known image mediaType) → the image pane", () => {
    const selected: FsSelectedFile = {
      path: "assets/logo.png",
      status: "ok",
      result: okResult({ binary: true, mediaType: "image/png", content: "iVBORw0KGgo=", encoding: "base64", sizeBytes: 9 }),
    };
    const view = classifyFileView(selected);
    expect(view).toEqual<FileView>({ kind: "image", mediaType: "image/png", data: "iVBORw0KGgo=" });
  });

  it("binary (binary, no mediaType) → the binary placeholder pane", () => {
    const selected: FsSelectedFile = {
      path: "bin/tool",
      status: "ok",
      result: okResult({ binary: true, mediaType: null, content: "", sizeBytes: 40960 }),
    };
    const view = classifyFileView(selected);
    expect(view).toEqual<FileView>({ kind: "binary", sizeBytes: 40960 });
  });

  it("error status → the error pane", () => {
    const selected: FsSelectedFile = { path: "src/gone.ts", status: "error", message: "no such file or directory" };
    expect(classifyFileView(selected)).toEqual<FileView>({ kind: "error", message: "no such file or directory" });
  });

  it("a truncated read carries truncated + the shown/full byte counts through", () => {
    const selected: FsSelectedFile = {
      path: "logs/huge.log",
      status: "ok",
      result: okResult({ content: "a".repeat(2_000_000), sizeBytes: 5_000_000, truncated: true }),
    };
    const view = classifyFileView(selected);
    expect(view.kind).toBe("text");
    if (view.kind !== "text") throw new Error("unreachable");
    expect(view.truncated).toBe(true);
    expect(view.shownBytes).toBe(2_000_000);
    expect(view.sizeBytes).toBe(5_000_000);
  });
});

describe("truncationBannerText", () => {
  it("null when the read wasn't truncated", () => {
    const view = classifyFileView({ path: "a.ts", status: "ok", result: okResult() });
    if (view.kind !== "text") throw new Error("unreachable");
    expect(truncationBannerText(view)).toBeNull();
  });

  it("reports first-shown-of-total bytes, human formatted, when truncated", () => {
    const view = classifyFileView({
      path: "huge.log",
      status: "ok",
      result: okResult({ content: "a".repeat(2 * 1024 * 1024), sizeBytes: 5 * 1024 * 1024, truncated: true }),
    });
    if (view.kind !== "text") throw new Error("unreachable");
    expect(truncationBannerText(view)).toBe("truncated — first 2.0M of 5.0M");
  });
});
