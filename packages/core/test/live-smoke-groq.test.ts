// F23-1A live-smoke: Groq (note base URL includes /openai; text-only -- no vision here, see
// providers-faz1a.test.ts for the mocked vision-guard coverage). Costs nothing on Groq's free
// tier but still hits the real API. Run with:
//   GROQ_API_KEY=gsk_... env -u CHIMERA_AGENT_ID -u CHIMERA_DEPTH -u CHIMERA_TREE_ID \
//     npx vitest run packages/core/test/live-smoke-groq.test.ts
import { describe, it, expect } from "vitest";
import { findProvider } from "@chimera/core/providers/catalog";
import { runLiveChatSmoke, runLiveToolCallSmoke } from "./live-smoke-helpers.js";

describe.skipIf(!process.env.GROQ_API_KEY)("live-smoke: groq", () => {
  const profile = findProvider("groq")!;
  const apiKey = process.env.GROQ_API_KEY ?? "";

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
