import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// ONBOARDING-PROVIDER — same harness as SpawnCard.test.tsx: stub the Tauri rpc
// bridge (real listen()/invoke() calls throw outside a webview) so this test only
// exercises AddProviderForm's own logic against a scripted rpc.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const rpcImpl = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({}));

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
}));

import { AddProviderForm } from "../src/components/AddProviderForm";
import { buildProviderCatalogRows, type ProviderCatalogItem } from "../src/state/selectors.settings";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}
function byAttr(tree: TreeNode, attr: string, value?: string): TreeNode[] {
  return findAll(tree, (n) => attr in n.props && (value === undefined || n.props[attr] === value));
}

const CLAUDE: ProviderCatalogItem = {
  id: "claude", label: "Claude", kind: "agentic-sdk",
  baseUrl: "https://api.anthropic.com", defaultModel: "claude-opus-4-8",
  authModes: ["apiKey", "oauth"], capabilities: { tools: true, vision: true, streaming: true },
  tosNote: null, experimental: false, override: null, accounts: [],
};

const XAI: ProviderCatalogItem = {
  id: "xai", label: "xAI (Grok)", kind: "openai-compat",
  baseUrl: "https://api.x.ai/v1", defaultModel: "grok-4.5",
  authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: false },
  tosNote: null, experimental: false, override: null, accounts: [],
};

const OLLAMA: ProviderCatalogItem = {
  ...XAI,
  id: "ollama-local",
  label: "Ollama (local)",
  baseUrl: "http://127.0.0.1:3333/v1",
  defaultModel: "qwen3.5:9b-mlx",
  custom: true,
  requiresKey: false,
};

function renderForm(initialProvider: string, items: ProviderCatalogItem[], onDone: () => void = () => {}) {
  const catalogRows = buildProviderCatalogRows(items);
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      React.createElement(AddProviderForm, {
        initialProvider,
        providerOptions: items.map((i) => i.id),
        catalogRows,
        onDone,
      }),
    );
  });
  return renderer;
}

describe("AddProviderForm — auth-type gating", () => {
  it("subscription is selectable for an agentic-sdk provider (claude)", () => {
    const tree = renderForm("claude", [CLAUDE]).toJSON() as TreeNode;
    const [subBtn] = byAttr(tree, "data-auth-type-subscription");
    expect(subBtn!.props["disabled"]).toBeFalsy();
  });

  it("subscription is disabled with a hint for a non-agentic-sdk provider (xai)", () => {
    const tree = renderForm("xai", [XAI]).toJSON() as TreeNode;
    const [subBtn] = byAttr(tree, "data-auth-type-subscription");
    expect(subBtn!.props["disabled"]).toBe(true);
    expect(JSON.stringify(tree)).toContain("CLI subscription is claude/codex only");
  });
});

describe("AddProviderForm — submit", () => {
  it("api-key path calls accounts.add then accounts.setKey", async () => {
    rpcImpl.mockClear();
    let done = false;
    const renderer = renderForm("xai", [XAI], () => { done = true; });

    const [nameInput] = byAttr(renderer.toJSON() as TreeNode, "data-provider-name");
    act(() => { (nameInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "my-xai" } }); });
    const [keyInput] = byAttr(renderer.toJSON() as TreeNode, "data-provider-key");
    act(() => { (keyInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "sk-test" } }); });

    const [saveBtn] = byAttr(renderer.toJSON() as TreeNode, "data-provider-save");
    await act(async () => { (saveBtn!.props["onClick"] as () => void)(); await Promise.resolve(); await Promise.resolve(); });

    const calledMethods = rpcImpl.mock.calls.map((c) => c[0]);
    expect(calledMethods).toContain("accounts.add");
    expect(calledMethods).toContain("accounts.setKey");
    expect(rpcImpl.mock.calls.find((c) => c[0] === "accounts.add")?.[1]).toMatchObject({ name: "my-xai", provider: "xai" });
    expect(done).toBe(true);
  });

  it("subscription path calls accounts.add_subscription with no key/name", async () => {
    rpcImpl.mockClear();
    let done = false;
    const renderer = renderForm("claude", [CLAUDE], () => { done = true; });

    const [subBtn] = byAttr(renderer.toJSON() as TreeNode, "data-auth-type-subscription");
    act(() => { (subBtn!.props["onClick"] as () => void)(); });

    const [connectBtn] = byAttr(renderer.toJSON() as TreeNode, "data-provider-connect-subscription");
    await act(async () => { (connectBtn!.props["onClick"] as () => void)(); await Promise.resolve(); await Promise.resolve(); });

    const call = rpcImpl.mock.calls.find((c) => c[0] === "accounts.add_subscription");
    expect(call?.[1]).toMatchObject({ provider: "claude" });
    expect(done).toBe(true);
  });

  it("no-key custom provider stores no secret and auto-tests connectivity", async () => {
    rpcImpl.mockClear();
    const renderer = renderForm("ollama-local", [OLLAMA]);
    const [nameInput] = byAttr(renderer.toJSON() as TreeNode, "data-provider-name");
    act(() => { (nameInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "local" } }); });
    expect(byAttr(renderer.toJSON() as TreeNode, "data-provider-key")).toHaveLength(0);

    const [saveBtn] = byAttr(renderer.toJSON() as TreeNode, "data-provider-save");
    await act(async () => {
      (saveBtn!.props["onClick"] as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const calledMethods = rpcImpl.mock.calls.map((c) => c[0]);
    expect(calledMethods).toContain("accounts.add");
    expect(calledMethods).toContain("accounts.test");
    expect(calledMethods).not.toContain("accounts.setKey");
  });
});
