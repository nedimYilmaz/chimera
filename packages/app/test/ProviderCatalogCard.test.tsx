import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { ProviderCatalogCard } from "../src/components/ProviderCatalogCard";
import { buildProviderCatalogRows, type ProviderCatalogItem } from "../src/state/selectors.settings";
import type { ProviderOAuthState } from "../src/state/commands.settings";

// F23-2B (D5/D6) — the Providers section's per-provider catalog card: a real
// render pass via react-test-renderer, same harness as WorkflowCard.test.tsx/
// TaskInspector.test.tsx (find-by-predicate + act(() => props.onClick())).

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}

function hasClass(n: TreeNode, re: RegExp): boolean {
  const c = n.props["className"];
  return typeof c === "string" && re.test(c);
}

function byAttr(tree: TreeNode, attr: string, value?: string): TreeNode[] {
  return findAll(tree, (n) => attr in n.props && (value === undefined || n.props[attr] === value));
}

const XAI: ProviderCatalogItem = {
  id: "xai", label: "xAI (Grok)", kind: "openai-compat",
  baseUrl: "https://api.x.ai/v1", defaultModel: "grok-4.5",
  authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: false },
  tosNote: null, experimental: false, override: null, accounts: [],
};

const CLAUDE: ProviderCatalogItem = {
  id: "claude", label: "Claude", kind: "agentic-sdk",
  baseUrl: "https://api.anthropic.com", defaultModel: "claude-opus-4-8",
  authModes: ["apiKey", "oauth"], capabilities: { tools: true, vision: true, streaming: true },
  tosNote: "Pro/Max subscription access rides the official SDK login.", experimental: false, override: null,
  accounts: [{ name: "main", authType: "subscription" }],
};

const COPILOT: ProviderCatalogItem = {
  id: "copilot", label: "GitHub Copilot", kind: "openai-compat",
  // baseUrl is the EFFECTIVE value (as providers.list returns it — override
  // already merged in server-side), consistent with `override` being set.
  baseUrl: "https://proxy/v1", defaultModel: "gpt-5.1",
  authModes: ["oauth"], capabilities: { tools: true, vision: false, streaming: true },
  tosNote: null, experimental: true, override: { baseUrl: "https://proxy/v1" }, accounts: [],
};

function renderCard(item: ProviderCatalogItem, handlers: Partial<{
  onAddKey: () => void; onTest: (n: string) => void; onRemove: (n: string) => void;
  onSaveOverride: (v: { baseUrl?: string; defaultModel?: string; compactionThreshold?: number | null } | null) => void;
  onConnectSubscription: () => void; onCancelOAuth: () => void;
  oauth: ProviderOAuthState; tests: Record<string, "ok" | "auth_error" | "admin_key">;
}> = {}) {
  const row = buildProviderCatalogRows([item], handlers.tests ?? {})[0]!;
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      React.createElement(ProviderCatalogCard, {
        row,
        onAddKey: handlers.onAddKey ?? (() => {}),
        onTest: handlers.onTest ?? (() => {}),
        onRemove: handlers.onRemove ?? (() => {}),
        onSaveOverride: handlers.onSaveOverride ?? (() => {}),
        onConnectSubscription: handlers.onConnectSubscription ?? (() => {}),
        onCancelOAuth: handlers.onCancelOAuth ?? (() => {}),
        oauth: handlers.oauth,
      }),
    );
  });
  return renderer;
}

describe("ProviderCatalogCard — render", () => {
  it("renders capability chips on/off", () => {
    const tree = renderCard(XAI).toJSON() as TreeNode;
    const chips = findAll(tree, (n) => hasClass(n, /chipOn|chipOff/));
    expect(chips).toHaveLength(3);
    expect(chips.map((c) => (hasClass(c, /chipOn/) ? "on" : "off"))).toEqual(["on", "on", "off"]);
  });

  it("shows 'not connected' for a provider with no accounts, and the account name otherwise", () => {
    const notConnected = renderCard(XAI).toJSON() as TreeNode;
    const [state1] = byAttr(notConnected, "data-connection-state");
    expect(state1!.children).toEqual(["not connected"]);

    const connected = renderCard(CLAUDE).toJSON() as TreeNode;
    const [state2] = byAttr(connected, "data-connection-state");
    expect(state2!.children).toEqual(["1 account"]);
    expect(byAttr(connected, "data-connected-accounts")).toHaveLength(1);
  });

  it("shows tosNote prominently only for oauth/subscription providers", () => {
    const claudeTree = renderCard(CLAUDE).toJSON() as TreeNode;
    expect(byAttr(claudeTree, "data-tos-note")).toHaveLength(1);

    // xai has no oauth authMode and no tosNote — nothing rendered.
    const xaiTree = renderCard(XAI).toJSON() as TreeNode;
    expect(byAttr(xaiTree, "data-tos-note")).toHaveLength(0);
  });

  it("marks an experimental catalog entry", () => {
    const tree = renderCard(COPILOT).toJSON() as TreeNode;
    expect(byAttr(tree, "data-experimental")).toHaveLength(1);
  });

  it("shows 'overridden' when the provider has a config override", () => {
    const tree = renderCard(COPILOT).toJSON() as TreeNode;
    expect(JSON.stringify(tree)).toContain("overridden");
    // an un-overridden provider shows no such marker.
    const plain = renderCard(XAI).toJSON() as TreeNode;
    expect(JSON.stringify(plain)).not.toContain("overridden");
  });

  it("KIMI-CODE-SUBSCRIPTION-UI: ONE 'connect with subscription' button per provider, routed by mechanism", () => {
    // CLAUDE (agentic-sdk): the button is present and already connected (a
    // subscription account exists) — enabled, checkmark styling.
    const claude = renderCard(CLAUDE).toJSON() as TreeNode;
    const [claudeBtn] = byAttr(claude, "data-catalog-connect-subscription", "claude");
    expect(claudeBtn).toBeTruthy();
    expect(claudeBtn!.props["disabled"]).toBe(true); // disabled BECAUSE already connected, not because unavailable
    expect(JSON.stringify(claudeBtn)).toContain("connected with subscription");

    // COPILOT (openai-compat, authModes:["oauth"], no CLI login): the SAME button
    // renders, no accounts yet — enabled and clickable (F23-2A shipped; this used
    // to be a permanently-disabled "coming soon" placeholder).
    const copilot = renderCard(COPILOT).toJSON() as TreeNode;
    const [copilotBtn] = byAttr(copilot, "data-catalog-connect-subscription", "copilot");
    expect(copilotBtn).toBeTruthy();
    expect(copilotBtn!.props["disabled"]).toBeFalsy();
    expect(JSON.stringify(copilotBtn)).toContain("connect with subscription");
    expect(copilotBtn!.props["title"]).not.toBe("coming soon");

    // XAI (apiKey-only, no oauth, not agentic-sdk): no button at all.
    const xaiTree = renderCard(XAI).toJSON() as TreeNode;
    expect(byAttr(xaiTree, "data-catalog-connect-subscription")).toHaveLength(0);
  });

  it("the oauth branch shows a busy state while connecting, and an error message on failure", () => {
    const connecting = renderCard(COPILOT, { oauth: { status: "starting" } }).toJSON() as TreeNode;
    const [busyBtn] = byAttr(connecting, "data-catalog-connect-subscription", "copilot");
    expect(busyBtn!.props["disabled"]).toBe(true);
    expect(JSON.stringify(busyBtn)).toContain("connecting…");
    expect(byAttr(connecting, "data-catalog-oauth-cancel", "copilot")).toHaveLength(1);

    const errored = renderCard(COPILOT, { oauth: { status: "error", error: "provider \"copilot\" is experimental" } }).toJSON() as TreeNode;
    const [errBox] = byAttr(errored, "data-catalog-oauth-error", "copilot");
    expect(errBox!.children).toEqual(["provider \"copilot\" is experimental"]);
  });

  it("the oauth branch shows a device code + authorize link while awaiting user action", () => {
    const awaiting = renderCard(COPILOT, {
      oauth: { status: "awaiting", pendingId: "p1", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" },
    }).toJSON() as TreeNode;
    const [codeEl] = byAttr(awaiting, "data-catalog-oauth-code", "copilot");
    expect(JSON.stringify(codeEl)).toContain("ABCD-1234");
    expect(JSON.stringify(codeEl)).toContain("https://github.com/login/device");
  });

  it("an oauth account with a failed test probe does NOT show the green connected checkmark", () => {
    const oauthAccounts: ProviderCatalogItem = { ...COPILOT, accounts: [{ name: "copilot", authType: "oauth" }] };
    const untested = renderCard(oauthAccounts).toJSON() as TreeNode;
    const [okBtn] = byAttr(untested, "data-catalog-connect-subscription", "copilot");
    expect(JSON.stringify(okBtn)).toContain("connected with subscription"); // no test yet -> optimistic

    const failed = renderCard(oauthAccounts, { tests: { copilot: "auth_error" } }).toJSON() as TreeNode;
    const [brokenBtn] = byAttr(failed, "data-catalog-connect-subscription", "copilot");
    expect(JSON.stringify(brokenBtn)).not.toContain("connected with subscription");
    expect(JSON.stringify(brokenBtn)).toContain("connect with subscription");
  });

  it("only renders 'add api key' when the provider supports apiKey auth", () => {
    expect(byAttr(renderCard(XAI).toJSON() as TreeNode, "data-catalog-add-key")).toHaveLength(1);
    expect(byAttr(renderCard(COPILOT).toJSON() as TreeNode, "data-catalog-add-key")).toHaveLength(0); // oauth-only
  });
});

describe("ProviderCatalogCard — interaction", () => {
  it("'add api key' invokes onAddKey", () => {
    let called = false;
    const renderer = renderCard(XAI, { onAddKey: () => { called = true; } });
    const [btn] = byAttr(renderer.toJSON() as TreeNode, "data-catalog-add-key", "xai");
    act(() => { (btn!.props["onClick"] as () => void)(); });
    expect(called).toBe(true);
  });

  it("per-account test/remove invoke onTest/onRemove with the account name", () => {
    const seenTest: string[] = [];
    const seenRemove: string[] = [];
    const renderer = renderCard(CLAUDE, { onTest: (n) => seenTest.push(n), onRemove: (n) => seenRemove.push(n) });
    const tree = renderer.toJSON() as TreeNode;
    const [testBtn] = byAttr(tree, "data-catalog-test", "main");
    const [removeBtn] = byAttr(tree, "data-catalog-remove", "main");
    act(() => { (testBtn!.props["onClick"] as () => void)(); });
    act(() => { (removeBtn!.props["onClick"] as () => void)(); });
    expect(seenTest).toEqual(["main"]);
    expect(seenRemove).toEqual(["main"]);
  });

  it("editing the base-URL/model override and saving calls onSaveOverride with the parsed value", () => {
    const seen: Array<{ baseUrl?: string; defaultModel?: string } | null> = [];
    const renderer = renderCard(XAI, { onSaveOverride: (v) => seen.push(v) });

    const [editBtn] = byAttr(renderer.toJSON() as TreeNode, "data-catalog-edit-override", "xai");
    act(() => { (editBtn!.props["onClick"] as () => void)(); });

    let tree = renderer.toJSON() as TreeNode;
    const [baseUrlInput] = byAttr(tree, "data-override-base-url");
    const [modelInput] = byAttr(tree, "data-override-model");
    act(() => { (baseUrlInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "https://proxy.internal/xai/v1" } }); });
    act(() => { (modelInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "grok-4.3" } }); });

    tree = renderer.toJSON() as TreeNode;
    const [saveBtn] = byAttr(tree, "data-override-save");
    act(() => { (saveBtn!.props["onClick"] as () => void)(); });

    expect(seen).toEqual([{ baseUrl: "https://proxy.internal/xai/v1", defaultModel: "grok-4.3" }]);
  });

  // EXPLICIT-NULL-ESCAPE: "use model native" is the only control that can produce an explicit
  // null threshold — a blank tokens field means "no opinion" and resolves to the fleet default.
  it("the native checkbox saves an explicit null threshold, disabling the tokens input", () => {
    const seen: Array<{ baseUrl?: string; defaultModel?: string; compactionThreshold?: number | null } | null> = [];
    const renderer = renderCard(XAI, { onSaveOverride: (v) => seen.push(v) });
    const [editBtn] = byAttr(renderer.toJSON() as TreeNode, "data-catalog-edit-override", "xai");
    act(() => { (editBtn!.props["onClick"] as () => void)(); });

    let tree = renderer.toJSON() as TreeNode;
    const [ctInput] = byAttr(tree, "data-override-compaction-threshold");
    const [nativeBox] = byAttr(tree, "data-override-compaction-native");
    expect(nativeBox!.props["checked"]).toBe(false);
    act(() => { (ctInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "90000" } }); });
    act(() => { (nativeBox!.props["onChange"] as (e: unknown) => void)({ target: { checked: true } }); });

    tree = renderer.toJSON() as TreeNode;
    expect(byAttr(tree, "data-override-compaction-threshold")[0]!.props["disabled"]).toBe(true);
    act(() => { (byAttr(tree, "data-override-save")[0]!.props["onClick"] as () => void)(); });

    expect(seen).toEqual([{ compactionThreshold: null }]);
  });

  it("a provider already on native pre-checks the box", () => {
    const native: ProviderCatalogItem = { ...XAI, override: { compactionThreshold: null } };
    const renderer = renderCard(native, {});
    const [editBtn] = byAttr(renderer.toJSON() as TreeNode, "data-catalog-edit-override", "xai");
    act(() => { (editBtn!.props["onClick"] as () => void)(); });
    const tree = renderer.toJSON() as TreeNode;
    expect(byAttr(tree, "data-override-compaction-native")[0]!.props["checked"]).toBe(true);
  });

  it("saving with both fields blanked out clears the override (null)", () => {
    const seen: Array<{ baseUrl?: string; defaultModel?: string } | null> = [];
    const renderer = renderCard(COPILOT, { onSaveOverride: (v) => seen.push(v) });
    const [editBtn] = byAttr(renderer.toJSON() as TreeNode, "data-catalog-edit-override", "copilot");
    act(() => { (editBtn!.props["onClick"] as () => void)(); });

    // the form pre-fills from the CURRENT (already-overridden) baseUrl/model —
    // explicitly blank both to express "clear this override".
    let tree = renderer.toJSON() as TreeNode;
    const [baseUrlInput] = byAttr(tree, "data-override-base-url");
    const [modelInput] = byAttr(tree, "data-override-model");
    act(() => { (baseUrlInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "" } }); });
    act(() => { (modelInput!.props["onChange"] as (e: unknown) => void)({ target: { value: "" } }); });

    tree = renderer.toJSON() as TreeNode;
    const [saveBtn] = byAttr(tree, "data-override-save");
    act(() => { (saveBtn!.props["onClick"] as () => void)(); });
    expect(seen).toEqual([null]);
  });
});
