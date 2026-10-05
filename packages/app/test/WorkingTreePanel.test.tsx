import * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkingTreePanel } from "../src/components/WorkingTreePanel";
import { WorktreeFileEditor } from "../src/components/WorktreeFileEditor";
import { appStore } from "../src/state/store";
import type { GitStatus } from "@chimera/protocol";
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../src/rpc/bridge", () => ({ rpcCall: call, onDaemonEvent: () => () => {}, onConnectionState: () => () => {} }));
const base: GitStatus = { branch: "test", head: "head", indexFingerprint: "index", writable: true, writeReason: null, truncated: false, files: [{ path: "one.txt", index: " ", worktree: "M", staged: false }, { path: "two.txt", index: "M", worktree: " ", staged: true }] };
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const button = (r: ReactTestRenderer, text: string) => r.root.findAllByType("button").find(b => b.children.join("") === text)!;
beforeEach(() => { call.mockReset(); appStore.dispatch({ type: "connected", connected: true }); call.mockImplementation(async method => method === "worktree.gitStatus" ? base : method === "worktree.gitDiff" ? { hunks: "patch", binary: false, truncated: false } : { text: "disk", contentVersion: "v1", bytes: 4 }); });
describe("working tree state and editor guards", () => {
  it("stages an explicit file with both reviewed versions and disables writes on foreign lease", async () => {
    let r!: ReactTestRenderer; await act(async () => { r = create(<WorkingTreePanel target={{ agentId: "stage-test" }} />); }); await flush();
    await act(async () => { r.root.findByProps({ "aria-label": "Stage one.txt" }).props.onClick(); });
    expect(call).toHaveBeenCalledWith("worktree.gitStage", { target: { agentId: "stage-test" }, paths: ["one.txt"], unstage: false, expectedHead: "head", expectedIndexFingerprint: "index" });
    call.mockImplementation(async method => method === "worktree.gitStatus" ? { ...base, writable: false, writeReason: "foreign holder" } : {});
    await act(async () => button(r, "Refresh diff and status").props.onClick()); await flush();
    expect(r.root.findByProps({ "aria-label": "Stage one.txt" }).props.disabled).toBe(true); act(() => r.unmount());
  });
  it("retains last-good selection on failed refresh and ignores late disconnected replies", async () => {
    let r!: ReactTestRenderer; await act(async () => { r = create(<WorkingTreePanel target={{ agentId: "refresh-test" }} />); }); await flush();
    act(() => r.root.findAllByType("button").find(b => b.children.join("").includes("one.txt") && b.props["aria-pressed"] !== undefined)!.props.onClick()); await flush();
    let resolve!: (v: unknown) => void; call.mockImplementation(method => method === "worktree.gitStatus" ? new Promise(r => { resolve = r; }) : Promise.resolve({ hunks: "patch", binary: false, truncated: false }));
    act(() => button(r, "Refresh diff and status").props.onClick());
    act(() => appStore.dispatch({ type: "connected", connected: false }));
    await act(async () => resolve({ ...base, branch: "obsolete" }));
    expect(r.root.findByProps({ "data-git-branch": true }).children.join("")).toContain("test"); expect(r.root.findByProps({ "aria-label": "Stage one.txt" }).props.disabled).toBe(true); act(() => r.unmount());
  });
  it("preserves unsaved file drafts through unmount, cancel and content conflicts", async () => {
    let r!: ReactTestRenderer; const props = { target: { agentId: "draft-test" }, path: "one.txt", writable: true, onSaved: vi.fn() };
    await act(async () => { r = create(<WorktreeFileEditor {...props} />); }); await act(async () => button(r, "Edit text").props.onClick()); await flush();
    act(() => r.root.findByType("textarea").props.onChange({ target: { value: "unsaved", selectionStart: 3 } })); act(() => r.unmount());
    await act(async () => { r = create(<WorktreeFileEditor {...props} />); }); expect(r.root.findByType("textarea").props.value).toBe("unsaved");
    call.mockRejectedValueOnce(new Error("stale_content")); await act(async () => button(r, "Save text").props.onClick());
    expect(r.root.findByType("textarea").props.value).toBe("unsaved"); expect(call).toHaveBeenCalledWith("worktree.fileWrite", expect.objectContaining({ text: "unsaved", expectedContentVersion: "v1" }));
    act(() => button(r, "Cancel edit").props.onClick()); expect(button(r, "Keep draft and close")).toBeDefined(); act(() => button(r, "Keep draft and close").props.onClick()); act(() => button(r, "Edit text").props.onClick()); expect(r.root.findByType("textarea").props.value).toBe("unsaved"); act(() => r.unmount());
  });
});
