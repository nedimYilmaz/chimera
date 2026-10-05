import { describe, expect, it } from "vitest";
import { RPC_CONTRACT } from "../src/contract.js";
import { MCP_TOOL_TABLE } from "../src/mcp-tools.js";
import { SttTranscribeSchema } from "../src/stt.js";
describe("local speech contract", () => {
  it("bounds audio and rejects arbitrary paths, URLs, languages and identities", () => {
    const request = { requestId: "c1c9d33f-de20-45b0-a404-a3ee187fca55", engine: "whisper-cpp", language: "tr", audio: { format: "wav-pcm16-16k-mono", base64: "A".repeat(60) } };
    expect(SttTranscribeSchema.safeParse(request).success).toBe(true);
    for (const change of [{ language: "auto" }, { callerAgentId: "operator" }, { path: "/tmp/mic.wav" }, { audio: { ...request.audio, base64: "A".repeat(2_560_064) } }]) expect(SttTranscribeSchema.safeParse({ ...request, ...change }).success).toBe(false);
    expect(RPC_CONTRACT["stt.install"].request.safeParse({ engine: "whisper-cpp", model: "small-q5_1", url: "https://evil" }).success).toBe(false);
  });
  it("exposes status only to MCP, never capture, private audio or executable install", () => {
    const tools = MCP_TOOL_TABLE.filter(t => t.name.startsWith("stt_"));
    expect(tools.map(t => t.name)).toEqual(["stt_status"]);
  });
});
