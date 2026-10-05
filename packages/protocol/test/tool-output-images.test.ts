import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ToolOutputImageSchema, ToolOutputImagesSchema, TOOL_OUTPUT_IMAGE_MAX_BYTES, imageDecodedBytes } from "@chimera/protocol";
const fixture = JSON.parse(readFileSync(new URL("../../core/test/fixtures/codex-image-generation.json", import.meta.url), "utf8"));
const image = { mediaType: "image/png", data: fixture.result };
describe("tool output image contract", () => {
  it("allows only bounded canonical raster data", () => {
    expect(ToolOutputImageSchema.safeParse(image).success).toBe(true);
    for (const candidate of [{ ...image, mediaType: "image/jpeg" }, { ...image, data: "abcd" }, { ...image, data: image.data + "\n" }, { ...image, data: Buffer.from("<svg></svg>").toString("base64") }]) {
      expect(ToolOutputImageSchema.safeParse(candidate).success).toBe(false);
    }
  });
  it("bounds count and decoded aggregate size", () => {
    expect(ToolOutputImagesSchema.safeParse(Array(5).fill(image)).success).toBe(false);
    const bytes = Buffer.alloc(TOOL_OUTPUT_IMAGE_MAX_BYTES); Buffer.from(image.data, "base64").copy(bytes);
    const large = { ...image, data: bytes.toString("base64") };
    expect(imageDecodedBytes(large.data)).toBe(TOOL_OUTPUT_IMAGE_MAX_BYTES);
    expect(ToolOutputImagesSchema.safeParse([large, large]).success).toBe(true);
    expect(ToolOutputImagesSchema.safeParse([large, large, image]).success).toBe(false);
  });
});
