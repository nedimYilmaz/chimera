import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const calls: Array<[string, unknown]> = [];
let catalog: unknown[] = [];
const rpcImpl = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  calls.push([method, params]);
  if (method === "providers.addCustom") {
    const p = params as Record<string, unknown>;
    catalog = [{ ...p, kind: "openai-compat", custom: true, accounts: [], authModes: p["requiresKey"] ? ["apiKey"] : [] }];
    return { id: p["id"] };
  }
  if (method === "providers.list") return catalog;
  if (method === "accounts.list") return [];
  if (method === "config.get") return { autoOrder: [] };
  if (method === "providers.models") return { models: ["live-model"], source: "live" };
  return {};
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  subscribeEvents: vi.fn(async () => {}), onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}), daemonStatus: vi.fn(async () => "connected"),
}));

import { AddCustomProviderForm, validateCustomProvider } from "../src/components/AddCustomProviderForm";

function field(root: ReturnType<typeof create>["root"], prop: string) { return root.findByProps({ [prop]: true }); }
function type(root: ReturnType<typeof create>["root"], prop: string, value: string) {
  act(() => field(root, prop).props.onChange({ target: { value } }));
}
function render(element: React.ReactElement) {
  let view!: ReturnType<typeof create>;
  act(() => { view = create(element); });
  return view;
}

describe("AddCustomProviderForm", () => {
  it("validates URL and collisions inline before making an RPC", async () => {
    expect(validateCustomProvider({ id: "openai", label: "X", baseUrl: "not-url", defaultModel: "m" }, ["openai"])).toContain("already exists");
    const view = render(<AddCustomProviderForm existingIds={[]} onDone={() => {}} />);
    type(view.root, "data-custom-provider-id", "local");
    type(view.root, "data-custom-provider-label", "Local");
    type(view.root, "data-custom-provider-url", "not-url");
    type(view.root, "data-custom-provider-model", "m");
    await act(async () => field(view.root, "data-custom-provider-save").props.onClick());
    expect(field(view.root, "data-custom-provider-error").children.join("")).toContain("valid base URL");
  });

  it("creates a no-key provider, account, and refreshes models", async () => {
    calls.length = 0; catalog = [];
    let done = false;
    const view = render(<AddCustomProviderForm existingIds={["openai"]} onDone={() => { done = true; }} />);
    type(view.root, "data-custom-provider-id", "ollama-local");
    type(view.root, "data-custom-provider-label", "Ollama local");
    type(view.root, "data-custom-provider-url", "http://127.0.0.1:11434/v1");
    type(view.root, "data-custom-provider-model", "qwen3");
    await act(async () => { field(view.root, "data-custom-provider-save").props.onClick(); await new Promise((r) => setTimeout(r, 0)); });
    expect(done).toBe(true);
    expect(calls.some(([m]) => m === "providers.addCustom")).toBe(true);
    expect(calls.some(([m]) => m === "accounts.add")).toBe(true);
    expect(calls.some(([m]) => m === "accounts.setKey")).toBe(false);
    expect(calls.some(([m, p]) => m === "providers.models" && (p as { refresh?: boolean }).refresh === true)).toBe(true);
  });

  it("stores a supplied key only after registering the keyed provider", async () => {
    calls.length = 0; catalog = [];
    const view = render(<AddCustomProviderForm existingIds={[]} onDone={() => {}} />);
    type(view.root, "data-custom-provider-id", "corp");
    type(view.root, "data-custom-provider-label", "Corp");
    type(view.root, "data-custom-provider-url", "https://llm.example.test/v1");
    type(view.root, "data-custom-provider-model", "corp-1");
    act(() => field(view.root, "data-custom-provider-requires-key").props.onChange({ target: { checked: true } }));
    type(view.root, "data-custom-provider-key", "sk-secret");
    await act(async () => { field(view.root, "data-custom-provider-save").props.onClick(); await new Promise((r) => setTimeout(r, 0)); });
    const methods = calls.map(([m]) => m);
    expect(methods.indexOf("providers.addCustom")).toBeLessThan(methods.indexOf("accounts.setKey"));
  });
});
