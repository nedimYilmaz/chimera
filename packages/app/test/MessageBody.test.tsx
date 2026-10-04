import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { MessageBody, type ResolveMention } from "../src/components/MessageBody";
import type { MentionInfo } from "../src/state/selectors";

// F21 (W23) — a real render pass (react-test-renderer, no DOM) over the 12
// output components: one closed-fence render check per kind, one malformed→
// code-block fallback, and the shared raw-view/copy-source contract. Mirrors
// WorkflowStepDots.test.tsx's node-env harness.

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function renderBody(
  text: string,
  opts?: { onLinkClick?: (label: string, kind: string) => void; resolveMention?: ResolveMention; onMentionClick?: (agentId: string) => void },
): TreeNode {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      React.createElement(MessageBody, {
        text,
        done: true,
        rawView: false,
        onLinkClick: opts?.onLinkClick,
        resolveMention: opts?.resolveMention,
        onMentionClick: opts?.onMentionClick,
      }),
    );
  });
  return renderer.toJSON() as TreeNode;
}

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}

function textOf(node: TreeNode | string | number | null): string {
  if (node === null || node === undefined) return "";
  if (typeof node !== "object") return String(node);
  return (node.children ?? []).map(textOf).join("");
}

const fence = (kind: string, body: string): string => ["```" + kind, body, "```", ""].join("\n");

describe("MessageBody — F21 output components", () => {
  it("renders a status fence as tone-classed rows", () => {
    const tree = renderBody(fence("status", "ok build · 4.2s\nfail deploy"));
    const rows = findAll(tree, (n) => typeof n.props["className"] === "string" && (n.props["className"] as string).includes("statusRow"));
    expect(rows).toHaveLength(2);
    expect(textOf(rows[0]!)).toContain("build");
    expect(textOf(rows[0]!)).toContain("4.2s");
    expect(textOf(rows[1]!)).toContain("deploy");
  });

  it("renders a checklist fence with an n/N header", () => {
    const tree = renderBody(fence("checklist", "[x] a\n[ ] b\n[!] c — flag"));
    const header = findAll(tree, (n) => typeof n.props["className"] === "string" && (n.props["className"] as string).includes("checklistHeader"));
    expect(textOf(header[0]!)).toBe("1/3");
  });

  it("renders a kv fence as key/value rows", () => {
    const tree = renderBody(fence("kv", "agent: q-orion\nstatus: running"));
    const keys = findAll(tree, (n) => typeof n.props["className"] === "string" && (n.props["className"] as string).includes("kvKey"));
    expect(keys.map(textOf)).toEqual(["agent", "status"]);
  });

  it("renders a diffstat fence with a totals footer", () => {
    const tree = renderBody(fence("diffstat", "a.ts +12 -3\nb.ts +0 -8"));
    const footer = findAll(tree, (n) => typeof n.props["className"] === "string" && (n.props["className"] as string).includes("diffstatFooter"));
    expect(textOf(footer[0]!)).toContain("+12");
    expect(textOf(footer[0]!)).toContain("11"); // 3 + 8
  });

  it("renders a timeline fence", () => {
    const tree = renderBody(fence("timeline", "09:00 kickoff"));
    expect(JSON.stringify(tree)).toContain("09:00");
    expect(JSON.stringify(tree)).toContain("kickoff");
  });

  it("renders a tree fence with indented badges", () => {
    const tree = renderBody(fence("tree", "src/\n  a.ts M"));
    const rows = findAll(tree, (n) => typeof n.props["className"] === "string" && (n.props["className"] as string).includes("treeRow"));
    expect(rows).toHaveLength(2);
    expect(rows[1]!.props["style"]).toMatchObject({ paddingLeft: "14px" });
    expect(textOf(rows[1]!)).toContain("a.ts");
    expect(textOf(rows[1]!)).toContain("M");
  });

  it("renders a links fence as plain text when unresolved (no onLinkClick handler)", () => {
    const tree = renderBody(fence("links", "report.md (report)"));
    const rows = findAll(tree, (n) => n.type === "div" && typeof n.props["className"] === "string" && (n.props["className"] as string).includes("linkRow"));
    expect(rows).toHaveLength(1);
    expect(textOf(rows[0]!)).toContain("report.md");
    expect(textOf(rows[0]!)).toContain("report");
  });

  it("renders a links fence as a clickable row that resolves via onLinkClick (F17 deep-link)", () => {
    const onLinkClick = vi.fn();
    const tree = renderBody(fence("links", "report.md (report)"), { onLinkClick });
    const buttons = findAll(tree, (n) => n.type === "button");
    expect(buttons).toHaveLength(1);
    (buttons[0]!.props["onClick"] as () => void)();
    expect(onLinkClick).toHaveBeenCalledWith("report.md", "report");
  });

  it("renders a progress fence with a width-driven bar", () => {
    const tree = renderBody(fence("progress", "40% · step 2/5 · eta 3m"));
    const bars = findAll(tree, (n) => typeof n.props["className"] === "string" && (n.props["className"] as string).includes("progressBar"));
    expect(bars[0]!.props["style"]).toMatchObject({ width: "40%" });
    const row = findAll(tree, (n) => typeof n.props["className"] === "string" && (n.props["className"] as string).includes("progressRow"));
    expect(textOf(row[0]!)).toContain("step 2/5");
    expect(textOf(row[0]!)).toContain("eta 3m");
  });

  it("renders a toned callout fence", () => {
    const tree = renderBody(["```callout success", "all checks passed", "```", ""].join("\n"));
    const callouts = findAll(tree, (n) => typeof n.props["className"] === "string" && (n.props["className"] as string).includes("calloutSuccess"));
    expect(callouts).toHaveLength(1);
    expect(textOf(callouts[0]!)).toContain("all checks passed");
  });

  it("renders a metric fence as number cards with a delta arrow", () => {
    const spec = JSON.stringify([{ label: "p95", value: "142ms", delta: "-8ms", dir: "down", good: true }]);
    const tree = renderBody(fence("metric", spec));
    const cards = findAll(tree, (n) => typeof n.props["className"] === "string" && (n.props["className"] as string).includes("metricCard"));
    expect(cards).toHaveLength(1);
    expect(textOf(cards[0]!)).toContain("p95");
    expect(textOf(cards[0]!)).toContain("142ms");
    expect(textOf(cards[0]!)).toContain("▼");
  });

  it("renders a test-report fence with a pass/fail/skip ratio bar and failing list", () => {
    const spec = JSON.stringify({ pass: 40, fail: 1, skip: 2, duration: "4.2s", failures: [{ name: "auth spec", note: "timeout" }] });
    const tree = renderBody(fence("test-report", spec));
    const summary = findAll(tree, (n) => typeof n.props["className"] === "string" && (n.props["className"] as string).includes("testReportSummary"));
    expect(textOf(summary[0]!)).toContain("40 pass");
    expect(textOf(summary[0]!)).toContain("1 fail");
    const failures = findAll(tree, (n) => typeof n.props["className"] === "string" && (n.props["className"] as string).includes("testReportFailures"));
    expect(textOf(failures[0]!)).toContain("auth spec");
    expect(textOf(failures[0]!)).toContain("timeout");
  });

  it("renders a compare fence as a table with a pick badge", () => {
    const spec = JSON.stringify({
      options: ["postgres", "sqlite"],
      criteria: [{ name: "concurrency", values: ["good", "poor"] }],
      pick: "postgres",
      reason: "needs concurrent writers",
    });
    const tree = renderBody(fence("compare", spec));
    expect(JSON.stringify(tree)).toContain("postgres");
    expect(JSON.stringify(tree)).toContain("pick");
    expect(JSON.stringify(tree)).toContain("needs concurrent writers");
  });

  it("degrades a malformed component fence to a plain code block, never a crash", () => {
    const tree = renderBody(fence("status", "not a status line"));
    const code = findAll(tree, (n) => typeof n.props["className"] === "string" && (n.props["className"] as string).includes("codeWrap"));
    expect(code).toHaveLength(1);
    expect(JSON.stringify(tree)).toContain("not a status line");
  });

  it("shows a dim placeholder — not raw JSON/lines — while a component fence is still streaming", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(MessageBody, { text: "```status\nok build", done: false, rawView: false }),
      );
    });
    const tree = renderer.toJSON() as TreeNode;
    const placeholder = findAll(tree, (n) => typeof n.props["className"] === "string" && (n.props["className"] as string).includes("streamingPlaceholder"));
    expect(placeholder).toHaveLength(1);
    expect(textOf(placeholder[0]!)).toBe("status streaming…");
  });

  it("raw view (v toggle) shows the verbatim fenced source — same text a selection copy would return", () => {
    const source = fence("status", "ok build · 4.2s");
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(MessageBody, { text: source, done: true, rawView: true }));
    });
    const tree = renderer.toJSON() as TreeNode;
    const pre = findAll(tree, (n) => n.type === "pre");
    expect(pre).toHaveLength(1);
    expect(textOf(pre[0]!)).toBe(source);
  });
});

describe("MessageBody — F22 (W24) @mention chips", () => {
  const KNOWN: MentionInfo = { agentId: "agent-123", tone: "success", dimmed: false };
  const resolveMention: ResolveMention = (name) => (name === "frosty-lynx" ? KNOWN : null);

  it("renders a known @mention as a clickable chip with a state dot", () => {
    const onMentionClick = vi.fn();
    const tree = renderBody("ask @frosty-lynx to look", { resolveMention, onMentionClick });
    const chips = findAll(tree, (n) => n.type === "span" && n.props["role"] === "button");
    expect(chips).toHaveLength(1);
    expect(textOf(chips[0]!)).toBe("@frosty-lynx");
    (chips[0]!.props["onClick"] as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
    expect(onMentionClick).toHaveBeenCalledWith("agent-123");
  });

  it("renders an unknown @mention as plain text, no chip", () => {
    const tree = renderBody("ask @some-random-word to look", { resolveMention });
    const chips = findAll(tree, (n) => n.type === "span" && n.props["role"] === "button");
    expect(chips).toHaveLength(0);
    expect(textOf(tree)).toContain("@some-random-word");
  });

  it("renders no chip at all when resolveMention is omitted", () => {
    const tree = renderBody("ask @frosty-lynx to look");
    const chips = findAll(tree, (n) => n.type === "span" && n.props["role"] === "button");
    expect(chips).toHaveLength(0);
    expect(textOf(tree)).toContain("@frosty-lynx");
  });

  it("dims a finished agent's chip (still clickable — 'keeps working')", () => {
    const done: MentionInfo = { agentId: "agent-999", tone: "info", dimmed: true };
    const tree = renderBody("@done-agent shipped", { resolveMention: () => done, onMentionClick: vi.fn() });
    const chips = findAll(tree, (n) => n.type === "span" && n.props["role"] === "button");
    expect(chips).toHaveLength(1);
    expect((chips[0]!.props["className"] as string)).toContain("mentionDim");
  });
});

describe("MessageBody — F22 (W24) quote-reply excerpt block", () => {
  it("renders a linked excerpt block header (chip + kind + ts) when the ref parses", () => {
    const info: MentionInfo = { agentId: "agent-1", tone: "info", dimmed: false };
    const onMentionClick = vi.fn();
    const encoded = "> Row-scroll math is correct.\n> — @eager-weasel · result · 14:04:02";
    const tree = renderBody(encoded, { resolveMention: () => info, onMentionClick });
    expect(JSON.stringify(tree)).toContain("Row-scroll math is correct.");
    const chips = findAll(tree, (n) => n.type === "span" && n.props["role"] === "button");
    expect(chips).toHaveLength(1);
    (chips[0]!.props["onClick"] as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
    expect(onMentionClick).toHaveBeenCalledWith("agent-1");
    expect(JSON.stringify(tree)).toContain("result");
    expect(JSON.stringify(tree)).toContain("14:04:02");
  });

  it("renders a plain blockquote with no header when there's no ref line", () => {
    const tree = renderBody("> just a quote\n> with two lines");
    expect(JSON.stringify(tree)).toContain("just a quote");
    const chips = findAll(tree, (n) => n.type === "span" && n.props["role"] === "button");
    expect(chips).toHaveLength(0);
  });
});

describe("MessageBody — UI-QUOTE-COLLAPSE", () => {
  const info: MentionInfo = { agentId: "agent-1", tone: "info", dimmed: false };

  it("collapses a long quoted excerpt to a bounded preview with a show-quoted toggle", () => {
    const longExcerpt = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const encoded = `> ${longExcerpt.split("\n").join("\n> ")}\n> — @eager-weasel · result · 14:04:02`;
    const tree = renderBody(encoded, { resolveMention: () => info, onMentionClick: vi.fn() });

    const text = JSON.stringify(tree);
    expect(text).not.toContain("line 39"); // full 40-line excerpt never renders by default
    const buttons = findAll(tree, (n) => n.type === "button");
    expect(buttons).toHaveLength(1);
    expect(textOf(buttons[0]!)).toBe("show quoted");
  });

  it("expands a collapsed quote inline when the toggle is clicked", () => {
    const longExcerpt = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const encoded = `> ${longExcerpt.split("\n").join("\n> ")}\n> — @eager-weasel · result · 14:04:02`;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(MessageBody, { text: encoded, done: true, rawView: false, resolveMention: () => info, onMentionClick: vi.fn() }),
      );
    });
    const button = findAll(renderer.toJSON() as TreeNode, (n) => n.type === "button")[0]!;
    act(() => (button.props["onClick"] as () => void)());
    const expanded = renderer.toJSON() as TreeNode;
    expect(JSON.stringify(expanded)).toContain("line 39");
  });

  it("routes a click on the quote header (backlink) to the source agent", () => {
    const onMentionClick = vi.fn();
    const encoded = "> short quote\n> — @eager-weasel · result · 14:04:02";
    const tree = renderBody(encoded, { resolveMention: () => info, onMentionClick });
    const headers = findAll(tree, (n) => n.type === "div" && n.props["role"] === "button");
    expect(headers).toHaveLength(1);
    (headers[0]!.props["onClick"] as () => void)();
    expect(onMentionClick).toHaveBeenCalledWith("agent-1");
  });

  it("leaves a short quote rendered as-is, no toggle", () => {
    const encoded = "> short quote\n> — @eager-weasel · result · 14:04:02";
    const tree = renderBody(encoded, { resolveMention: () => info, onMentionClick: vi.fn() });
    expect(JSON.stringify(tree)).toContain("short quote");
    expect(findAll(tree, (n) => n.type === "button")).toHaveLength(0);
  });
});

describe("MessageBody — table cells parse inline markdown", () => {
  it("renders a link inside a table cell as accent text, not bracket-paren source", () => {
    const url = "https://acmecorp.atlassian.net/browse/PROJ-4242";
    const md = ["| Task | Status |", "| --- | --- |", `| [${url}](${url}) | **done** |`, ""].join("\n");
    const tree = renderBody(md);
    const cells = findAll(tree, (n) => n.type === "td");
    expect(cells).toHaveLength(2);
    // rendered exactly once, as the link text — never the raw `[url](url)` source.
    expect(textOf(cells[0]!)).toBe(url);
    const linkSpan = findAll(cells[0]!, (n) => typeof n.props["title"] === "string");
    expect(linkSpan).toHaveLength(1);
    expect(linkSpan[0]!.props["title"]).toBe(url);
    // bold in a cell still renders as <b>, not raw "**done**"
    const bold = findAll(cells[1]!, (n) => n.type === "b");
    expect(bold).toHaveLength(1);
    expect(textOf(bold[0]!)).toBe("done");
  });

  it("resolves an @mention inside a table cell to a chip, same as body text", () => {
    const md = ["| Owner |", "| --- |", "| @eager-weasel |", ""].join("\n");
    const info: MentionInfo = { agentId: "agent-1", tone: "info", dimmed: false };
    const onMentionClick = vi.fn();
    const tree = renderBody(md, { resolveMention: () => info, onMentionClick });
    const cells = findAll(tree, (n) => n.type === "td");
    expect(textOf(cells[0]!)).toContain("eager-weasel");
    expect(findAll(cells[0]!, (n) => n.props["role"] === "button")).toHaveLength(1);
  });
});

describe("MessageBody — table HEADER cells parse inline markdown too", () => {
  it("renders bold in a <th> as <b>, not the raw '**' source", () => {
    const md = ["| **Task** | Status |", "| --- | --- |", "| a | b |", ""].join("\n");
    const tree = renderBody(md);
    const headers = findAll(tree, (n) => n.type === "th");
    expect(headers).toHaveLength(2);
    const bold = findAll(headers[0]!, (n) => n.type === "b");
    expect(bold).toHaveLength(1);
    expect(textOf(bold[0]!)).toBe("Task");
    expect(textOf(headers[0]!)).toBe("Task");
  });

  it("renders a [link](url) in a <th> as its link text, not the bracket-paren source", () => {
    const url = "https://x.test/spec";
    const md = [`| [spec](${url}) |`, "| --- |", "| a |", ""].join("\n");
    const tree = renderBody(md);
    const header = findAll(tree, (n) => n.type === "th")[0]!;
    expect(textOf(header)).toBe("spec");
    const linkSpan = findAll(header, (n) => typeof n.props["title"] === "string");
    expect(linkSpan).toHaveLength(1);
    expect(linkSpan[0]!.props["title"]).toBe(url);
  });
});
