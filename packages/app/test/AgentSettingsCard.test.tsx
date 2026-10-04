import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// AGENT-RECONFIGURE / FORM-GEOMETRY: the settings card reuses SpawnCard's form classes, and they
// only work in that component's own structure — `.body` supplies the card's padding and background
// (without it the transcript showed straight through the card), and a FIELD is a `.row` of label +
// control. `.pair` is a two-column GRID meant to hold two rows; using it as a label-and-input line
// is what left every label in its own column, misaligned against its control.

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {}, removeEventListener: () => {},
    setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
}

// vi.mock is hoisted above every import, so the fn has to be created INSIDE the factory and
// pulled back out afterwards — referencing an outer const here throws "cannot access before
// initialization".
vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async (method: string) =>
    (method === "agent.status"
      ? { spec: { model: "claude-opus-5", maxTurns: 40, turnLimitPolicy: "fail", cwd: "/repo", instructions: "be brief" }, displayLabel: "infra" }
      : {}) as never),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { rpcCall as rpcCallRaw } from "../src/rpc/bridge";
import { AgentSettingsCard } from "../src/components/AgentSettingsCard";
import { appStore } from "../src/state/store";

const rpcCall = rpcCallRaw as unknown as ReturnType<typeof vi.fn>;

let mounted: ReturnType<typeof create> | null = null;
const DEFAULT_SPEC: Record<string, unknown> = { model: "claude-opus-5", maxTurns: 40, turnLimitPolicy: "fail", cwd: "/repo", instructions: "be brief" };
/** Seed the form from a different spec. Restored in afterEach, so it never leaks sideways. */
const withSpec = (spec: Record<string, unknown>): void => {
  rpcCall.mockImplementation(async (method: string) =>
    (method === "agent.status" ? { spec, displayLabel: "infra" } : {}) as never);
};
afterEach(() => {
  act(() => mounted?.unmount()); mounted = null; rpcCall.mockClear(); withSpec(DEFAULT_SPEC);
});

const mount = async (provider = "claude") => {
  appStore.dispatch({
    type: "agentRecords",
    records: [{ agentId: "a1", state: "running", accountName: "main", provider, costUsd: 0, createdAt: 1 }] as never,
  });
  await act(async () => {
    mounted = create(React.createElement(AgentSettingsCard, { agentId: "a1", onClose: () => {} }));
  });
};

const fieldNames = (): string[] =>
  mounted!.root.findAll((n) => n.props["data-settings-field"] !== undefined).map((n) => String(n.props["data-settings-field"]));

describe("the settings card's structure", () => {
  it("shows realtime only for Codex and applies on/off to that agent without a general reconfigure", async () => {
    const spec = { ...DEFAULT_SPEC, model: "gpt-6-astra", providerOptions: { codexRealtime: false } };
    rpcCall.mockImplementation(async (method: string, p: { enabled?: boolean }) => method === "agent.status" ? { spec } : method === "voice.native.configure" ? { enabled: p.enabled } : {});
    await mount("codex");
    const control = () => mounted!.root.findByProps({ "data-settings-realtime": true });
    const apply = () => mounted!.root.findByProps({ "data-settings-realtime-apply": true });
    expect(control().props.value).toBe("off");
    expect(apply().props.disabled).toBe(true);
    await act(async () => control().props.onChange({ target: { value: "on" } }));
    await act(async () => apply().props.onClick());
    expect(rpcCall).toHaveBeenCalledWith("voice.native.configure", { agentId: "a1", enabled: true });
    expect(control().props.value).toBe("on");
    expect(apply().props.disabled).toBe(true);
    await act(async () => control().props.onChange({ target: { value: "off" } }));
    await act(async () => apply().props.onClick());
    expect(rpcCall).toHaveBeenCalledWith("voice.native.configure", { agentId: "a1", enabled: false });
    expect(rpcCall.mock.calls.some(([m]) => m === "agent.reconfigure")).toBe(false);
  });
  it("does not show the realtime control for Claude", async () => {
    await mount();
    expect(mounted!.root.findAllByProps({ "data-settings-realtime": true })).toHaveLength(0);
  });
  // NATIVE-CONTROL-INHERITS-NOTHING: SpawnCard's `.inputBox` is a flex CONTAINER — there the text
  // lives in a child that carries its own colour and font. Applied straight to a native
  // <input>/<select>, as this card does, the control inherits neither and falls back to the
  // user-agent default: black text on a dark field. Reported as "the letters are black".
  it("every control carries the native-field class, not just the container one", async () => {
    await mount();
    const controls = mounted!.root.findAll((n) => n.props["data-settings-field"] !== undefined);
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) {
      const cls = String(c.props["className"] ?? "");
      expect(cls).toMatch(/inputBox/);
      expect(cls).toMatch(/nativeField/);
    }
  });

  it("reads the CURRENT spec so the form shows what is set, not blanks to fill in", async () => {
    await mount();
    expect(rpcCall).toHaveBeenCalledWith("agent.status", { agentId: "a1" });
    const model = mounted!.root.find((n) => n.props["data-settings-field"] === "model");
    expect(model.props["value"]).toBe("claude-opus-5");
    const turns = mounted!.root.find((n) => n.props["data-settings-field"] === "maxTurns");
    expect(turns.props["value"]).toBe("40");
  });

  it("offers every reconfigurable setting plus the live ones", async () => {
    // Ordered, because the order IS the layout. Restated here rather than derived from core's
    // RECONFIGURABLE_KEYS because the app deliberately does not depend on @chimera/core — it
    // speaks to the daemon over RPC and takes its types from @chimera/protocol. So this list is a
    // CHOICE, and what it leaves out is part of the choice: `orchestration` and `loadSettings` are
    // reconfigurable but have no control here (nested/structural, not a one-line field), and `cwd`
    // is here while NOT being reconfigurable — it routes through rebind.
    await mount();
    expect(fieldNames()).toEqual([
      "model", "effort", "account", "maxTurns", "turnLimitPolicy",
      "maxBudgetUsd", "autonomy", "compactionThreshold", "cwd", "instructions",
      "displayLabel", "permissionProfile", "permissionRequest",
    ]);
  });

  it("every field is a label+control ROW — the geometry the shared classes expect", async () => {
    await mount();
    for (const n of mounted!.root.findAll((x) => x.props["data-settings-field"] !== undefined)) {
      // each control's parent is the row, and that row also carries the label text
      const row = n.parent!;
      const text = row.findAll((c) => typeof c.children[0] === "string").map((c) => c.children[0]).join(" ");
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  it("sends ONLY what changed — an untouched form is not a respawn", async () => {
    await mount();
    const apply = mounted!.root.find((n) => n.props["data-settings-apply"] !== undefined);
    await act(async () => { apply.props["onClick"](); });
    expect(rpcCall.mock.calls.some(([m]) => m === "agent.reconfigure")).toBe(false);
  });

  it("sends a changed field in the patch", async () => {
    await mount();
    const effort = mounted!.root.find((n) => n.props["data-settings-field"] === "effort");
    await act(async () => { effort.props["onChange"]({ target: { value: "high" } }); });
    const apply = mounted!.root.find((n) => n.props["data-settings-apply"] !== undefined);
    await act(async () => { apply.props["onClick"](); });
    const call = rpcCall.mock.calls.find(([m]) => m === "agent.reconfigure")!;
    expect((call[1] as { patch: Record<string, unknown> }).patch).toEqual({ effort: "high" });
  });

  // COMPACTION-THRESHOLD-PER-AGENT: the field an operator reaches for when a long-running 1M agent
  // is burning context — "compact this one at 500k" — which had no live path before.
  it("sends a compaction window as a NUMBER, not the string the input holds", async () => {
    await mount();
    const ct = mounted!.root.find((n) => n.props["data-settings-field"] === "compactionThreshold");
    await act(async () => { ct.props["onChange"]({ target: { value: "500000" } }); });
    const apply = mounted!.root.find((n) => n.props["data-settings-apply"] !== undefined);
    await act(async () => { apply.props["onClick"](); });
    const call = rpcCall.mock.calls.find(([m]) => m === "agent.reconfigure")!;
    expect((call[1] as { patch: Record<string, unknown> }).patch).toEqual({ compactionThreshold: 500_000 });
  });

  it("CLEARS the window with null when the field is emptied — not by omitting it", async () => {
    // The trap: a sparse patch treats an ABSENT key as "unchanged", so sending undefined for a
    // cleared field would leave the old override in place and silently do nothing. null is the
    // only way to say "drop it, go back to the account default".
    withSpec({ ...DEFAULT_SPEC, compactionThreshold: 500_000 });
    await mount();
    const ct = mounted!.root.find((n) => n.props["data-settings-field"] === "compactionThreshold");
    expect(ct.props["value"]).toBe("500000");            // seeded from the spec, not blank
    await act(async () => { ct.props["onChange"]({ target: { value: "" } }); });
    const apply = mounted!.root.find((n) => n.props["data-settings-apply"] !== undefined);
    await act(async () => { apply.props["onClick"](); });
    const call = rpcCall.mock.calls.find(([m]) => m === "agent.reconfigure")!;
    expect((call[1] as { patch: Record<string, unknown> }).patch).toEqual({ compactionThreshold: null });
  });

  it("routes a live-only change through `live`, never the respawning patch", async () => {
    await mount();
    const name = mounted!.root.find((n) => n.props["data-settings-field"] === "displayLabel");
    await act(async () => { name.props["onChange"]({ target: { value: "renamed" } }); });
    const apply = mounted!.root.find((n) => n.props["data-settings-apply"] !== undefined);
    await act(async () => { apply.props["onClick"](); });
    const call = rpcCall.mock.calls.find(([m]) => m === "agent.reconfigure")!;
    const params = call[1] as { patch?: unknown; live?: Record<string, unknown> };
    expect(params.patch).toBeUndefined();
    expect(params.live).toEqual({ displayLabel: "renamed" });
  });
});
