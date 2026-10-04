import { describe, it, expect } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { Image, ResolvedAgentSpec } from "@chimera/core/backend";
import { REPO_BACKED_CWD } from "./repo-backed-cwd.js";

// IMAGE.PASTE (TUI #7): userMessage(text, images?) must build the exact
// ImageBlockParam shape the claude-agent-sdk expects: Base64ImageSource
// { type:"base64", media_type, data }, appended AFTER the text block, in the
// SAME content array (mid-session send() carries the same envelope as the
// initial spawn prompt). Captured via the queryFn seam -- no real SDK/network.

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

describe("ClaudeAgentBackend: image content blocks (IMAGE.PASTE)", () => {
  it("the initial spawn prompt carries only a text block (spawn-time images are out of scope, see IMAGE.PASTE report)", async () => {
    const { fn, received } = recordingQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true }), () => {}, async () => true);
    await settle();
    expect(received[0]!.message.content).toEqual([{ type: "text", text: "task" }]);
  });

  it("a mid-session send() with one image appends a base64 image content block after the text block", async () => {
    const { fn, received } = recordingQuery();
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true }), () => {}, async () => true);
    await settle();
    await h.send("look at this", [{ mediaType: "image/png", data: "aGVsbG8=" }]);
    await settle();
    expect(received[1]!.message.content).toEqual([
      { type: "text", text: "look at this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
    ]);
  });

  it("multiple images are appended as separate blocks in the SAME order they were provided", async () => {
    const { fn, received } = recordingQuery();
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true }), () => {}, async () => true);
    await settle();
    const imgs: Image[] = [
      { mediaType: "image/jpeg", data: "AAA" },
      { mediaType: "image/gif", data: "BBB" },
      { mediaType: "image/webp", data: "CCC" },
    ];
    await h.send("three pics", imgs);
    await settle();
    expect(received[1]!.message.content).toEqual([
      { type: "text", text: "three pics" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA" } },
      { type: "image", source: { type: "base64", media_type: "image/gif", data: "BBB" } },
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "CCC" } },
    ]);
  });

  it("send() with an explicit empty images array produces only the text block (no stray image entries)", async () => {
    const { fn, received } = recordingQuery();
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true }), () => {}, async () => true);
    await settle();
    await h.send("no pics", []);
    await settle();
    expect(received[1]!.message.content).toEqual([{ type: "text", text: "no pics" }]);
  });

  it("send() called without the images argument at all (backward compat) still works", async () => {
    const { fn, received } = recordingQuery();
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true }), () => {}, async () => true);
    await settle();
    await h.send("plain text");
    await settle();
    expect(received[1]!.message.content).toEqual([{ type: "text", text: "plain text" }]);
  });

  it("all four supported media types round-trip verbatim into media_type", async () => {
    const { fn, received } = recordingQuery();
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true }), () => {}, async () => true);
    await settle();
    const types: Image["mediaType"][] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    await h.send("all types", types.map((mediaType) => ({ mediaType, data: "X" })));
    await settle();
    const blocks = received[1]!.message.content.slice(1) as Array<{ source: { media_type: string } }>;
    expect(blocks.map((b) => b.source.media_type)).toEqual(types);
  });
});
