// F23-1A live-smoke: xAI (Grok). Costs real tokens. Run with:
//   XAI_API_KEY=xai-... env -u CHIMERA_AGENT_ID -u CHIMERA_DEPTH -u CHIMERA_TREE_ID \
//     npx vitest run packages/core/test/live-smoke-xai.test.ts
import { describe, it, expect } from "vitest";
import { findProvider } from "@chimera/core/providers/catalog";
import { runLiveChatSmoke, runLiveToolCallSmoke } from "./live-smoke-helpers.js";

describe.skipIf(!process.env.XAI_API_KEY)("live-smoke: xai", () => {
  const profile = findProvider("xai")!;
  const apiKey = process.env.XAI_API_KEY ?? "";

  it("1-message chat against the real API", async () => {
    const result = await runLiveChatSmoke(profile, apiKey);
    expect(result.message.toLowerCase()).toContain("pong");
  }, 30_000);

  it("tool-call round trip against the real API", async () => {
    const result = await runLiveToolCallSmoke(profile, apiKey);
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls[0]!.name).toBe("echo");
    expect(JSON.parse(result.toolCalls[0]!.arguments)).toMatchObject({ text: expect.any(String) });
  }, 30_000);
});
