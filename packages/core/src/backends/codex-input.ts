import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, Image } from "../backend.js";

export type CodexInput = string | Array<{ type: "text"; text: string } | { type: "local_image"; path: string }>;
export type CodexTurnInput = { text: string; images?: Image[]; content?: ContentBlock[]; preamble?: string };

// The SDK accepts local paths only. Materialize attachments just for the active
// turn, outside the checkout, and never retain base64 in CLI arguments or logs.
export function prepareCodexInput(turn: CodexTurnInput): { input: CodexInput; cleanup: () => void } {
  const blocks: ContentBlock[] = turn.content?.length
    ? turn.content
    : [{ type: "text", text: turn.text }, ...(turn.images ?? []).map((img) => ({ type: "image" as const, ...img }))];
  let directory: string | undefined;
  const cleanup = () => { if (directory) rmSync(directory, { recursive: true, force: true }); };
  try {
    if (!blocks.some((b) => b.type === "image")) {
      const text = blocks.map((b) => b.type === "text" ? b.text : "").join("\n\n");
      return { input: turn.preamble ? `${turn.preamble}\n\n${text}` : text, cleanup };
    }
    directory = mkdtempSync(join(tmpdir(), "chimera-codex-input-"));
    const input: Exclude<CodexInput, string> = turn.preamble ? [{ type: "text", text: turn.preamble }] : [];
    for (const [index, block] of blocks.entries()) {
      if (block.type === "text") input.push(block);
      else {
        const path = join(directory, `${index}.${block.mediaType.split("/")[1]}`);
        writeFileSync(path, Buffer.from(block.data, "base64"), { mode: 0o600 });
        input.push({ type: "local_image", path });
      }
    }
    return { input, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
