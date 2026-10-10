import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, truncateSync, realpathSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, readAtWidenedRoot, FileTooLargeError } from "../src/fsbrowse.js";
import { ARTIFACT_MAX_BYTES } from "../src/artifacts.js";
import { FsReadResult } from "@chimera/protocol";

const dirs: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), "chimera-media-")); dirs.push(path); return path; };
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("local media metadata", () => {
  it.each([["clip.MP4", "video/mp4"], ["clip.mov", "video/quicktime"], ["clip.webm", "video/webm"], ["voice.mp3", "audio/mpeg"], ["sound.wav", "audio/wav"], ["report.pdf", "application/pdf"], ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]])("resolves %s without serializing large file bytes", (name, mediaType) => {
    const root = directory(), path = join(root, name);
    writeFileSync(path, "fixture"); truncateSync(path, ARTIFACT_MAX_BYTES + 1);
    const result = FsReadResult.parse(readFile(root, name));
    expect(result).toMatchObject({ absolutePath: realpathSync(path), content: "", sizeBytes: ARTIFACT_MAX_BYTES + 1, binary: true, mediaType, truncated: false });
    expect(readAtWidenedRoot(path, [root])).toMatchObject({ absolutePath: realpathSync(path), content: "" });
  });
  it("keeps root confinement and the non-media payload cap", () => {
    const root = directory(), other = directory(), outside = join(other, "private.mp4");
    writeFileSync(outside, "outside");
    expect(() => readFile(root, outside)).toThrow(/escapes/);
    expect(() => readAtWidenedRoot(outside, [root])).toThrow(/outside/);
    expect(() => readFile(root, ".")).toThrow(/not a file/);
    const text = join(root, "large.txt"); writeFileSync(text, "x"); truncateSync(text, ARTIFACT_MAX_BYTES + 1);
    expect(() => readFile(root, "large.txt")).toThrow(FileTooLargeError);
  });
  it.skipIf(process.platform === "win32")("rejects media symlink escapes", () => {
    const root = directory(), outside = join(directory(), "private.mp4"); writeFileSync(outside, "secret");
    symlinkSync(outside, join(root, "clip.mp4"));
    expect(() => readFile(root, "clip.mp4")).toThrow(/escapes/);
  });
});
