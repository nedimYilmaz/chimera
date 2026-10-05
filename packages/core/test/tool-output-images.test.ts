import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeCodexEvent } from "@chimera/core/backends/codex";
import { outputImage, toolResultImages, toolResultImageFields, withoutRawImages, TOOL_OUTPUT_IMAGE_MAX_BYTES } from "@chimera/core/backends/tool-result-images";
import type { BackendEvent } from "@chimera/core/backend";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaPgPAAIDAYAkYfWXAAAAAElFTkSuQmCC";
const image = { mediaType: "image/png", data: png };
const events = (item: Record<string, unknown>, type = "item.completed") => {
  const result = normalizeCodexEvent({ type, item });
  return (Array.isArray(result) ? result : result ? [result] : []) as BackendEvent[];
};

describe("bounded tool output images", () => {
  it("preserves MCP, Claude, dynamic and function-output image carriers", () => {
    for (const block of [
      { type: "image", mimeType: "image/png", data: png },
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
      { type: "inputImage", imageUrl: `data:image/png;base64,${png}` },
      { type: "input_image", image_url: `data:image/png;base64,${png}` },
    ]) expect(toolResultImages([block])).toEqual([image]);
  });
  it("rejects invalid base64, mismatched MIME, SVG, external URLs and oversized images", () => {
    expect(outputImage("not base64")).toBeUndefined();
    expect(outputImage(png, "image/jpeg")).toBeUndefined();
    expect(outputImage(Buffer.from("<svg/>").toString("base64"), "image/svg+xml")).toBeUndefined();
    expect(toolResultImages([{ type: "inputImage", imageUrl: "https://example.com/a.png" }])).toEqual([]);
    const large = Buffer.alloc(TOOL_OUTPUT_IMAGE_MAX_BYTES + 1); Buffer.from(png, "base64").copy(large);
    expect(outputImage(large.toString("base64"), "image/png")).toBeUndefined();
    expect(toolResultImageFields([{ type: "image", mimeType: "image/png", data: large.toString("base64") }])).toEqual({ imageOutputWarnings: ["too-large"] });
  });
  it("bounds image count and aggregate decoded bytes", () => {
    expect(toolResultImages(Array(12).fill({ type: "image", mimeType: "image/png", data: png }))).toHaveLength(4);
    expect(toolResultImageFields(Array(5).fill({ type: "image", mimeType: "image/png", data: png })).imageOutputWarnings).toEqual(["too-many"]);
    const large = Buffer.alloc(TOOL_OUTPUT_IMAGE_MAX_BYTES); Buffer.from(png, "base64").copy(large);
    expect(toolResultImages(Array(4).fill({ type: "image", mimeType: "image/png", data: large.toString("base64") }))).toHaveLength(2);
  });
  it("omits rejected and accepted binary payloads in raw diagnostics", () => {
    const raw = { item: { type: "imageGeneration", result: "x".repeat(1000), id: "gen" }, content: [{ type: "image", data: png, mimeType: "image/png" }] };
    const safe = JSON.stringify(withoutRawImages(raw));
    expect(safe).not.toContain(png); expect(safe).not.toContain("x".repeat(1000)); expect(safe).toContain('"id":"gen"');
  });
});

describe("Codex image-output regression", () => {
  it("pairs a completed native imageGeneration with a tool row even without a start", () => {
    const item = { type: "imageGeneration", id: "generated", status: "completed", revisedPrompt: "a dot", result: png, failure: null };
    const rows = events(item);
    expect(rows.map(e => e.kind)).toEqual(["tool_call", "tool_result"]);
    expect(rows[1]!.data).toMatchObject({ toolId: "generated", images: [image] });
    expect(JSON.stringify(rows.map(e => e.raw))).not.toContain(png);
  });
  it("preserves correlation and images for MCP and dynamic results", () => {
    for (const item of [
      { type: "mcp_tool_call", id: "m", server: "s", tool: "t", result: { content: [{ type: "image", mimeType: "image/png", data: png }] } },
      { type: "dynamicToolCall", id: "m", tool: "t", contentItems: [{ type: "inputImage", imageUrl: `data:image/png;base64,${png}` }] },
    ]) {
      const result = events(item).find(e => e.kind === "tool_result")!;
      expect(result.data).toMatchObject({ toolId: "m", images: [image] });
      expect(JSON.stringify(result.raw)).not.toContain(png);
    }
  });
  it("does not fabricate a preview on native failure or invalid result", () => {
    const rows = events({ type: "imageGeneration", id: "bad", status: "failed", result: "", failure: { type: "usageLimitExceeded", limitId: "image_generation", resetsAt: null } });
    expect(rows.at(-1)!.data).toMatchObject({ isError: true });
    expect(rows.at(-1)!.data.images).toBeUndefined();
  });
  it.skipIf(!process.env.CHIMERA_TEST_IMAGE_OUTPUT_FIXTURE)("preserves the actual generated image captured through installed CLI thread/items/list", () => {
    const item = JSON.parse(readFileSync(process.env.CHIMERA_TEST_IMAGE_OUTPUT_FIXTURE!, "utf8"));
    expect(item.type).toBe("imageGeneration");
    const result = events(item).find(e => e.kind === "tool_result")!;
    expect(result.data.images).toEqual([{ mediaType: "image/png", data: item.result }]);
    expect(JSON.stringify(result.raw)).not.toContain(item.result);
  });
});
