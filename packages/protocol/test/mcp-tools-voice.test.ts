import { describe, expect, it } from "vitest";
import { MCP_TOOL_TABLE, EXTENDED_MCP_TOOL_NAMES, grantedChimeraToolNames } from "../src/mcp-tools.js";
import { RPC_CONTRACT } from "../src/contract.js";

const tool = (name: string) => MCP_TOOL_TABLE.find(t => t.name === name)!;
describe("native voice MCP consent boundary", () => {
  it("exposes meeting invitations and owner controls without audio consent methods or caller spoofing", () => {
    const granted = grantedChimeraToolNames({ conductor: true, autonomy: "full" });
    for (const action of ["create", "list", "update", "end", "delete"]) {
      const name = `voice_room_${action}`;
      expect(granted).toContain(name);
      expect(tool(name).inputSchema).not.toHaveProperty("callerAgentId");
      expect(tool(name).resolve({ callerAgentId: "forged" }, { agentId: "boss", depth: 0 })).toMatchObject({ method: `voice.room.${action}`, params: { callerAgentId: "boss" } });
    }
    expect(MCP_TOOL_TABLE.some(t => ["voice.room.approve", "voice.room.heartbeat", "voice.native.text"].includes(t.name))).toBe(false);
    expect(() => RPC_CONTRACT["voice.room.create"].request.parse({ name: "Review", agentIds: ["a", "a"] })).toThrow();
  });
  it("grants voice start/stop directly to conductors, including full autonomy", () => {
    const granted = grantedChimeraToolNames({ conductor: true, autonomy: "full" });
    expect(granted).toContain("voice_conversation_start"); expect(granted).toContain("voice_conversation_stop");
  });
  it("stamps the requester identity from context even with a forged argument", () => {
    expect(tool("voice_conversation_start").resolve({ agentId: "target", callerAgentId: "forged", reason: "Review" }, { agentId: "self", depth: 0 })).toMatchObject({
      kind: "rpc", method: "voice.native.request", params: { agentId: "target", callerAgentId: "self", reason: "Review" },
    });
    expect(tool("voice_conversation_stop").resolve({ callerAgentId: "forged" }, { agentId: "self", depth: 0 })).toMatchObject({
      method: "voice.native.end", params: { agentId: "self", callerAgentId: "self" },
    });
  });
  it("defaults to self; operator tools require an explicit target", () => {
    expect(tool("voice_conversation_start").resolve({}, { agentId: "self", depth: 0 })).toMatchObject({ params: { agentId: "self" } });
    expect(() => tool("voice_conversation_start").resolve({}, { depth: 0 })).toThrow("agentId");
    expect(() => tool("voice_conversation_stop").resolve({}, { depth: 0 })).toThrow("agentId");
  });
  it("keeps audio negotiation out of the tool schema and bounds reasons", () => {
    expect(EXTENDED_MCP_TOOL_NAMES).toContain("voice_conversation_start");
    expect(Object.keys(tool("voice_conversation_start").inputSchema)).toEqual(["agentId", "reason"]);
    expect(() => RPC_CONTRACT["voice.native.request"].request.parse({ agentId: "a", sdp: "offer" })).toThrow();
    expect(() => RPC_CONTRACT["voice.native.request"].request.parse({ agentId: "a", reason: "x".repeat(501) })).toThrow();
  });
});
