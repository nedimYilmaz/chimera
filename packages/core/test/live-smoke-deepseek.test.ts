// F23-1A live-smoke: DeepSeek (text-only API -- no image assertions here, see
// providers-faz1a.test.ts for the mocked vision-guard coverage). Costs real tokens. Run with:
//   DEEPSEEK_API_KEY=... env -u CHIMERA_AGENT_ID -u CHIMERA_DEPTH -u CHIMERA_TREE_ID \
//     npx vitest run packages/core/test/live-smoke-deepseek.test.ts
import { describe, it, expect } from "vitest";
import { findProvider } from "@chimera/core/providers/catalog";
import { runLiveChatSmoke, runLiveToolCallSmoke } from "./live-smoke-helpers.js";

describe.skipIf(!process.env.DEEPSEEK_API_KEY)("live-smoke: deepseek", () => {
  const profile = findProvider("deepseek")!;
  const apiKey = process.env.DEEPSEEK_API_KEY ?? "";

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
