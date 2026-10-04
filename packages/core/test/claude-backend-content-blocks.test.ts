import { describe, it, expect } from "vitest";
import { AgentSpecSchema, type ContentBlock } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { ResolvedAgentSpec } from "@chimera/core/backend";
import { REPO_BACKED_CWD } from "./repo-backed-cwd.js";

// D9 (F13 composer wire): userMessage(text, images?, content?) — when `content` is
// non-empty it takes over entirely, mapping blocks 1:1 IN ORDER so an image referenced
// mid-sentence lands at that exact position instead of the legacy text-then-images
// bunching. `text`/`images` (the pre-D9 shape) must keep working unchanged.

function recordingQuery() {
  const received: Array<{ message: { role: string; content: Array<Record<string, unknown>> } }> = [];
  const fn = ((args: never) => {
    const input = (args as { prompt: AsyncIterable<{ message: { role: string; content: Array<Record<string, unknown>> } }> }).prompt;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const m of input) {
          received.push(m);
          yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0 };
        }
      },
      interrupt: async () => {},
    };
  }) as never;
  return { fn, received };
}

function spec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: REPO_BACKED_CWD, isolation: "none", ...over }),
    agentId: "ag-1", accountName: "main", resolvedProvider: "claude",
    env: { CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("ClaudeAgentBackend: interleaved content[] blocks (D9)", () => {
  it("a mid-sentence content[] send lands two images at their exact referenced positions", async () => {
    const { fn, received } = recordingQuery();
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true }), () => {}, async () => true);
    await settle();
    const content: ContentBlock[] = [
      { type: "text", text: "look at " },
      { type: "image", mediaType: "image/png", data: "AAA" },
      { type: "text", text: " and also " },
      { type: "image", mediaType: "image/jpeg", data: "BBB" },
      { type: "text", text: " thanks" },
    ];
    await h.send("look at [img] and also [img] thanks", undefined, content);
    await settle();
    expect(received[1]!.message.content).toEqual([
      { type: "text", text: "look at " },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
      { type: "text", text: " and also " },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBB" } },
      { type: "text", text: " thanks" },
    ]);
  });

  it("the initial spawn prompt honors spec.content, mapping blocks in order", async () => {
    const { fn, received } = recordingQuery();
    const content: ContentBlock[] = [
      { type: "text", text: "before " },
      { type: "image", mediaType: "image/gif", data: "CCC" },
      { type: "text", text: " after" },
    ];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true, content }), () => {}, async () => true);
    await settle();
    expect(received[0]!.message.content).toEqual([
      { type: "text", text: "before " },
      { type: "image", source: { type: "base64", media_type: "image/gif", data: "CCC" } },
      { type: "text", text: " after" },
    ]);
  });

  it("an explicit empty content[] array falls back to the legacy text/images path", async () => {
    const { fn, received } = recordingQuery();
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true }), () => {}, async () => true);
    await settle();
    await h.send("plain", [{ mediaType: "image/png", data: "X" }], []);
    await settle();
    expect(received[1]!.message.content).toEqual([
      { type: "text", text: "plain" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "X" } },
    ]);
  });

  it("legacy {text, images[]} calls (no content arg) still bunch images after the text block, unchanged", async () => {
    const { fn, received } = recordingQuery();
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true }), () => {}, async () => true);
    await settle();
    await h.send("legacy", [{ mediaType: "image/webp", data: "Y" }]);
    await settle();
    expect(received[1]!.message.content).toEqual([
      { type: "text", text: "legacy" },
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "Y" } },
    ]);
  });
});
