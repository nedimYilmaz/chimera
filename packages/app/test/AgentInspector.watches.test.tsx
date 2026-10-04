import "./agents-window-harness";
import { afterEach, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

vi.mock("../src/rpc/bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/rpc/bridge")>(),
  rpcCall: vi.fn(), onDaemonEvent: () => () => {},
}));
import { rpcCall } from "../src/rpc/bridge";
import { AgentInspector } from "../src/components/AgentInspector";
const rpc = vi.mocked(rpcCall);
let tree: ReturnType<typeof create> | undefined;
const panel = (id: string) => <AgentInspector record={{ agentId: id }} task={null} retryLimit={1} owner={null} queue={null} />;
const watch = { id: "old-watch", topic: "task.state", filter: {}, once: false };
afterEach(() => { act(() => tree?.unmount()); tree = undefined; rpc.mockReset(); });

it("clears watch chips when the inspected agent changes", async () => {
  rpc.mockResolvedValueOnce([watch]);
  await act(async () => { tree = create(panel("old")); });
  expect(tree!.root.findAll((n) => n.props["data-sub-chip"] === "old-watch")).toHaveLength(1);
  rpc.mockReturnValueOnce(new Promise(() => {}));
  await act(async () => { tree!.update(panel("new")); });
  expect(tree!.root.findAll((n) => n.props["data-sub-chip"] === "old-watch")).toHaveLength(0);
  expect(rpc).toHaveBeenLastCalledWith("sub.list", { subscriberId: "new" });
});

it("handles both unsubscribe and recovery-list failures without an unhandled rejection", async () => {
  rpc.mockResolvedValueOnce([watch]);
  await act(async () => { tree = create(panel("old")); });
  rpc.mockRejectedValueOnce(new Error("remove failed"));
  rpc.mockRejectedValueOnce(new Error("list failed"));
  await act(async () => { tree!.root.findByProps({ "data-sub-remove": "old-watch" }).props.onClick(); });
  expect(rpc).toHaveBeenCalledWith("sub.remove", { subscriberId: "old", id: "old-watch" });
  expect(rpc).toHaveBeenLastCalledWith("sub.list", { subscriberId: "old" });
  expect(tree!.root.findAll((n) => n.props["data-sub-chip"] === "old-watch")).toHaveLength(1);
});
