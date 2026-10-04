import { describe, expect, it } from "vitest";
import { errorText } from "../src/state/errorText";

// RPC-ERROR-TEXT: rpcCall/invoke rejections carry the daemon's own
// `{code,message}` shape, never a real Error — errorText must extract
// `.message` off that plain object instead of degrading to "[object Object]".
describe("errorText", () => {
  it("uses .message from a real Error instance", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
  });

  it("extracts .message from a plain {code,message} rejection (the daemon's RpcError shape)", () => {
    expect(errorText({ code: "not_found", message: "queue does not exist" })).toBe("queue does not exist");
  });

  it("falls back to String() for a value with no .message", () => {
    expect(errorText("kaboom")).toBe("kaboom");
    expect(errorText(42)).toBe("42");
  });

  it("never returns the literal '[object Object]' for a message-bearing object", () => {
    expect(errorText({ message: "daemon fault" })).not.toBe("[object Object]");
  });
});
