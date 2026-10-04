import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// ALWAYS-ALLOW-UI: the PermissionCard's persist chips appear ONLY for foreign MCP
// asks. Same harness as SpawnCard.test.tsx (node env → bare window stub for
// OverlayCard's esc effect; the Tauri bridge is mocked so no real invoke() fires).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => ({})),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
}));

import { PermissionCard } from "../src/components/PermissionCard";
import { composerLocal } from "../src/state/commands.agents";
import type { PendingPermission } from "@chimera/ui-state";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}
const byAttr = (tree: TreeNode, attr: string): TreeNode[] => findAll(tree, (n) => attr in n.props);

// Flattens every string leaf under a node, in document order -- the closest
// thing react-test-renderer's JSON tree has to "what ends up in the DOM".
function textOf(node: TreeNode | string | null): string {
  if (node === null) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join("");
}

function renderCard(pending: PendingPermission): TreeNode {
  let r!: ReturnType<typeof create>;
  act(() => { r = create(<PermissionCard pending={pending} bottomInset={0} />); });
  return r.toJSON() as unknown as TreeNode;
}

const mcp: PendingPermission = { requestId: "r", agentId: "aaaa1111", toolName: "mcp__ekb__search", input: {}, ts: 1 };
const bash: PendingPermission = { requestId: "r", agentId: "aaaa1111", toolName: "Bash", input: {}, ts: 1 };

describe("PermissionCard persist chips", () => {
  it("renders both persist chips for a foreign MCP ask (alongside allow/deny)", () => {
    const tree = renderCard(mcp);
    expect(byAttr(tree, "data-perm-allow")).toHaveLength(1);
    expect(byAttr(tree, "data-perm-deny")).toHaveLength(1);
    expect(byAttr(tree, "data-perm-allow-tool")).toHaveLength(1);
    expect(byAttr(tree, "data-perm-allow-server")).toHaveLength(1);
  });

  it("omits the persist chips for a non-MCP (Bash) ask — one-shot allow/deny only", () => {
    const tree = renderCard(bash);
    expect(byAttr(tree, "data-perm-allow")).toHaveLength(1);
    expect(byAttr(tree, "data-perm-deny")).toHaveLength(1);
    expect(byAttr(tree, "data-perm-allow-tool")).toHaveLength(0);
    expect(byAttr(tree, "data-perm-allow-server")).toHaveLength(0);
  });
});

// PERMISSION-CARD-READABILITY: the operator's own report reproduction — a real
// Atlantis retry-loop Bash command with embedded quotes, $(...) substitutions,
// an until/done loop and redirections. The old formatToolInput rendering
// turned this into one escaped-JSON blob ("\n" / "\"" literals everywhere);
// the default view must now read as formatted text.
const REAL_COMMAND =
  'cd /Users/alice/Documents/acmecorp/PROJ-10483/terraform-aws\n'
  + 'gh pr comment 4584 -R acmecorp/terraform-aws --body "atlantis plan" >/dev/null 2>&1\n'
  + 'BEFORE=$(gh pr view 4584 -R acmecorp/terraform-aws --json comments '
  + `-q '[.comments[]|select(.author.login=="acmecorp-atlantis")]|length')\n`
  + 'until [ "$(gh pr view 4584 -R acmecorp/terraform-aws --json comments '
  + `-q '[.comments[]|select(.author.login=="acmecorp-atlantis")]|length')" -gt "$BEFORE" ]; do sleep 15; done`;

const atlantisRetry: PendingPermission = {
  requestId: "r", agentId: "aaaa1111", toolName: "Bash", ts: 1,
  input: { command: REAL_COMMAND, description: "Retry Atlantis plan", timeout: 480000 },
};

describe("PermissionCard: default view is formatted text, not JSON (PERMISSION-CARD-READABILITY)", () => {
  afterEach(() => composerLocal.reset());

  it("renders real line breaks and no literal JSON-escape sequences", () => {
    const tree = renderCard(atlantisRetry);
    const input = byAttr(tree, "data-permission-input")[0];
    const rendered = textOf(input);
    expect(rendered).not.toContain("\\n");
    expect(rendered).not.toContain('\\"');
    expect(rendered).toContain("\n"); // an actual newline character, not the escape sequence
  });

  it("shows the human description ABOVE the command, and the FULL command verbatim (never truncated)", () => {
    const tree = renderCard(atlantisRetry);
    const input = byAttr(tree, "data-permission-input")[0];
    const rendered = textOf(input);
    expect(rendered).toContain(REAL_COMMAND);
    expect(rendered.indexOf("Retry Atlantis plan")).toBeGreaterThanOrEqual(0);
    expect(rendered.indexOf("Retry Atlantis plan")).toBeLessThan(rendered.indexOf(REAL_COMMAND));
  });

  it("carries no JSON syntax in the default view — no quoted keys, no braces around the block", () => {
    const tree = renderCard(atlantisRetry);
    const input = byAttr(tree, "data-permission-input")[0];
    const rendered = textOf(input);
    expect(rendered).not.toContain('"command":');
    expect(rendered).not.toContain('"description":');
    expect(rendered).not.toContain('"timeout":');
    expect(rendered.trimStart().startsWith("{")).toBe(false);
  });

  it("humanizes the exact-division timeout as quiet metadata (8m), not \"timeout\": 480000", () => {
    const tree = renderCard(atlantisRetry);
    const rendered = textOf(byAttr(tree, "data-permission-input")[0]);
    expect(rendered).toContain("8m");
  });

  it("mod+e raw view still yields the EXACT JSON.stringify ground truth, byte for byte", () => {
    composerLocal.set({ permissionRaw: true });
    const tree = renderCard(atlantisRetry);
    const rendered = textOf(byAttr(tree, "data-permission-input")[0]);
    expect(rendered).toBe(JSON.stringify(atlantisRetry.input));
  });

  it("markup-ish characters (backticks, asterisks, angle brackets) render verbatim, not interpreted", () => {
    const tricky: PendingPermission = {
      requestId: "r", agentId: "aaaa1111", ts: 1, toolName: "Bash",
      input: { command: "echo `date` && echo <b>*bold*</b> && echo <script>alert(1)</script>" },
    };
    const tree = renderCard(tricky);
    const rendered = textOf(byAttr(tree, "data-permission-input")[0]);
    expect(rendered).toContain("echo `date` && echo <b>*bold*</b> && echo <script>alert(1)</script>");
    // No stray element node other than the expected pre/div wrappers was created
    // from the markup — react-test-renderer never interprets string children as
    // markup, but this pins that a <script> tag never becomes a real tree node.
    expect(findAll(byAttr(tree, "data-permission-input")[0], (n) => n.type === "script")).toHaveLength(0);
  });

  it("an unknown/unusual input shape (array, not an object) renders safely — no crash, no blank card", () => {
    const weird: PendingPermission = { requestId: "r", agentId: "aaaa1111", ts: 1, toolName: "Bash", input: ["one", "two", "three"] };
    let tree: TreeNode | undefined;
    expect(() => { tree = renderCard(weird); }).not.toThrow();
    const rendered = textOf(byAttr(tree!, "data-permission-input")[0]);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toContain("one");
  });

  it("a pathological input (throwing getter) still falls back to non-blank pretty JSON, never crashes", () => {
    const poisoned: Record<string, unknown> = {};
    Object.defineProperty(poisoned, "boom", { enumerable: true, get() { throw new Error("nope"); } });
    const weird: PendingPermission = { requestId: "r", agentId: "aaaa1111", ts: 1, toolName: "Bash", input: poisoned };
    let tree: TreeNode | undefined;
    expect(() => { tree = renderCard(weird); }).not.toThrow();
    const rendered = textOf(byAttr(tree!, "data-permission-input")[0]);
    expect(rendered.length).toBeGreaterThan(0);
  });
});
