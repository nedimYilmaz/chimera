import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MCP_TOOL_TABLE } from "@chimera/protocol";

describe("OpenAI account creation through MCP", () => {
  const tool = MCP_TOOL_TABLE.find((t) => t.name === "accounts_add")!;
  it("accepts an OpenAI provider id and forwards it to the daemon validator", () => {
    const args = z.object(tool.inputSchema).parse({ name: "openai-main", provider: "openai" });
    expect(tool.resolve(args)).toEqual({ kind: "rpc", method: "accounts.add", params: { name: "openai-main", provider: "openai" } });
  });
  it("preserves legacy omission and rejects empty provider ids", () => {
    expect(z.object(tool.inputSchema).parse({ name: "legacy" })).toEqual({ name: "legacy" });
    expect(() => z.object(tool.inputSchema).parse({ name: "bad", provider: "" })).toThrow();
  });
});
