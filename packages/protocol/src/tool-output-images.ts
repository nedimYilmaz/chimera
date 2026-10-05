import { z } from "zod";

export const TOOL_OUTPUT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const TOOL_OUTPUT_IMAGES_MAX_BYTES = 10 * 1024 * 1024;
export const TOOL_OUTPUT_IMAGES_MAX_COUNT = 4;
export const TOOL_OUTPUT_IMAGE_MAX_BASE64_CHARS = Math.ceil(TOOL_OUTPUT_IMAGE_MAX_BYTES / 3) * 4;
export const ToolOutputImageWarningSchema = z.enum(["invalid-or-unsupported", "too-large", "too-many", "total-too-large"]);
export type ToolOutputImageWarning = z.infer<typeof ToolOutputImageWarningSchema>;
export const ToolOutputImageWarningsSchema = z.array(ToolOutputImageWarningSchema).max(4);

export function imageDecodedBytes(data: string): number {
  return data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

// This module runs in both Node and the browser; validate before decoding so replaying
// old or foreign events cannot allocate arbitrary binary payloads. Actual decoding remains
// the image element's job; signature validation prevents active SVG/HTML content.
export function validToolOutputRaster(data: string, mediaType: string): boolean {
  if (!data.length || data.length > TOOL_OUTPUT_IMAGE_MAX_BASE64_CHARS || data.length % 4 !== 0 || imageDecodedBytes(data) > TOOL_OUTPUT_IMAGE_MAX_BYTES) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false;
  try {
    const raw = atob(data);
    if (btoa(raw) !== data) return false;
    const b = (i: number) => raw.charCodeAt(i);
    if (mediaType === "image/png") return raw.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b(i) === v) && raw.slice(12, 16) === "IHDR";
    if (mediaType === "image/jpeg") return raw.length >= 4 && b(0) === 255 && b(1) === 216 && b(2) === 255;
    if (mediaType === "image/gif") return raw.length >= 10 && ["GIF87a", "GIF89a"].includes(raw.slice(0, 6));
    if (mediaType === "image/webp") return raw.length >= 12 && raw.slice(0, 4) === "RIFF" && raw.slice(8, 12) === "WEBP";
  } catch { return false; }
  return false;
}

export const ToolOutputImageSchema = z.object({
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z.string().max(TOOL_OUTPUT_IMAGE_MAX_BASE64_CHARS),
}).strict().refine(image => validToolOutputRaster(image.data, image.mediaType), "invalid raster image");
export type ToolOutputImage = z.infer<typeof ToolOutputImageSchema>;
export const ToolOutputImagesSchema = z.array(ToolOutputImageSchema).max(TOOL_OUTPUT_IMAGES_MAX_COUNT)
  .refine(images => images.reduce((bytes, image) => bytes + imageDecodedBytes(image.data), 0) <= TOOL_OUTPUT_IMAGES_MAX_BYTES, "image payload exceeds aggregate bound");
