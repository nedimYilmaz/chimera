import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// ONBOARDING-GATE R1 — same harness as AddProviderForm.test.tsx: stub the
// Tauri rpc bridge (real listen()/invoke() calls throw outside a webview) so
// this test only exercises WelcomeScreen's own logic against a scripted rpc.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const calls: Array<{ method: string; params: unknown }> = [];
const rpcImpl = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  calls.push({ method, params });
  if (method === "accounts.list") return [];
  if (method === "providers.list") return [];
  if (method === "config.get") return { projectImportDir: "/existing/dir" };
  if (method === "config.patch") return { ok: true, changed: [] };
  return {};
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
}));

import { WelcomeScreen } from "../src/screens/WelcomeScreen";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };
function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) if (typeof child !== "string") findAll(child, pred, out);
  return out;
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("WelcomeScreen — ONBOARDING-GATE R1 (project import dir field)", () => {
  it("prefills from config.get, then edit/save round-trips through config.patch", async () => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(WelcomeScreen)); });
    await flush();
    const root = renderer.root as unknown as TreeNode;

    const value = findAll(root, (n) => "data-import-dir-value" in n.props)[0];
    expect(value).toBeDefined();
    expect((value!.children ?? []).join("")).toBe("/existing/dir");

    const editBtn = findAll(root, (n) => "data-import-dir-edit" in n.props)[0]!;
    act(() => { (editBtn.props["onClick"] as () => void)(); });

    const input = findAll(root, (n) => n.props["data-path-picker"] === "welcome-import-dir")[0]!;
    act(() => { (input.props["onChange"] as (e: unknown) => void)({ target: { value: "/new/custom/dir" } }); });

    const saveBtn = findAll(root, (n) => "data-import-dir-save" in n.props)[0]!;
    await act(async () => { await (saveBtn.props["onClick"] as () => Promise<void>)(); });

    const patch = calls.find((c) => c.method === "config.patch");
    expect(patch).toBeDefined();
    expect(patch!.params).toEqual({ patch: { projectImportDir: "/new/custom/dir" } });
  });

  it("rejects a relative path inline — no config.patch call", async () => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(WelcomeScreen)); });
    await flush();
    const root = renderer.root as unknown as TreeNode;

    const editBtn = findAll(root, (n) => "data-import-dir-edit" in n.props)[0]!;
    act(() => { (editBtn.props["onClick"] as () => void)(); });
    const input = findAll(root, (n) => n.props["data-path-picker"] === "welcome-import-dir")[0]!;
    act(() => { (input.props["onChange"] as (e: unknown) => void)({ target: { value: "relative/dir" } }); });

    const before = calls.filter((c) => c.method === "config.patch").length;
    const saveBtn = findAll(root, (n) => "data-import-dir-save" in n.props)[0]!;
    await act(async () => { await (saveBtn.props["onClick"] as () => Promise<void>)(); });
    expect(calls.filter((c) => c.method === "config.patch").length).toBe(before); // unchanged
  });
});
