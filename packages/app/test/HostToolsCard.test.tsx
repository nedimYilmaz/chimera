import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// HOST-TOOLS-PROFILE-VISIBILITY: first render-level test for HostToolsCard
// (previously only commands.host.test.ts / selectors.host.test.ts unit-tested
// the layers under it). Harness follows SpawnCard.test.tsx / EventsScreen.test.tsx
// (react-test-renderer + a bare window stub — this package's vitest config runs
// a node env, no jsdom — plus vi.mock("../src/rpc/bridge") so the Tauri bridge's
// real listen()/invoke() never fire) and EventsScreen.test.tsx's createNodeMock
// scrollIntoView spy technique.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { method: string; params: unknown };
const calls: Call[] = [];
const rpcImpl = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  calls.push({ method, params });
  if (method === "host.tools") {
    return {
      host: "mbp",
      tools: [
        // 5 named profiles + the synthetic default (*) ⇒ 6 profileTools — the
        // exact "overflows a fixed-width cell" shape the bug report describes.
        { tool: "kubectl", version: "1.31", profiles: ["prod", "staging", "dev", "adem-eks", "homelab"], policy: { prod: "ask", "*": "allow" } },
        { tool: "gh", version: "2.55", profiles: ["alice"], policy: {} },
      ],
    };
  }
  if (method === "peer.status") return { peers: [] };
  if (method === "host.setPolicy") return {};
  throw new Error(`unexpected method ${method}`);
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
}));

import { HostToolsCard } from "../src/components/HostToolsCard";
import { getHostCommands } from "../src/state/commands.host";
import { rpcCall } from "../src/rpc/bridge";
import { appStore } from "../src/state/store";
import { runAction } from "../src/keymap";
import { HINTS } from "../src/copy";
import { nextPolicyMode } from "../src/state/selectors.host";

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

// CSS module classNames are hashed at build time (e.g. "_footHint_905de4"),
// same substring-match discipline ProviderCatalogCard.test.tsx uses (hasClass).
function hasClass(n: TreeNode, re: RegExp): boolean {
  const c = n.props["className"];
  return typeof c === "string" && re.test(c);
}

function textOf(node: TreeNode): string {
  return (node.children ?? []).filter((c): c is string => typeof c === "string").join("");
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// Every host span/div gets a fake DOM node so refs (selectedRowRef,
// cursoredPartRef) resolve to something with a scrollIntoView to spy on —
// same technique as EventsScreen.test.tsx.
const scrollCalls: unknown[] = [];
const createNodeMock = () => ({
  scrollIntoView: (opts: unknown) => scrollCalls.push(opts),
  addEventListener: () => {},
  removeEventListener: () => {},
});

let mounted: ReturnType<typeof create> | null = null;

const cmds = getHostCommands(appStore, rpcCall);

/** The card's commands are a module-level singleton (commands.host.ts) that
 * outlives any one render — drive it back to a known closed state between
 * tests so open/reply/selected/profileCursor never leak across it() blocks. */
async function resetCard(): Promise<void> {
  while (cmds.getState().profileCursor !== null) cmds.escape();
  if (cmds.getState().open) { cmds.toggle(); await settle(); }
}

afterEach(async () => {
  act(() => mounted?.unmount());
  mounted = null;
  calls.length = 0;
  scrollCalls.length = 0;
  await resetCard();
});

async function openCard(): Promise<void> {
  await act(async () => {
    mounted = create(React.createElement(HostToolsCard, { bottomInset: 0 }), { createNodeMock });
  });
  await act(async () => {
    cmds.toggle();
    await settle();
    await settle();
  });
}

describe("HostToolsCard — per-profile edit cursor visibility", () => {
  it("footer captions the cursored tool/profile/mode and scrolls the chip into view; space cycles that profile", async () => {
    await openCard();
    act(() => { cmds.select(0); }); // kubectl
    act(() => { cmds.profileEdit(); }); // cursor 0 = default (*)
    act(() => { cmds.moveProfileCursor(1); }); // cursor 1 = prod (policy: ask)

    const tree = mounted!.toJSON() as TreeNode;
    const [footHint] = findAll(tree, (n) => hasClass(n, /footHint/));
    expect(footHint).toBeDefined();
    expect(textOf(footHint!)).toBe(HINTS.hostToolsFootEdit("kubectl", "prod", "ask"));

    // the cursored chip's scrollIntoView fired with an inline-aware call —
    // distinct from selectedRowRef's row-only {block:"nearest"} scroll.
    expect(scrollCalls).toContainEqual({ inline: "nearest", block: "nearest" });

    await act(async () => {
      runAction("host.cycle", appStore);
      await settle();
      await settle();
    });
    const sets = calls.filter((c) => c.method === "host.setPolicy");
    expect(sets).toEqual([{ method: "host.setPolicy", params: { tool: "kubectl", profile: "prod", mode: nextPolicyMode("ask") } }]);
  });

  it("keeps the collapsed (non-editing) row's plain ellipsis cell — only the row under edit gets the scroll-reveal class", async () => {
    await openCard();
    act(() => { cmds.select(0); }); // kubectl
    act(() => { cmds.profileEdit(); }); // enters edit on the kubectl row only

    const tree = mounted!.toJSON() as TreeNode;
    const [kubectlRow] = byAttr(tree, "data-host-row", "local:kubectl");
    const [ghRow] = byAttr(tree, "data-host-row", "local:gh");
    expect(kubectlRow).toBeDefined();
    expect(ghRow).toBeDefined();

    const kubectlProfilesCell = findAll(kubectlRow!, (n) => hasClass(n, /cellProfiles/))[0]!;
    const ghProfilesCell = findAll(ghRow!, (n) => hasClass(n, /cellProfiles/))[0]!;

    expect(hasClass(kubectlProfilesCell, /cellProfilesEditing/)).toBe(true);   // the row under edit
    expect(hasClass(ghProfilesCell, /cellProfilesEditing/)).toBe(false);      // untouched — not the row under edit
  });
});
