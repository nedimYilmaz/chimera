import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// SELECTOR-STABILITY regression: opening this section blanked the whole app. Its `liveAgents`
// selector built a fresh array per call (`Object.values(...).filter(...).map(...)`), so
// useSyncExternalStore never saw an equal snapshot, and React resolved the loop by tearing the
// tree down. Same plain-node + shimmed-globals harness as AgentList.showDonePersist.test.tsx.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {}, removeEventListener: () => {},
    setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
}

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async (method: string) => (method === "secret.list" ? { secrets: [] } : {})),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { SecretsSection } from "../src/components/SecretsSection";
import { rpcCall as rpcCallRaw } from "../src/rpc/bridge";
import { appStore } from "../src/state/store";

const rpcCall = rpcCallRaw as unknown as ReturnType<typeof vi.fn>;

/** Mount with one STORED secret, so the per-secret grant picker and its buttons actually exist —
 *  with an empty list the section renders a hint and nothing else, and every assertion below
 *  would pass by having nothing to check. */
async function mountWithASecret(): Promise<void> {
  rpcCall.mockImplementation(async (method: string) =>
    (method === "secret.list"
      ? { secrets: [{ name: "aws/prod-key", description: "deploy key", updatedAt: 1, grants: [] }] }
      : {}) as never);
  await act(async () => { mounted = create(React.createElement(SecretsSection)); });
}

let mounted: ReturnType<typeof create> | null = null;
afterEach(() => { act(() => mounted?.unmount()); mounted = null; });

describe("SecretsSection mounts without looping the store", () => {
  it("renders with live agents present — the case whose fresh-array selector blanked the app", () => {
    appStore.dispatch({
      type: "agentRecords",
      records: [
        { agentId: "agent-one", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 },
        { agentId: "agent-two", state: "paused", accountName: "main", provider: "claude", costUsd: 0, createdAt: 2 },
      ],
    });
    expect(() => {
      act(() => { mounted = create(React.createElement(SecretsSection)); });
    }).not.toThrow();
    expect(mounted).not.toBeNull();
  });

  it("survives repeated unrelated dispatches — a loop would surface as a getSnapshot throw here", () => {
    act(() => { mounted = create(React.createElement(SecretsSection)); });
    expect(() => {
      act(() => {
        for (let i = 0; i < 25; i++) {
          appStore.dispatch({
            type: "agentRecords",
            records: [{ agentId: `a${i}`, state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: i }],
          });
        }
      });
    }).not.toThrow();
  });
});

// SECRET-GRANT-NAMES + styling. Reported together: "the inputs come out white, there are no proper
// gaps between them, and when I add a secret it does not fit the UI — and in the agent picker I
// only see ids, not the agents' names".
describe("the grant picker names agents the way the rest of the app does", () => {
  it("shows a resolved NAME, not a raw id, for an agent nobody renamed by hand", async () => {
    // The picker read displayLabel alone, which is unset for most agents, and fell through to an
    // 8-character id. displayName is the shared resolver every other surface uses — an operator
    // cannot grant a secret to "c8763e28" with any confidence about who that is.
    appStore.dispatch({
      type: "agentRecords",
      records: [{ agentId: "c8763e28-1111-2222-3333-444444444444", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
    });
    await mountWithASecret();
    const options = mounted!.root.findAllByType("option").map((o) => String(o.children[0] ?? ""));
    const agentOption = options.find((o) => o !== "Choose an agent…");
    expect(agentOption).toBeDefined();
    expect(agentOption).not.toBe("c8763e2");           // not the truncated id
    expect(agentOption!.startsWith("c8763e28-")).toBe(false);
  });

  it("gives every native control a class — a bare input renders user-agent white on a dark theme", async () => {
    // The same failure AgentSettingsCard hit: a native <input>/<select>/<button> inherits neither
    // the page's colour nor its font, so with no class it comes out white-on-dark and unreadable.
    await mountWithASecret();
    for (const type of ["input", "select", "button"] as const) {
      for (const node of mounted!.root.findAllByType(type)) {
        expect(String(node.props["className"] ?? ""), `<${type}> with no className`).not.toBe("");
      }
    }
  });
});


it("updates existing grants and the picker from a live rename", async () => {
  appStore.dispatch({ type: "agentRecords", records: [{ agentId: "rename-live", state: "running", displayLabel: "Old name", costUsd: 0, createdAt: 1 }] });
  rpcCall.mockImplementation(async (method: string) => method === "secret.list" ? { secrets: [{ name: 'key"with[chars]', description: "fixture", grants: [{ agentId: "rename-live", mode: "reveal", agentLabel: "stale cached label" }] }] } : {});
  await act(async () => { mounted = create(<SecretsSection />); });
  act(() => appStore.dispatch({ type: "event", event: { seq: 999991, ts: Date.now(), kind: "status", engineId: "local", agentId: "rename-live", data: { displayLabel: "Grafana audit" } } }));
  expect(JSON.stringify(mounted!.toJSON())).toContain("Grafana audit");
  expect(JSON.stringify(mounted!.toJSON())).not.toContain("stale cached label");
  const select = mounted!.root.findByProps({ 'data-secret-grant-agent': 'key"with[chars]' });
  act(() => select.props.onChange({ target: { value: "rename-live" } }));
  rpcCall.mockClear();
  await act(async () => { select.parent!.parent!.props.onSubmit({ preventDefault() {} }); });
  expect(rpcCall).toHaveBeenCalledWith("secret.grant", { name: 'key"with[chars]', agent: "rename-live", mode: "reveal" });
});

it("requires confirmation to delete and Cancel makes no write", async () => {
  await mountWithASecret(); rpcCall.mockClear();
  act(() => mounted!.root.findByProps({ 'data-secret-delete': 'aws/prod-key' }).props.onClick());
  expect(rpcCall).not.toHaveBeenCalled();
  const cancel = mounted!.root.findAllByType("button").find((b) => b.children.join("") === "Cancel")!;
  act(() => cancel.props.onClick());
  expect(rpcCall).not.toHaveBeenCalled();
});

it("keeps values write-only and clears a cancelled form", async () => {
  await mountWithASecret();
  const toggle = () => mounted!.root.findAllByType("button").find((b) => b.props['aria-expanded'] !== undefined)!;
  act(() => toggle().props.onClick());
  const input = mounted!.root.findByProps({ 'data-secret-value': true });
  expect(input.props.type).toBe("password");
  act(() => input.props.onChange({ target: { value: "synthetic-sensitive-value" } }));
  act(() => toggle().props.onClick());
  act(() => toggle().props.onClick());
  expect(mounted!.root.findByProps({ 'data-secret-value': true }).props.value).toBe("");
  expect(rpcCall.mock.calls.some(([method]) => method === "secret.get")).toBe(false);
});

it("does not grant access to an agent that terminated after selection", async () => {
  appStore.dispatch({ type: "agentRecords", records: [{ agentId: "ending-agent", state: "running", displayLabel: "Ending agent", costUsd: 0, createdAt: 1 }] });
  await mountWithASecret();
  const select = mounted!.root.findByProps({ 'data-secret-grant-agent': 'aws/prod-key' });
  act(() => select.props.onChange({ target: { value: "ending-agent" } }));
  act(() => appStore.dispatch({ type: "agentRecords", records: [{ agentId: "ending-agent", state: "killed", costUsd: 0, createdAt: 1 }] }));
  rpcCall.mockClear();
  await act(async () => { select.parent!.parent!.props.onSubmit({ preventDefault() {} }); });
  expect(rpcCall).not.toHaveBeenCalled();
});

it("requires explicit replacement and hides secret-bearing backend errors", async () => {
  await mountWithASecret();
  act(() => mounted!.root.findAllByType("button").find((b) => b.props['aria-expanded'] !== undefined)!.props.onClick());
  act(() => {
    mounted!.root.findByProps({ 'data-secret-name': true }).props.onChange({ target: { value: "aws/prod-key" } });
    mounted!.root.findByProps({ 'data-secret-value': true }).props.onChange({ target: { value: "synthetic-value" } });
  });
  rpcCall.mockClear();
  await act(async () => { mounted!.root.findByProps({ 'data-secret-name': true }).parent!.parent!.props.onSubmit({ preventDefault() {} }); });
  expect(rpcCall).not.toHaveBeenCalled();
  rpcCall.mockRejectedValueOnce(new Error("provider error contains synthetic-value"));
  await act(async () => { mounted!.root.findAllByType("button").find((b) => b.children.join("") === "Replace value")!.props.onClick(); });
  expect(mounted!.root.findByProps({ role: "alert" }).children.join("")).not.toContain("synthetic-value");
  expect(rpcCall).toHaveBeenCalledWith("secret.set", { name: "aws/prod-key", value: "synthetic-value" });
});
