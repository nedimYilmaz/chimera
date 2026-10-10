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
  it("accepts multiple bounded frames in a stdout chunk larger than the ceiling", () => {
    const mock = mockChild();
    const rpc = new CodexRpc("codex", [], {}, mock.factory);
    const failure = vi.fn();
    const notification = vi.fn();
    rpc.onFailure = failure;
    rpc.onNotification = notification;
    const frame = JSON.stringify({ method: "padding", params: { pad: "x".repeat(MAX_FRAME_BYTES / 2) } }) + "\n";
    try {
      mock.child.stdout.write(frame + frame);
      expect(failure).not.toHaveBeenCalled();
      expect(notification).toHaveBeenCalledTimes(2);
    } finally { rpc.close(); }
  });

  it.each([true, false])("measures inbound UTF-8 bytes with a completed frame: %s", complete => {
    const mock = mockChild();
    const rpc = new CodexRpc("codex", [], {}, mock.factory);
    const failure = vi.fn();
    rpc.onFailure = failure;
    try {
      const frame = JSON.stringify({ method: "padding", params: { pad: "界".repeat(Math.ceil(MAX_FRAME_BYTES / 3)) } });
      mock.child.stdout.write(frame + (complete ? "\n" : ""));
      expect(failure).toHaveBeenCalledTimes(1);
      expect(failure.mock.calls[0][0].message).toContain("JSONL frame exceeded");
    } finally { rpc.close(); }
  });

  it("retains a split frame across chunks and reads the following frame", async () => {
    const mock = mockChild();
    const rpc = new CodexRpc("codex", [], {}, mock.factory);
    const failure = vi.fn();
    rpc.onFailure = failure;
    try {
      const pending = rpc.request("thread/resume", { threadId: "saved" });
      const response = JSON.stringify({ id: 1, result: { thread: { id: "saved", preview: "x".repeat(MAX_FRAME_BYTES - 1024) } } }) + "\n";
      mock.child.stdout.write(response.slice(0, -100));
      mock.child.stdout.write(response.slice(-100) + JSON.stringify({ method: "ready", params: {} }) + "\n");
      expect((await pending).thread.id).toBe("saved");
      expect(failure).not.toHaveBeenCalled();
    } finally { rpc.close(); }
  });
  it("exposes only the exact owned live child PID and clears it on exit", () => {
    const mock = mockChild();
    Object.assign(mock.child, { pid: 123 });
    const rpc = new CodexRpc("codex", [], {}, mock.factory);
    expect(rpc.processPid).toBe(123);
    mock.child.emit("exit", 0, null);
    expect(rpc.processPid).toBeNull();
  });
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
