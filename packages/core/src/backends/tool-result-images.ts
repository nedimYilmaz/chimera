import type { Image } from "../backend.js";
import { TOOL_OUTPUT_IMAGE_MAX_BYTES, TOOL_OUTPUT_IMAGES_MAX_BYTES, TOOL_OUTPUT_IMAGES_MAX_COUNT, TOOL_OUTPUT_IMAGE_MAX_BASE64_CHARS, ToolOutputImageSchema, imageDecodedBytes, type ToolOutputImageWarning } from "@chimera/protocol";
export { TOOL_OUTPUT_IMAGE_MAX_BYTES, TOOL_OUTPUT_IMAGES_MAX_BYTES, TOOL_OUTPUT_IMAGES_MAX_COUNT } from "@chimera/protocol";

const MAX_BASE64_CHARS = TOOL_OUTPUT_IMAGE_MAX_BASE64_CHARS;

function rasterType(bytes: Buffer): Image["mediaType"] | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

// Reject before decoding: tool results are untrusted and can otherwise allocate arbitrary
// amounts of binary memory. Checking signatures also keeps SVG/HTML out of image viewers.
export function outputImage(data: unknown, mediaType?: unknown): Image | undefined {
  if (typeof data !== "string" || !data.length || data.length > MAX_BASE64_CHARS || data.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return undefined;
  const detected = rasterType(Buffer.from(data.slice(0, 64), "base64"));
  if (!detected || mediaType !== undefined && mediaType !== detected) return undefined;
  const parsed = ToolOutputImageSchema.safeParse({ mediaType: detected, data });
  return parsed.success ? parsed.data : undefined;
}

function dataUrlImage(url: unknown): Image | undefined {
  if (typeof url !== "string" || url.length > MAX_BASE64_CHARS + 40) return undefined;
  const comma = url.indexOf(",");
  if (comma < 0) return undefined;
  const prefix = url.slice(0, comma);
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64$/.exec(prefix);
  return match ? outputImage(url.slice(comma + 1), match[1]) : undefined;
}

// Shapes verified against MCP ImageContent, Anthropic base64 ImageBlockParam and the
// installed Codex DynamicToolCallOutputContentItem/FunctionCallOutputContentItem schemas.
export function toolResultImageFields(content: unknown): { images?: Image[]; imageOutputWarnings?: ToolOutputImageWarning[] } {
  if (!Array.isArray(content)) return {};
  const warnings = new Set<ToolOutputImageWarning>();
  const images: Image[] = [];
  let totalBytes = 0;
  for (const value of content) {
    if (!value || typeof value !== "object") continue;
    const block = value as Record<string, any>;
    let image: Image | undefined;
    if (block.type === "image") {
      image = block.source?.type === "base64"
        ? outputImage(block.source.data, block.source.media_type)
        : outputImage(block.data, block.mimeType);
    } else if (block.type === "inputImage") image = dataUrlImage(block.imageUrl);
    else if (block.type === "input_image") image = dataUrlImage(block.image_url);
    if (!["image", "inputImage", "input_image"].includes(block.type)) continue;
    const data = block.data ?? block.source?.data ?? block.imageUrl ?? block.image_url;
    const base64 = typeof data === "string" && data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
    if (!image) {
      warnings.add(typeof base64 === "string" && (base64.length > MAX_BASE64_CHARS || imageDecodedBytes(base64) > TOOL_OUTPUT_IMAGE_MAX_BYTES) ? "too-large" : "invalid-or-unsupported");
      continue;
    }
    if (images.length === TOOL_OUTPUT_IMAGES_MAX_COUNT) { warnings.add("too-many"); break; }
    const size = Buffer.byteLength(image.data, "base64");
    if (totalBytes + size > TOOL_OUTPUT_IMAGES_MAX_BYTES) { warnings.add("total-too-large"); continue; }
    images.push(image); totalBytes += size;
  }
  return { ...(images.length ? { images } : {}), ...(warnings.size ? { imageOutputWarnings: [...warnings] } : {}) };
}

export function toolResultImages(content: unknown): Image[] {
  return toolResultImageFields(content).images ?? [];
}

// Keep provider diagnostics while removing duplicate/rejected binary carriers from raw
// event persistence. In particular an oversized rejected image must not survive in raw.
export function withoutRawImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRawImages);
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const image = ["image", "inputImage", "input_image", "imageGeneration"].includes(String(row.type))
    || row.type === "Extension" && row.kind === "image_gen.generation";
  const binaryKeys = image ? new Set(["data", "source", "imageUrl", "image_url", "result"]) : undefined;
  return Object.fromEntries(Object.entries(row).map(([key, item]) => [key,
    binaryKeys?.has(key) ? "[image payload omitted]" : withoutRawImages(item),
  ]));
}
