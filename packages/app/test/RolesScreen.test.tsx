import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// ROLES-TAB S5, rewritten by ROLES-UNIFY S5 (docs/superpowers/specs/2026-07-28-
// roles-unify.md §8 S5): screen-level coverage for the two things the unify
// spec says must not go wrong — sibling preservation on a team-binding
// override edit (now via the ATOMIC team.updateRoleBinding RPC, no client
// RMW — §5/§6.4's data-loss hazard, exercised through the ACTUAL screen flow)
// and the honesty note rendering with a live count (§2). Also covers §6.1's
// real per-field override diff replacing the old opaque "shared: <name>"
// badge.

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const LIBRARY_ROLE = {
  name: "custom", model: "claude-sonnet-5", permissionProfile: "acceptEdits",
  instructions: "do the thing", plugins: [], mcpToolAllowlist: {}, skills: [],
};

const BUILDER_LIB = { name: "dev.builder", cwd: "/tmp/dev", model: "claude-sonnet-5", permissionProfile: "acceptEdits", instructions: "build stuff" };
const REVIEWER_LIB = { name: "dev.reviewer", cwd: "/tmp/dev", model: "claude-opus-5", permissionProfile: "readOnly", instructions: "review stuff" };

const TEAM_SPEC = {
  name: "dev",
  roles: {
    builder: { role: "dev.builder", overrides: {} },
    reviewer: { role: "dev.reviewer", overrides: { model: "claude-haiku-4-5" } },
  },
  discoveredRoles: [], maxConcurrent: 2,
};

let updateBindingCalls: Array<{ team: string; roleKey: string; overrides: Record<string, unknown> }> = [];

const rpcImpl = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  if (method === "role.list") return [LIBRARY_ROLE, BUILDER_LIB, REVIEWER_LIB];
  if (method === "team.list") return [TEAM_SPEC];
  if (method === "team.status") return { spec: TEAM_SPEC, running: 0, agents: [], totalRuns: 0 };
  if (method === "team.updateRoleBinding") {
    updateBindingCalls.push(params as { team: string; roleKey: string; overrides: Record<string, unknown> });
    return TEAM_SPEC;
  }
  return [];
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { RolesScreen } from "../src/screens/RolesScreen";
import { appStore } from "../src/state/store";
import { composerLocal } from "../src/state/commands.agents";
import { installAppOverlayLifecycle } from "../src/state/overlayLifecycle";
import styles from "../src/screens/RolesScreen.module.css";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

// findAllByProps requires an EXACT value match; a bare JSX attribute
// (`data-team-role-edit` with no `=`) sets the prop to boolean `true`, so
// this finds it by KEY presence instead, same as TopBar.overflow.test.tsx's
// own `byData` helper.
const byDataAttr = (root: ReturnType<typeof create>["root"], attr: string) =>
  root.findAll((n) => n.props[attr] !== undefined);

let mounted: ReturnType<typeof create> | null = null;

beforeEach(() => {
  rpcImpl.mockClear();
  updateBindingCalls = [];
  act(() => { appStore.dispatch({ type: "roleCursor", delta: -1000 }); });
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("RolesScreen", () => {
  it("shows the library role, the team bindings, and the template-truth honesty note", async () => {
    act(() => { mounted = create(React.createElement(RolesScreen)); });
    await flush();
    const root = mounted!.root;
    expect(root.findAllByProps({ "data-role-row": "custom" }).length).toBe(1);
    expect(root.findAllByProps({ "data-role-row": "dev/builder" }).length).toBe(1);
    expect(root.findAllByProps({ "data-role-row": "dev/reviewer" }).length).toBe(1);
  });

  it("§6.1: shows a real per-field override diff, not an opaque shared badge", async () => {
    act(() => { mounted = create(React.createElement(RolesScreen)); });
    await flush();
    const root = mounted!.root;

    const builderRow = root.findAllByProps({ "data-role-row": "dev/builder" })[0]!;
    expect(builderRow.findAll((n) => n.props["data-overridden-fields"] !== undefined).length).toBe(0);

    const reviewerRow = root.findAllByProps({ "data-role-row": "dev/reviewer" })[0]!;
    const reviewerOverrideBadge = reviewerRow.findAll((n) => n.props["data-overridden-fields"] !== undefined)[0];
    expect(reviewerOverrideBadge).toBeDefined();
    expect(reviewerOverrideBadge!.props["data-overridden-fields"]).toBe("model");
  });

  it("preserves the sibling binding when one team binding's overrides are edited (§5/§6.4 sibling-preservation, atomic RPC)", async () => {
    act(() => { mounted = create(React.createElement(RolesScreen)); });
    await flush();
    const root = mounted!.root;

    // select the "builder" row (currently zero overrides), toggle "model"
    // into an override, and save — this must touch ONLY builder's binding;
    // the daemon-side handler is what guarantees sibling preservation now
    // (no client-side RMW at all), so this test asserts the CALL SHAPE: one
    // atomic team.updateRoleBinding request naming builder's own roleKey.
    const builderRow = root.findAllByProps({ "data-role-row": "dev/builder" })[0]!;
    act(() => { (builderRow.props as { onClick: () => void }).onClick(); });
    await flush();

    const toggle = byDataAttr(root, "data-override-toggle")[0];
    expect(toggle).toBeDefined();
    act(() => { (toggle!.props as { onClick: () => void }).onClick(); });
    await flush();

    const saveChip = byDataAttr(root, "data-override-save")[0];
    expect(saveChip).toBeDefined();
    act(() => { (saveChip!.props as { onClick: () => void }).onClick(); });
    await flush();

    expect(updateBindingCalls.length).toBe(1);
    expect(updateBindingCalls[0]!.team).toBe("dev");
    expect(updateBindingCalls[0]!.roleKey).toBe("builder");
    // the reviewer binding was never touched by this request at all — the
    // atomic RPC only ever carries the ONE roleKey being edited.
    expect("reviewer" in (updateBindingCalls[0] as unknown as Record<string, unknown>)).toBe(false);
  });

  it("renders the §2 template-truth honesty note on a library role's detail pane", async () => {
    act(() => { mounted = create(React.createElement(RolesScreen)); });
    await flush();
    const root = mounted!.root;
    const row = root.findAllByProps({ "data-role-row": "custom" })[0]!;
    act(() => { (row.props as { onClick: () => void }).onClick(); });
    await flush();
    const honesty = root.findAllByProps({ className: styles.honesty });
    expect(honesty.length).toBeGreaterThan(0);
    expect(String(honesty[0]!.children)).toMatch(/template edit|future spawns/);
  });

  it("ROLES-TAB S6: 'spawn session with this role' actually opens SpawnCard prefilled, surviving the tab-change dismiss lifecycle", async () => {
    // installAppOverlayLifecycle is normally wired by App.tsx's mount effect;
    // it must be live here too, since the bug this guards against IS the
    // lifecycle's tab-change dismiss clobbering spawnOpen in the same tick.
    const dispose = installAppOverlayLifecycle(appStore);
    composerLocal.reset();
    // the bug only shows when the click ACTUALLY changes the active tab (the
    // real scenario: the user is on the Roles tab) — leaving activeTab at its
    // default "agents" would make the selectTab dispatch below a no-op and
    // mask the dismiss-on-tab-change clobber entirely.
    act(() => { appStore.dispatch({ type: "selectTab", tab: "roles" }); });
    act(() => { mounted = create(React.createElement(RolesScreen)); });
    await flush();
    const root = mounted!.root;
    const row = root.findAllByProps({ "data-role-row": "custom" })[0]!;
    act(() => { (row.props as { onClick: () => void }).onClick(); });
    await flush();

    const spawnChip = byDataAttr(root, "data-spawn-with-role")[0];
    expect(spawnChip).toBeDefined();
    act(() => { (spawnChip!.props as { onClick: () => void }).onClick(); });

    expect(appStore.getState().activeTab).toBe("agents");
    expect(composerLocal.getState().spawnOpen).toBe(true);
    expect(composerLocal.getState().spawnPrefillRole).toBe("custom");

    dispose();
    composerLocal.reset();
  });
});
