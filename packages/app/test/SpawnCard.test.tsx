import { describe, expect, it, vi, beforeEach } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// SPAWN-FORM-ACCOUNTS: the account field is a <select> over accounts.list (not a
// provider picker — SPAWN-FORM-SURFACE's provider dropdown could only ever target
// ONE account per provider, but the top bar shows multiple, e.g. main:claude ·
// codex:codex). Same harness as WorkflowFormCard.test.tsx (OverlayCard's esc-key
// effect needs a bare window stub — this package's vitest config runs a node env, no
// jsdom) and TaskInspector.test.tsx (the Tauri rpc bridge fires real
// listen()/invoke() calls at import time, which throw outside a webview — stub the
// module so this test only exercises SpawnCard's own logic against a scripted rpc).
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
  readArtifactSnapshot: vi.fn(async () => ""),
  openArtifactSnapshot: vi.fn(async () => {}),
  openArtifactUrl: vi.fn(async () => {}),
  setDockBadge: vi.fn(async () => {}),
  exportCsv: vi.fn(async () => ""),
  checkpointFilesSince: vi.fn(async () => 0),
}));

import { SpawnCard, computeRoleSpecOverrides, quickSpawnModel } from "../src/components/SpawnCard";
import { appStore } from "../src/state/store";

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

const CLAUDE = {
  id: "claude", label: "Claude", defaultModel: "claude-opus-4-8",
  models: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  accounts: [{ name: "main", authType: "subscription" }, { name: "claude-2", authType: "keychain" }],
};
const CODEX = {
  id: "codex", label: "Codex", defaultModel: "gpt-5.1-codex",
  models: ["gpt-5.1-codex"],
  accounts: [{ name: "codex", authType: "subscription" }],
};
// unconfigured — zero accounts, no backend registered daemon-side.
const XAI = { id: "xai", label: "xAI (Grok)", defaultModel: "grok-4.5", models: ["grok-4.5", "grok-4.5-mini"], accounts: [] };
const NVIDIA = { id: "nvidia", label: "NVIDIA NIM", defaultModel: "nemotron", models: ["nemotron"], accounts: [] };

// SPAWN-FORM-ACCOUNTS: accounts.list rows — the account dropdown's actual option
// list. Two accounts share the "claude" provider (autoOrder/failover, main:claude ·
// codex:codex is what the top bar surfaces) to prove the dropdown lists ACCOUNTS,
// not deduped providers.
const ACCOUNTS = [
  { name: "main", provider: "claude", authType: "subscription" },
  { name: "claude-2", provider: "claude", authType: "keychain" },
  { name: "codex", provider: "codex", authType: "subscription" },
];

function mockRpc(providerRows: unknown[], accountRows: unknown[] = ACCOUNTS): void {
  rpcImpl.mockImplementation(async (method: string, params?: unknown) => {
    if (method === "providers.list") return providerRows;
    if (method === "accounts.list") return accountRows;
    if (method === "providers.models") {
      const provider = (params as { provider: string }).provider;
      const row = (providerRows as Array<{ id: string; models: string[] }>).find((r) => r.id === provider);
      return { models: row?.models ?? [], source: "catalog" };
    }
    return {};
  });
}

async function renderSpawnCard(quick = false): Promise<ReturnType<typeof create>> {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(React.createElement(SpawnCard, { onClose: () => {}, quick }));
  });
  // one macrotask yield drains the providers.list/accounts.list → setCatalog →
  // effectiveProvider change → providers.models microtask chain.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return renderer;
}

beforeEach(() => {
  rpcImpl.mockReset();
  mockRpc([CLAUDE, CODEX, XAI, NVIDIA]);
});

describe("SpawnCard — account dropdown", () => {
  it("retains an explicit mode override on a planning role", () => {
    expect(computeRoleSpecOverrides({ executionMode: "plan", permissionProfile: "acceptEdits" }, { executionMode: "execute" }))
      .toEqual({ executionMode: "execute" });
  });
  it.each(["", "plan", "execute"])("normal spawn forwards execution mode %s without changing permissions", async (mode) => {
    const renderer = await renderSpawnCard();
    const control = (key: string) => renderer.root.findByProps({ "data-spawn-field": key });
    act(() => control("prompt").props.onChange({ target: { value: "work" } }));
    act(() => control("executionMode").props.onChange({ target: { value: mode } }));
    await act(async () => renderer.root.findByProps({ "data-spawn-submit": true }).props.onClick());
    const params = rpcImpl.mock.calls.find(([method]) => method === "agent.spawn")![1] as { spec: Record<string, unknown> };
    expect(params.spec.executionMode).toBe(mode || undefined);
    act(() => renderer.unmount());
  });

  it.each(["", "on", "off"])("normal spawn forwards native MCP choice %s independently of Chimera tools", async (choice) => {
    const renderer = await renderSpawnCard();
    const control = (key: string) => renderer.root.findByProps({ "data-spawn-field": key });
    act(() => control("prompt").props.onChange({ target: { value: "native tools" } }));
    act(() => renderer.root.findByProps({ "data-path-picker": "spawn-cwd" }).props.onChange({ target: { value: "/tmp/project" } }));
    act(() => renderer.root.findByProps({ "data-spawn-orchestration": "on" }).props.onClick());
    act(() => control("nativeMcps").props.onChange({ target: { value: choice } }));
    await act(async () => renderer.root.findByProps({ "data-spawn-submit": true }).props.onClick());
    const params = rpcImpl.mock.calls.find(([method]) => method === "agent.spawn")![1] as { spec: Record<string, unknown> };
    expect(params.spec.orchestration).toEqual({ allow: true });
    expect(params.spec.strictMcpConfig).toBe(choice === "" ? undefined : choice === "off");
    expect(params.spec.loadSettings).toBe(choice === "on" ? true : undefined);
    act(() => renderer.unmount());
  });

  it("does not send a stale Claude native MCP choice after switching to Codex", async () => {
    const renderer = await renderSpawnCard();
    const control = (key: string) => renderer.root.findByProps({ "data-spawn-field": key });
    act(() => control("prompt").props.onChange({ target: { value: "native tools" } }));
    act(() => control("nativeMcps").props.onChange({ target: { value: "off" } }));
    act(() => control("executionMode").props.onChange({ target: { value: "plan" } }));
    await act(async () => control("account").props.onChange({ target: { value: "codex" } }));
    expect(control("nativeMcps").props.disabled).toBe(true);
    await act(async () => renderer.root.findByProps({ "data-spawn-submit": true }).props.onClick());
    const params = rpcImpl.mock.calls.find(([method]) => method === "agent.spawn")![1] as { spec: Record<string, unknown> };
    expect(params.spec.strictMcpConfig).toBeUndefined();
    expect(params.spec.executionMode).toBeUndefined();
    act(() => renderer.unmount());
  });

  it("preserves native plugin settings and the explicit override when a role has a legacy strict flag", () => {
    expect(computeRoleSpecOverrides({ strictMcpConfig: false, providerOptions: { strictMcpConfig: true } },
      { strictMcpConfig: false, loadSettings: true })).toEqual({ strictMcpConfig: false, loadSettings: true });
  });

  it.each([
    ["bypass", "", false, true],
    ["ask", "full", false, true],
    ["ask", "full", true, true],
    ["ask", "", true, undefined],
    ["bypass", "readOnly", false, undefined],
  ] as const)("Codex %s / profile %s / role %s preserves explicit full-access consent", async (mode, profile, role, acknowledged) => {
    const previous = appStore.getState().permissionMode;
    appStore.dispatch({ type: "permissionMode", mode });
    if (role) mockRpcWithRoles([AWS_ROLE]);
    const renderer = await renderSpawnCard();
    const change = (field: string, value: string, attr = "data-spawn-field") => {
      const input = byAttr(renderer.toJSON() as TreeNode, attr, field)[0]!;
      act(() => { (input.props["onChange"] as (e: unknown) => void)({ target: { value } }); });
    };
    try {
      expect(JSON.stringify(renderer.toJSON())).toContain("without its sandbox");
      change("prompt", "work"); change("spawn-cwd", "/tmp", "data-path-picker");
      change("account", "codex");
      if (role) change("role", "aws");
      if (profile) change("profile", profile);
      await act(async () => {
        (byAttr(renderer.toJSON() as TreeNode, "data-spawn-submit")[0]!.props["onClick"] as () => void)();
      });
      const call = rpcImpl.mock.calls.find(([m]) => m === "agent.spawn")!;
      const spec = (call[1] as { spec: Record<string, unknown> }).spec;
      expect(spec).toMatchObject({ account: "codex", provider: "codex" });
      expect(spec.acknowledgeCodexFullAccessRisk).toBe(acknowledged);
    } finally { act(() => renderer.unmount()); appStore.dispatch({ type: "permissionMode", mode: previous }); }
  });
  it("always renders an account <select> (no advanced fold) defaulting to auto", async () => {
    const renderer = await renderSpawnCard();
    const [select] = byAttr(renderer.toJSON() as TreeNode, "data-spawn-field", "account");
    expect(select).toBeTruthy();
    expect(select!.type).toBe("select");
    expect(select!.props["value"]).toBe("");
    expect(byAttr(renderer.toJSON() as TreeNode, "data-spawn-advanced")).toHaveLength(0);
  });

  it("lists every configured account as \"name · provider\", including multiple accounts on one provider", async () => {
    const renderer = await renderSpawnCard();
    const [select] = byAttr(renderer.toJSON() as TreeNode, "data-spawn-field", "account");
    const options = (select!.children ?? []) as TreeNode[];
    expect(options.map((o) => o.props["value"])).toEqual(["", "main", "claude-2", "codex"]);
    const labels = options.map((o) => (o.children ?? []).join(""));
    expect(labels).toEqual(["auto (failover order)", "main · claude", "claude-2 · claude", "codex · codex"]);
  });

  it("with no configured accounts at all, only the auto option is offered", async () => {
    mockRpc([CLAUDE, CODEX, XAI, NVIDIA], []);
    const renderer = await renderSpawnCard();
    const [select] = byAttr(renderer.toJSON() as TreeNode, "data-spawn-field", "account");
    const options = (select!.children ?? []) as TreeNode[];
    expect(options.map((o) => o.props["value"])).toEqual([""]);
  });

  it("picking the SECOND account on a shared provider (claude-2) writes values.account, derives claude's model list", async () => {
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [accountSelect] = byAttr(tree, "data-spawn-field", "account");
    act(() => { (accountSelect!.props["onChange"] as (e: unknown) => void)({ target: { value: "claude-2" } }); });

    tree = renderer.toJSON() as TreeNode;
    const [accountSelect2] = byAttr(tree, "data-spawn-field", "account");
    expect(accountSelect2!.props["value"]).toBe("claude-2");

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    tree = renderer.toJSON() as TreeNode;
    const [modelSelect] = byAttr(tree, "data-spawn-field", "model");
    const modelValues = (modelSelect!.children ?? []).map((o) => (o as TreeNode).props["value"]);
    expect(modelValues).toEqual(expect.arrayContaining(CLAUDE.models));
    expect(modelSelect!.props["value"]).toBe(CLAUDE.defaultModel);
  });

  it("picking the codex account derives codex's model list, distinct from claude", async () => {
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [accountSelect] = byAttr(tree, "data-spawn-field", "account");
    act(() => { (accountSelect!.props["onChange"] as (e: unknown) => void)({ target: { value: "codex" } }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    tree = renderer.toJSON() as TreeNode;
    const [modelSelect] = byAttr(tree, "data-spawn-field", "model");
    const modelValues = (modelSelect!.children ?? []).map((o) => (o as TreeNode).props["value"]);
    expect(modelValues).toContain("gpt-5.1-codex");
    expect(modelSelect!.props["value"]).toBe("gpt-5.1-codex");
  });
});

describe("SpawnCard — model dropdown", () => {
  it("renders as a real <select> populated from the auto/default provider's model list, defaulting to defaultModel", async () => {
    const renderer = await renderSpawnCard();
    const tree = renderer.toJSON() as TreeNode;
    const [modelSelect] = byAttr(tree, "data-spawn-field", "model");
    expect(modelSelect!.type).toBe("select");
    const modelValues = (modelSelect!.children ?? []).map((o) => (o as TreeNode).props["value"]);
    expect(modelValues).toEqual(expect.arrayContaining(CLAUDE.models));
    expect(modelSelect!.props["value"]).toBe(CLAUDE.defaultModel);
  });

  // SDK-MODEL-LISTS: a live providers.models probe (codex CLI / claude SDK) carries
  // {value,displayName,description} alongside the plain models[] id list — the <option>'s
  // value/spec.model stays the raw id, but its VISIBLE label should prefer displayName.
  it("shows a live probe's displayName as the option label, keeping the raw id as the value", async () => {
    rpcImpl.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "providers.list") return [CLAUDE, CODEX, XAI, NVIDIA];
      if (method === "accounts.list") return ACCOUNTS;
      if (method === "providers.models") {
        const provider = (params as { provider: string }).provider;
        if (provider === "codex") {
          return {
            models: ["gpt-5.6-sol"], source: "live",
            modelDetails: [{ value: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Latest frontier agentic coding model." }],
          };
        }
        const row = [CLAUDE, CODEX, XAI, NVIDIA].find((r) => r.id === provider);
        return { models: row?.models ?? [], source: "catalog" };
      }
      return {};
    });
    const renderer = await renderSpawnCard();
    await act(async () => {
      const [accountSelect] = byAttr(renderer.toJSON() as TreeNode, "data-spawn-field", "account");
      (accountSelect!.props["onChange"] as (e: unknown) => void)({ target: { value: "codex" } });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const [modelSelect] = byAttr(renderer.toJSON() as TreeNode, "data-spawn-field", "model");
    const solOption = (modelSelect!.children ?? [])
      .find((o) => typeof o !== "string" && (o as TreeNode).props["value"] === "gpt-5.6-sol") as TreeNode;
    expect(solOption.children).toEqual(["GPT-5.6-Sol"]);
  });

  it("selecting 'custom…' reveals a free-text input that stays typeable", async () => {
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [modelSelect] = byAttr(tree, "data-spawn-field", "model");
    act(() => { (modelSelect!.props["onChange"] as (e: unknown) => void)({ target: { value: "__custom__" } }); });

    tree = renderer.toJSON() as TreeNode;
    const [modelField] = byAttr(tree, "data-spawn-field", "model");
    expect(modelField!.type).toBe("input");

    act(() => { (modelField!.props["onChange"] as (e: unknown) => void)({ target: { value: "my-custom-model-id" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [modelField2] = byAttr(tree, "data-spawn-field", "model");
    expect(modelField2!.props["value"]).toBe("my-custom-model-id");
  });

  // SPAWN-FORM-ACCOUNTS scope addition: a picked model must not survive a provider
  // switch as a stale "custom" pick (e.g. "gpt-5.1-codex" surviving under claude).
  it("switching accounts across providers resets a now-invalid model back to the new provider's default", async () => {
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [accountSelect] = byAttr(tree, "data-spawn-field", "account");
    act(() => { (accountSelect!.props["onChange"] as (e: unknown) => void)({ target: { value: "codex" } }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    tree = renderer.toJSON() as TreeNode;
    let [modelSelect] = byAttr(tree, "data-spawn-field", "model");
    expect(modelSelect!.props["value"]).toBe("gpt-5.1-codex");

    const [accountSelect2] = byAttr(tree, "data-spawn-field", "account");
    act(() => { (accountSelect2!.props["onChange"] as (e: unknown) => void)({ target: { value: "main" } }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    tree = renderer.toJSON() as TreeNode;
    [modelSelect] = byAttr(tree, "data-spawn-field", "model");
    expect(modelSelect!.type).toBe("select");
    expect(modelSelect!.props["value"]).toBe(CLAUDE.defaultModel);
  });
});

describe("SpawnCard — submit", () => {
  it("uses an unambiguous no/yes conductor toggle and sends the optional custom name", async () => {
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;

    const [promptInput] = byAttr(tree, "data-spawn-field", "prompt");
    const [nameInput] = byAttr(tree, "data-spawn-field", "name");
    const [cwdInput] = byAttr(tree, "data-path-picker", "spawn-cwd");
    const [yesChip] = byAttr(tree, "data-spawn-conductor", "yes");
    act(() => {
      (promptInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "coordinate the release" } });
      (nameInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "release captain" } });
      (cwdInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "/Users/dev/proj" } });
      (yesChip!.props["onClick"] as () => void)();
    });

    tree = renderer.toJSON() as TreeNode;
    const [submitBtn] = byAttr(tree, "data-spawn-submit");
    act(() => { (submitBtn!.props["onClick"] as () => void)(); });

    const spawnCall = rpcImpl.mock.calls.find(([method]) => method === "agent.spawn");
    expect(spawnCall).toBeTruthy();
    const [, spawnParams] = spawnCall as [string, { spec: Record<string, unknown> }];
    expect(spawnParams.spec["conductor"]).toBe(true);
    expect(spawnParams.spec["displayLabel"]).toBe("release captain");
  });

  it("spawning with a chosen account sends the derived provider + its model in the spec", async () => {
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;

    const [promptInput] = byAttr(tree, "data-spawn-field", "prompt");
    act(() => { (promptInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "do the thing" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [cwdInput] = byAttr(tree, "data-path-picker", "spawn-cwd");
    act(() => { (cwdInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "/Users/dev/proj" } }); });

    tree = renderer.toJSON() as TreeNode;
    const [accountSelect] = byAttr(tree, "data-spawn-field", "account");
    act(() => { (accountSelect!.props["onChange"] as (e: unknown) => void)({ target: { value: "codex" } }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    tree = renderer.toJSON() as TreeNode;
    const [submitBtn] = byAttr(tree, "data-spawn-submit");
    act(() => { (submitBtn!.props["onClick"] as () => void)(); });

    const spawnCall = rpcImpl.mock.calls.find(([method]) => method === "agent.spawn");
    expect(spawnCall).toBeTruthy();
    const [, spawnParams] = spawnCall as [string, { spec: Record<string, unknown> }];
    expect(spawnParams.spec["prompt"]).toBe("do the thing");
    expect(spawnParams.spec["cwd"]).toBe("/Users/dev/proj");
    expect(spawnParams.spec["account"]).toBe("codex");
    expect(spawnParams.spec["provider"]).toBe("codex");
    expect(spawnParams.spec["model"]).toBe("gpt-5.1-codex");
  });

  it("spawning on \"auto\" sends neither account nor provider", async () => {
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;

    const [promptInput] = byAttr(tree, "data-spawn-field", "prompt");
    act(() => { (promptInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "do the thing" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [cwdInput] = byAttr(tree, "data-path-picker", "spawn-cwd");
    act(() => { (cwdInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "/Users/dev/proj" } }); });

    tree = renderer.toJSON() as TreeNode;
    const [submitBtn] = byAttr(tree, "data-spawn-submit");
    act(() => { (submitBtn!.props["onClick"] as () => void)(); });

    const spawnCall = rpcImpl.mock.calls.find(([method]) => method === "agent.spawn");
    expect(spawnCall).toBeTruthy();
    const [, spawnParams] = spawnCall as [string, { spec: Record<string, unknown> }];
    expect(spawnParams.spec["account"]).toBeUndefined();
    expect(spawnParams.spec["provider"]).toBeUndefined();
    expect(spawnParams.spec["conductor"]).toBeUndefined();   // default "no"
  });

  // AGENT-AUTONOMY: mirrors the conductor/session chip toggles' own "only submit the
  // non-default value" convention — "ask" is the default and never rides through.
  it("defaults autonomy to unset (\"ask\") — not sent", async () => {
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [promptInput] = byAttr(tree, "data-spawn-field", "prompt");
    act(() => { (promptInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "do the thing" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [cwdInput] = byAttr(tree, "data-path-picker", "spawn-cwd");
    act(() => { (cwdInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "/Users/dev/proj" } }); });

    tree = renderer.toJSON() as TreeNode;
    const [submitBtn] = byAttr(tree, "data-spawn-submit");
    act(() => { (submitBtn!.props["onClick"] as () => void)(); });

    const spawnCall = rpcImpl.mock.calls.find(([method]) => method === "agent.spawn");
    const [, spawnParams] = spawnCall as [string, { spec: Record<string, unknown> }];
    expect(spawnParams.spec["autonomy"]).toBeUndefined();
  });

  it("selecting full autonomy sends autonomy:\"full\" in the spec", async () => {
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [promptInput] = byAttr(tree, "data-spawn-field", "prompt");
    act(() => { (promptInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "do the thing" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [cwdInput] = byAttr(tree, "data-path-picker", "spawn-cwd");
    act(() => { (cwdInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "/Users/dev/proj" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [fullChip] = byAttr(tree, "data-spawn-autonomy", "full");
    act(() => { (fullChip!.props["onClick"] as () => void)(); });

    tree = renderer.toJSON() as TreeNode;
    const [submitBtn] = byAttr(tree, "data-spawn-submit");
    act(() => { (submitBtn!.props["onClick"] as () => void)(); });

    const spawnCall = rpcImpl.mock.calls.find(([method]) => method === "agent.spawn");
    const [, spawnParams] = spawnCall as [string, { spec: Record<string, unknown> }];
    expect(spawnParams.spec["autonomy"]).toBe("full");
  });

  // CROSS-PROVIDER-MCP-STORE: SpawnCard previously had zero references to "orchestration" at
  // all — every app-spawned agent silently got orchestration:{allow:false}, with no control to
  // change it. These pin the new chip's three states.
  it("orchestration defaults to auto — omitted from the spec entirely", async () => {
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [promptInput] = byAttr(tree, "data-spawn-field", "prompt");
    act(() => { (promptInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "do the thing" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [cwdInput] = byAttr(tree, "data-path-picker", "spawn-cwd");
    act(() => { (cwdInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "/Users/dev/proj" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [submitBtn] = byAttr(tree, "data-spawn-submit");
    act(() => { (submitBtn!.props["onClick"] as () => void)(); });

    const spawnCall = rpcImpl.mock.calls.find(([method]) => method === "agent.spawn");
    const [, spawnParams] = spawnCall as [string, { spec: Record<string, unknown> }];
    expect(spawnParams.spec["orchestration"]).toBeUndefined();
  });

  it("picking the \"on\" chip sends orchestration:{allow:true} in the spec", async () => {
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [promptInput] = byAttr(tree, "data-spawn-field", "prompt");
    act(() => { (promptInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "do the thing" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [cwdInput] = byAttr(tree, "data-path-picker", "spawn-cwd");
    act(() => { (cwdInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "/Users/dev/proj" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [onChip] = byAttr(tree, "data-spawn-orchestration", "on");
    act(() => { (onChip!.props["onClick"] as () => void)(); });
    tree = renderer.toJSON() as TreeNode;
    const [submitBtn] = byAttr(tree, "data-spawn-submit");
    act(() => { (submitBtn!.props["onClick"] as () => void)(); });

    const spawnCall = rpcImpl.mock.calls.find(([method]) => method === "agent.spawn");
    const [, spawnParams] = spawnCall as [string, { spec: Record<string, unknown> }];
    expect(spawnParams.spec["orchestration"]).toEqual({ allow: true });
  });

  it("picking the \"off\" chip sends orchestration:{allow:false} explicitly", async () => {
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [promptInput] = byAttr(tree, "data-spawn-field", "prompt");
    act(() => { (promptInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "do the thing" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [cwdInput] = byAttr(tree, "data-path-picker", "spawn-cwd");
    act(() => { (cwdInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "/Users/dev/proj" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [offChip] = byAttr(tree, "data-spawn-orchestration", "off");
    act(() => { (offChip!.props["onClick"] as () => void)(); });
    tree = renderer.toJSON() as TreeNode;
    const [submitBtn] = byAttr(tree, "data-spawn-submit");
    act(() => { (submitBtn!.props["onClick"] as () => void)(); });

    const spawnCall = rpcImpl.mock.calls.find(([method]) => method === "agent.spawn");
    const [, spawnParams] = spawnCall as [string, { spec: Record<string, unknown> }];
    expect(spawnParams.spec["orchestration"]).toEqual({ allow: false });
  });
});

// ROLES-UNIFY S6 (docs/superpowers/specs/2026-07-28-roles-unify.md §6.5/§8 S6): role.list
// now returns the WHOLE unified library, including team-qualified (`<team>.<key>`) names
// created by S2's migration — the picker default-filters those out, with an "advanced"
// toggle to reach them.
const ROLE_LIST_ROWS = [
  { name: "aws" },
  { name: "review" },
  { name: "chimera-dev.worker" },
  { name: "chimera-dev.codex-worker" },
];

function mockRpcWithRoles(roleRows: unknown[] = ROLE_LIST_ROWS): void {
  rpcImpl.mockImplementation(async (method: string, params?: unknown) => {
    if (method === "providers.list") return [CLAUDE, CODEX, XAI, NVIDIA];
    if (method === "accounts.list") return ACCOUNTS;
    if (method === "role.list") return roleRows;
    if (method === "providers.models") {
      const provider = (params as { provider: string }).provider;
      const row = [CLAUDE, CODEX, XAI, NVIDIA].find((r) => r.id === provider);
      return { models: row?.models ?? [], source: "catalog" };
    }
    return {};
  });
}

describe("SpawnCard — role picker: qualified-name filtering", () => {
  it("hides team-qualified (dotted) names by default", async () => {
    mockRpcWithRoles();
    const renderer = await renderSpawnCard();
    const [roleSelect] = byAttr(renderer.toJSON() as TreeNode, "data-spawn-field", "role");
    const options = (roleSelect!.children ?? []) as TreeNode[];
    expect(options.map((o) => o.props["value"])).toEqual(["", "aws", "review"]);
  });

  it("the advanced toggle reveals team-qualified names, and toggling back hides them again", async () => {
    mockRpcWithRoles();
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [toggle] = byAttr(tree, "data-spawn-role-advanced");
    expect(toggle!.props["data-spawn-role-advanced"]).toBe("off");

    act(() => { (toggle!.props["onClick"] as () => void)(); });
    tree = renderer.toJSON() as TreeNode;
    let [roleSelect] = byAttr(tree, "data-spawn-field", "role");
    let options = (roleSelect!.children ?? []) as TreeNode[];
    expect(options.map((o) => o.props["value"])).toEqual([
      "", "aws", "review", "chimera-dev.worker", "chimera-dev.codex-worker",
    ]);
    const [toggleOn] = byAttr(tree, "data-spawn-role-advanced");
    expect(toggleOn!.props["data-spawn-role-advanced"]).toBe("on");

    act(() => { (toggleOn!.props["onClick"] as () => void)(); });
    tree = renderer.toJSON() as TreeNode;
    [roleSelect] = byAttr(tree, "data-spawn-field", "role");
    options = (roleSelect!.children ?? []) as TreeNode[];
    expect(options.map((o) => o.props["value"])).toEqual(["", "aws", "review"]);
  });

  it("a picked qualified role stays selectable even when the fold is collapsed", async () => {
    mockRpcWithRoles();
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [toggle] = byAttr(tree, "data-spawn-role-advanced");
    act(() => { (toggle!.props["onClick"] as () => void)(); });
    tree = renderer.toJSON() as TreeNode;
    let [roleSelect] = byAttr(tree, "data-spawn-field", "role");
    act(() => { (roleSelect!.props["onChange"] as (e: unknown) => void)({ target: { value: "chimera-dev.worker" } }); });

    tree = renderer.toJSON() as TreeNode;
    const [toggleOn] = byAttr(tree, "data-spawn-role-advanced");
    act(() => { (toggleOn!.props["onClick"] as () => void)(); }); // fold back to simple

    tree = renderer.toJSON() as TreeNode;
    [roleSelect] = byAttr(tree, "data-spawn-field", "role");
    const options = (roleSelect!.children ?? []) as TreeNode[];
    expect(options.map((o) => o.props["value"])).toEqual(["", "aws", "review", "chimera-dev.worker"]);
    expect(roleSelect!.props["value"]).toBe("chimera-dev.worker");
  });
});

// ROLE-PERMISSION-REQUEST-STOMPED: picking a role from the UI without touching the profile
// field used to always spawn with on.permissionRequest:"tui", stomping the role's own
// declared value (e.g. "auto") — commands.agents.ts's spawnAgent had no explicit signal to
// tell it apart from "no role, ask mode". SpawnCard.tsx now reads the picked role's own
// `on.permissionRequest` and threads it through explicitly.
const AWS_ROLE = { name: "aws", permissionProfile: "full", on: { permissionRequest: "auto" } };
const REVIEW_ROLE = { name: "review", permissionProfile: "acceptEdits", on: { permissionRequest: "auto" } };
// PERM-READONLY-FALSE-PROMPTS: a role whose default profile is "full" but which itself
// declares on.permissionRequest:"tui" — the exact shape that used to silently defeat
// full's "no approval prompts" promise (every gated tool call still raised a card) whenever
// the operator left the profile field blank to inherit the role's own "full" default.
const FULL_TUI_ROLE = { name: "aws-cost-analyzer", permissionProfile: "full", on: { permissionRequest: "tui" } };

describe("SpawnCard — role-sourced on.permissionRequest survives (ROLE-PERMISSION-REQUEST-STOMPED)", () => {
  // appStore's default permissionMode is "bypass" (ui-state's initial state) — that forces
  // effectiveProfile:"full" client-side regardless of role, masking exactly the
  // no-explicit-signal gap this describe block exists to cover. Ask mode is the actual
  // everyday case ("the operator actually spawns agents" — bypass is an opt-in toggle).
  beforeEach(() => { appStore.dispatch({ type: "permissionMode", mode: "ask" }); });

  async function pickRoleAndSubmit(roleName: string): Promise<Record<string, unknown>> {
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [promptInput] = byAttr(tree, "data-spawn-field", "prompt");
    act(() => { (promptInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "do the thing" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [cwdInput] = byAttr(tree, "data-path-picker", "spawn-cwd");
    act(() => { (cwdInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "/Users/dev/proj" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [roleSelect] = byAttr(tree, "data-spawn-field", "role");
    act(() => { (roleSelect!.props["onChange"] as (e: unknown) => void)({ target: { value: roleName } }); });

    tree = renderer.toJSON() as TreeNode;
    const [submitBtn] = byAttr(tree, "data-spawn-submit");
    act(() => { (submitBtn!.props["onClick"] as () => void)(); });

    const spawnCall = rpcImpl.mock.calls.find(([method]) => method === "agent.spawn");
    expect(spawnCall).toBeTruthy();
    const [, spawnParams] = spawnCall as [string, { spec: Record<string, unknown> }];
    return spawnParams.spec;
  }

  it("aws role (full + auto), profile field untouched — effective on.permissionRequest is auto", async () => {
    mockRpcWithRoles([AWS_ROLE, REVIEW_ROLE]);
    const spec = await pickRoleAndSubmit("aws");
    expect(spec["on"]).toEqual({ permissionRequest: "auto" });
    expect(spec["permissionProfile"]).toBeUndefined(); // matches role default, dropped by the diff
  });

  it("review role (acceptEdits + auto), profile field untouched — effective on.permissionRequest is auto", async () => {
    mockRpcWithRoles([AWS_ROLE, REVIEW_ROLE]);
    const spec = await pickRoleAndSubmit("review");
    expect(spec["on"]).toEqual({ permissionRequest: "auto" });
  });

  it("PERM-READONLY-FALSE-PROMPTS: full-profile role declaring on.permissionRequest:tui, profile field untouched — resolved profile is full so permissionRequest is forced auto, not stomped-through tui", async () => {
    mockRpcWithRoles([FULL_TUI_ROLE]);
    const spec = await pickRoleAndSubmit("aws-cost-analyzer");
    expect(spec["on"]).toEqual({ permissionRequest: "auto" });
    expect(spec["permissionProfile"]).toBeUndefined(); // matches role default, dropped by the diff
  });

  it("an operator-typed profile explicitly diverging from the role still wins — on.permissionRequest stays tui", async () => {
    mockRpcWithRoles([AWS_ROLE, REVIEW_ROLE]);
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [promptInput] = byAttr(tree, "data-spawn-field", "prompt");
    act(() => { (promptInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "do the thing" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [cwdInput] = byAttr(tree, "data-path-picker", "spawn-cwd");
    act(() => { (cwdInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "/Users/dev/proj" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [roleSelect] = byAttr(tree, "data-spawn-field", "role");
    act(() => { (roleSelect!.props["onChange"] as (e: unknown) => void)({ target: { value: "aws" } }); });
    tree = renderer.toJSON() as TreeNode;
    const [profileInput] = byAttr(tree, "data-spawn-field", "profile");
    act(() => { (profileInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "acceptEdits" } }); });

    tree = renderer.toJSON() as TreeNode;
    const [submitBtn] = byAttr(tree, "data-spawn-submit");
    act(() => { (submitBtn!.props["onClick"] as () => void)(); });

    const spawnCall = rpcImpl.mock.calls.find(([method]) => method === "agent.spawn");
    const [, spawnParams] = spawnCall as [string, { spec: Record<string, unknown> }];
    expect(spawnParams.spec["permissionProfile"]).toBe("acceptEdits");
    expect(spawnParams.spec["on"]).toEqual({ permissionRequest: "tui" });
  });
});

// ROLES-UNIFY §6.5/§8 S6 acceptance: "sessionRoleOverrides recorded on spawn matches the
// ACTUAL diff — test with a case where the operator changes exactly one field and
// everything else is inherited, assert the other keys are absent (not undefined-valued)."
// Tested directly against the exported pure diff function rather than through the full
// commands.agents.ts → agent.spawn round trip: that round trip has its own pre-existing,
// unrelated fallback for `isolation` (`input.isolation ?? "none"`, commands.agents.ts) that
// rides along on every spawn regardless of role — see computeRoleSpecOverrides's own
// call site comment in SpawnCard.tsx. Testing the diff function in isolation proves the
// slice's actual claim (the computed override bag is exactly the changed fields) without
// that unrelated confound.
describe("SpawnCard — computeRoleSpecOverrides", () => {
  const role: Record<string, unknown> = {
    name: "aws",
    account: "main",
    provider: "claude",
    permissionProfile: "full",
    model: "claude-opus-4-8",
    isolation: "none",
    deliverTo: "main",
    maxBudgetUsd: 5,
    conductor: false,
    session: false,
  };

  it("changing exactly one field yields a patch with only that field — other keys absent, not undefined", () => {
    const submitted = {
      account: "main",
      provider: "claude",
      permissionProfile: "full",
      model: "claude-sonnet-5",   // the one changed field
      isolation: "none",
      deliverTo: "main",
      maxBudgetUsd: 5,
    };
    const overrides = computeRoleSpecOverrides(role, submitted);
    expect(Object.keys(overrides)).toEqual(["model"]);
    expect(overrides["model"]).toBe("claude-sonnet-5");
    // Not just falsy/undefined-valued — the keys must be genuinely ABSENT, or a later
    // JSON.stringify/Object.keys on the audit record would see a phantom "changed to
    // undefined" entry for every field the operator merely happened to submit unchanged.
    for (const key of ["account", "provider", "permissionProfile", "isolation", "deliverTo", "maxBudgetUsd"]) {
      expect(key in overrides).toBe(false);
    }
  });

  it("submitting nothing new (every field matches the role) yields an empty patch", () => {
    const submitted = { account: "main", provider: "claude", model: "claude-opus-4-8" };
    expect(computeRoleSpecOverrides(role, submitted)).toEqual({});
  });

  it("a field the form never sends but the role sets is never mistaken for a change", () => {
    // The role sets `permissionProfile` and `deliverTo`; the operator's submitted bag
    // omits both entirely (never touched the corresponding form fields) — they must NOT
    // appear in the patch as "changed to undefined".
    const submitted = { model: "claude-haiku-4-5" };
    const overrides = computeRoleSpecOverrides(role, submitted);
    expect(Object.keys(overrides)).toEqual(["model"]);
    expect("permissionProfile" in overrides).toBe(false);
    expect("deliverTo" in overrides).toBe(false);
  });
});

// SPAWN-ROLE-OVERRIDES: a library role could be PICKED at spawn but not TUNED — the form had no
// `effort` field at all, and no way to see (let alone tweak) the role's own instructions. Both
// are now prefilled FROM the picked role so the operator can see what they are changing, which
// only works because of the diff below: anything left untouched must drop back out. Without
// that, opening the panel and changing nothing would pin every prefilled value onto the spawn —
// turning "inherits the role" into "frozen copy of the role as it looked today", exactly the
// drift a shared library exists to prevent.
describe("SpawnCard — role overrides at spawn (effort / role prompt)", () => {
  const role: Record<string, unknown> = {
    name: "review",
    model: "claude-sonnet-5",
    effort: "medium",
    instructions: "Review the diff. Report defects only.",
    permissionProfile: "readOnly",
  };

  it("prefilled-but-untouched effort + instructions pin NOTHING", () => {
    expect(computeRoleSpecOverrides(role, { effort: "medium", instructions: role["instructions"] })).toEqual({});
  });

  it("a changed effort rides through as an override, and only that field", () => {
    expect(computeRoleSpecOverrides(role, { effort: "high", instructions: role["instructions"] }))
      .toEqual({ effort: "high" });
  });

  it("a tweaked role prompt overrides only the prompt — the library entry's other fields stay inherited", () => {
    const tweaked = `${role["instructions"] as string} Also check the migration files.`;
    const out = computeRoleSpecOverrides(role, { effort: "medium", instructions: tweaked });
    expect(out).toEqual({ instructions: tweaked });
    expect("model" in out).toBe(false);
    expect("permissionProfile" in out).toBe(false);
  });

  it("several overrides at once stay separate", () => {
    expect(computeRoleSpecOverrides(role, { effort: "high", model: "claude-opus-5", instructions: role["instructions"] }))
      .toEqual({ effort: "high", model: "claude-opus-5" });
  });
});

// F41.2: the tool-surface row is informational-only (no data-spawn-* attribute, not in FIELDS —
// see SpawnCard.tsx's `surface` useMemo comment), so it can't be found via this file's dominant
// byAttr/toJSON idiom. Mirrors AgentDetailPanel.test.tsx's label-text-then-.parent walk instead.
describe("SpawnCard — tool surface row (F41)", () => {
  function toolSurfaceRowText(renderer: ReturnType<typeof create>): string {
    const label = renderer.root.findAllByType("span").find((n) => n.children.includes("tool surface"));
    const row = label!.parent!;
    return row.findAllByType("span").map((s) => s.children.join("")).join("");
  }

  it("shows 'no chimera MCP grant' when orchestration is off (the default, no role picked)", async () => {
    const renderer = await renderSpawnCard();
    const text = toolSurfaceRowText(renderer);
    expect(text).toContain("no chimera MCP grant — 0 tok");
  });

  it("shows the local estimate once orchestration is switched on", async () => {
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [onChip] = byAttr(tree, "data-spawn-orchestration", "on");
    act(() => { (onChip!.props["onClick"] as () => void)(); });

    const text = toolSurfaceRowText(renderer);
    expect(text).toContain("chimera MCP ~");
    expect(text).toContain("tools");
    expect(text).not.toContain("no chimera MCP grant");
  });

  it("toggling the permission profile does not move the local figure — surface only depends on orchestration/autonomy/conductor", async () => {
    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [onChip] = byAttr(tree, "data-spawn-orchestration", "on");
    act(() => { (onChip!.props["onClick"] as () => void)(); });
    const before = toolSurfaceRowText(renderer);

    tree = renderer.toJSON() as TreeNode;
    const [profileInput] = byAttr(tree, "data-spawn-field", "profile");
    act(() => { (profileInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "readOnly" } }); });
    const after = toolSurfaceRowText(renderer);

    expect(after).toBe(before);
  });

  it("renders the daemon's unpriced + measured spans once agent.estimateToolSurface resolves past the 250ms debounce", async () => {
    rpcImpl.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "providers.list") return [CLAUDE, CODEX, XAI, NVIDIA];
      if (method === "accounts.list") return ACCOUNTS;
      if (method === "providers.models") {
        const provider = (params as { provider: string }).provider;
        const row = [CLAUDE, CODEX, XAI, NVIDIA].find((r) => r.id === provider);
        return { models: row?.models ?? [], source: "catalog" };
      }
      if (method === "agent.estimateToolSurface") {
        return {
          // QA F41-2/3: every member of the protocol's unpriced `kind` union, each of which
          // gets its OWN operator-facing explanation (SpawnCard's UNPRICED_WHY) -- the previous
          // single hardcoded "resolved inside the provider CLI" clause was false for two of them.
          // (`kind: "mcp"` used to sit here: not a member of the union at all, so it pinned nothing.)
          unpriced: [
            { source: "role-cli", kind: "settings", count: 3, reason: "from ~/.claude/settings.json" },
            { source: "marketplace", kind: "plugins", count: 2, reason: "from an installed plugin" },
            { source: "spec-servers", kind: "spec-mcp", count: 1, reason: "declared on this spawn spec" },
            { source: "store-slack", kind: "store-direct", count: 4, reason: "connected by the agent itself" },
          ],
          measured: { medianCacheWriteTokens: 4200, minTokens: 3900, maxTokens: 4600, n: 5, servers: ["chimera", "github"] },
        };
      }
      return {};
    });

    const renderer = await renderSpawnCard();
    let tree = renderer.toJSON() as TreeNode;
    const [onChip] = byAttr(tree, "data-spawn-orchestration", "on");
    act(() => { (onChip!.props["onClick"] as () => void)(); });

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });

    const text = toolSurfaceRowText(renderer);
    // one line PER component, each with the explanation that is actually true of its kind.
    expect(text).toContain("not counted: role-cli (3) — loaded inside the provider CLI");
    expect(text).toContain("not counted: marketplace (2) — loaded inside the provider CLI");
    expect(text).toContain("not counted: spec-servers (1) — this spawn's own MCP servers");
    expect(text).toContain("not counted: store-slack (4) — MCP-store servers this agent connects to itself");
    // QA F41-4: three numbers in one sentence, all in the SAME format (fmtTokens).
    expect(text).toContain(
      "measured: 5 comparable past spawns wrote 4.2k tok median (min 3.9k / max 4.6k) over chimera, github"
      + " — an observational contrast over recent records, not a controlled estimate",
    );
  });

  // QA of F41: every agent record that predates toolSurfaceServers still counts toward the
  // measured cohort (the engine only requires toolSurfaceCacheWriteTokens), so the server union
  // is empty on real data today -- the clause must disappear rather than trail off mid-sentence.
  it("omits the server clause entirely when the measured cohort reports no servers", async () => {
    rpcImpl.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "providers.list") return [CLAUDE, CODEX, XAI, NVIDIA];
      if (method === "accounts.list") return ACCOUNTS;
      if (method === "providers.models") {
        const provider = (params as { provider: string }).provider;
        const row = [CLAUDE, CODEX, XAI, NVIDIA].find((r) => r.id === provider);
        return { models: row?.models ?? [], source: "catalog" };
      }
      if (method === "agent.estimateToolSurface") {
        return { unpriced: [], measured: { medianCacheWriteTokens: 33536, minTokens: 31608, maxTokens: 39405, n: 3, servers: [] } };
      }
      return {};
    });

    const renderer = await renderSpawnCard();
    const tree = renderer.toJSON() as TreeNode;
    const [onChip] = byAttr(tree, "data-spawn-orchestration", "on");
    act(() => { (onChip!.props["onClick"] as () => void)(); });

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });

    const text = toolSurfaceRowText(renderer);
    // The tail wording ("an observational contrast over recent records") legitimately contains
    // "over", so assert the WHOLE sentence: it pins both the absent server clause and the
    // uniform fmtTokens formatting of the median/min/max triple (QA F41-4).
    expect(text).toContain(
      "measured: 3 comparable past spawns wrote 33.5k tok median (min 31.6k / max 39.4k)"
      + " — an observational contrast over recent records, not a controlled estimate",
    );
  });
});


describe("quick spawn routing", () => {
  it("prefers advertised flagship models without hardcoding a release", () => {
    expect(quickSpawnModel("claude", ["claude-sonnet-5", "claude-opus-4-8", "claude-opus-5-5"], "old")).toBe("claude-opus-5-5");
    expect(quickSpawnModel("codex", ["gpt-6-sol", "gpt-6-astra", "gpt-5.6-sol"], "old")).toBe("gpt-6-astra");
    expect(quickSpawnModel("codex", ["gpt-5.6-sol"], "unavailable")).toBe("gpt-5.6-sol");
  });

  it("shows only routing fields and submits the selected second account with session defaults", async () => {
    const renderer = await renderSpawnCard(true);
    const fields = () => byAttr(renderer.toJSON() as TreeNode, "data-spawn-field");
    expect(fields().map(node => node.props["data-spawn-field"])).toEqual(["provider", "account", "model"]);
    expect(fields().find(node => node.props["data-spawn-field"] === "model")!.props.value).toBe(CLAUDE.models[0]);
    await act(async () => {
      (fields().find(node => node.props["data-spawn-field"] === "account")!.props.onChange as Function)({ target: { value: "claude-2" } });
    });
    await act(async () => { (byAttr(renderer.toJSON() as TreeNode, "data-spawn-submit")[0]!.props.onClick as Function)(); });
    const spec = (rpcImpl.mock.calls.find(([method]) => method === "agent.spawn")?.[1] as { spec: Record<string, unknown> }).spec;
    expect(spec).toMatchObject({ provider: "claude", account: "claude-2", model: CLAUDE.models[0], session: true,
      autonomy: "full", compactionThreshold: 500000, maxTurns: 120, isolation: "none", resume: null, resumeOnly: true,
      orchestration: { allow: true } });
    act(() => renderer.unmount());
  });

  it("switches provider, account and default model together and preserves an explicit model pick", async () => {
    mockRpc([CLAUDE, { ...CODEX, models: ["gpt-6-sol", "gpt-6-astra"] }]);
    const renderer = await renderSpawnCard(true);
    const field = (name: string) => byAttr(renderer.toJSON() as TreeNode, "data-spawn-field", name)[0]!;
    await act(async () => { (field("provider").props.onChange as Function)({ target: { value: "codex" } }); });
    expect(field("account").props.value).toBe("codex");
    expect(field("model").props.value).toBe("gpt-6-astra");
    expect(JSON.stringify(field("account"))).not.toContain("claude-2");
    await act(async () => { (field("model").props.onChange as Function)({ target: { value: "gpt-6-sol" } }); });
    await act(async () => { (byAttr(renderer.toJSON() as TreeNode, "data-spawn-submit")[0]!.props.onClick as Function)(); });
    const spec = (rpcImpl.mock.calls.find(([method]) => method === "agent.spawn")?.[1] as { spec: Record<string, unknown> }).spec;
    expect(spec).toMatchObject({ provider: "codex", account: "codex", model: "gpt-6-sol" });
    act(() => renderer.unmount());
  });
});
