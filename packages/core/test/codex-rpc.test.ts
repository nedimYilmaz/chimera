import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import { CodexRpc, type RpcProcessFactory } from "@chimera/core/backends/codex-rpc";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

function mockChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => { child.emit("exit", 0, null); return true; }),
  });
  const written: string[] = [];
  child.stdin.on("data", (chunk) => written.push(String(chunk)));
  const factory: RpcProcessFactory = () => child as unknown as ChildProcessWithoutNullStreams;
  return { child, written, factory };
}

describe("CodexRpc JSONL frame guard", () => {
  // CONTEXT-OVERFLOW: both directions share MAX_FRAME_BYTES so classifyFailure's CONTEXT_OVERFLOW
  // signal in failover.ts matches either failure the same way.
  it("fails an inbound frame over the ceiling with the exact classifiable phrase, no outbound suffix", async () => {
    const mock = mockChild();
    const rpc = new CodexRpc("codex", [], {}, mock.factory);
    const failure = vi.fn();
    rpc.onFailure = failure;
    mock.child.stdout.write("x".repeat(MAX_FRAME_BYTES + 1));
    await vi.waitFor(() => expect(failure).toHaveBeenCalled());
    expect(failure.mock.calls[0][0].message).toBe(`Codex app-server JSONL frame exceeded ${MAX_FRAME_BYTES / (1024 * 1024)} MiB`);
  });

  it("fails an outbound write over the ceiling with the (outbound) suffix, without touching stdin", async () => {
    const mock = mockChild();
    const rpc = new CodexRpc("codex", [], {}, mock.factory);
    const failure = vi.fn();
    rpc.onFailure = failure;
    // A single request() param big enough to push the serialized JSONL frame over the ceiling.
    void rpc.request("turn/start", { huge: "x".repeat(MAX_FRAME_BYTES + 1) }).catch(() => {});
    await vi.waitFor(() => expect(failure).toHaveBeenCalled());
    expect(failure.mock.calls[0][0].message).toBe(`Codex app-server JSONL frame exceeded ${MAX_FRAME_BYTES / (1024 * 1024)} MiB (outbound)`);
    expect(mock.written.join("")).toBe("");
  });

  it("a frame just under the ceiling is not treated as oversized on either path", async () => {
    const mock = mockChild();
    const rpc = new CodexRpc("codex", [], {}, mock.factory);
    const failure = vi.fn();
    rpc.onFailure = failure;
    rpc.notify("padding", { pad: "x".repeat(MAX_FRAME_BYTES - 1024) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failure).not.toHaveBeenCalled();
    expect(mock.written.join("").length).toBeGreaterThan(0);
  });
});
