import { describe, it, expect, vi, afterEach } from "vitest";
import { log, logError } from "../src/logger.js";

describe("logger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes a structured JSON line to stderr via console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    log("info", "scheduler", "tick started", { queued: 3 });
    expect(spy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry).toMatchObject({ level: "info", component: "scheduler", message: "tick started", context: { queued: 3 } });
    expect(typeof entry.ts).toBe("string");
  });

  it("logError captures the error message as context", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("federation", "stop failed", new Error("boom"), { peer: "a" });
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry).toMatchObject({ level: "error", component: "federation", message: "stop failed", context: { peer: "a", error: "boom" } });
  });

  it("logError stringifies non-Error rejections", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("network", "auto-join failed", "some string rejection");
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.context.error).toBe("some string rejection");
  });

  it("logError reports a PLAIN {code,message} — the shape Engine.handle actually throws", () => {
    // The regression this pins: an `instanceof Error` check plus String() rendered every RPC
    // handler failure as "[object Object]". Engine.handle normalizes its throws into a plain
    // object, so that arm never matched the daemon's most common error, and the reason a request
    // was rejected — the whole point of logging it — was erased at the last step.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("rpc", "team.create handler threw", { code: "protocol", message: "Unrecognized keys: \"cwd\"" });
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.context.error).toBe("protocol: Unrecognized keys: \"cwd\"");
  });

  it("logError falls back to JSON for an object with no message, and never throws on a cyclic one", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("rpc", "odd throw", { code: 7, detail: "no message field" });
    expect(JSON.parse(spy.mock.calls[0][0] as string).context.error).toBe('{"code":7,"detail":"no message field"}');

    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => logError("rpc", "cyclic throw", cyclic)).not.toThrow();
    expect(JSON.parse(spy.mock.calls[1][0] as string).context.error).toBe("[object Object]");
  });
});
