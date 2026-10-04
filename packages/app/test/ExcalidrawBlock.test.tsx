import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { createPortal } from "react-dom";
import { MessageBody } from "../src/components/MessageBody";

// EXCALIDRAW-DIAGRAMS — renderer detection contract (react-test-renderer, node
// env, no DOM). The heavy @excalidraw/excalidraw canvas is lazy-loaded and
// needs a real DOM/canvas, so we mock it: these tests exercise the DETECTION,
// FALLBACK and OVERSIZED-COLLAPSE logic (all synchronous chrome), not the
// canvas paint itself.
vi.mock("@excalidraw/excalidraw", () => ({ Excalidraw: () => null }));
vi.mock("@excalidraw/excalidraw/index.css", () => ({}));

// This harness has no jsdom/real DOM (react-test-renderer only — see above),
// so we can't observe actual DOM adjacency. What we CAN verify — and what
// actually determines the real-app behavior — is that the overlay is handed
// to react-dom's createPortal with `document.body` as the container. A portal
// attaches its real DOM node as a child of that container argument
// regardless of where the calling component sits in the React tree, which is
// exactly what escapes the transcript's `content-visibility:auto` ancestor
// (see ExcalidrawBlock.tsx's ExcalidrawOverlay comment). Mock as a
// passthrough (renders children in place) so the react-test-renderer JSON
// tree still shows the overlay's contents for the existing assertions below.
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: vi.fn((children: React.ReactNode) => children) };
});
const createPortalMock = vi.mocked(createPortal);

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function renderBody(text: string, done = true): { root: TreeNode; renderer: ReturnType<typeof create> } {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(MessageBody, { text, done, rawView: false }));
  });
  return { root: renderer.toJSON() as TreeNode, renderer };
}

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}

function textOf(node: TreeNode | string | null): string {
  if (node === null || node === undefined) return "";
  if (typeof node !== "object") return String(node);
  return (node.children ?? []).map(textOf).join("");
}

const hasClass = (sub: string) => (n: TreeNode) =>
  typeof n.props["className"] === "string" && (n.props["className"] as string).includes(sub);

const fence = (body: string): string => ["```excalidraw", body, "```", ""].join("\n");

const smallScene = JSON.stringify({
  type: "excalidraw",
  version: 2,
  elements: [
    { id: "a", type: "rectangle" },
    { id: "b", type: "arrow" },
  ],
  appState: { viewBackgroundColor: "#1e1e1e" },
});

const oversizedScene = JSON.stringify({
  type: "excalidraw",
  version: 2,
  elements: Array.from({ length: 150 }, (_, i) => ({ id: `e${i}`, type: "rectangle" })),
});

describe("ExcalidrawBlock — detection", () => {
  it("renders a valid scene as the excalidraw block with an element count + expand control (canvas path)", () => {
    const { root } = renderBody(fence(smallScene));
    const wrap = findAll(root, hasClass("excalidrawWrap"));
    expect(wrap).toHaveLength(1);
    // the bar shows the element count…
    const label = findAll(root, hasClass("excalidrawLabel"))[0]!;
    expect(textOf(label)).toBe("excalidraw diagram · 2 elements");
    // …and an expand button (present only on the shown/canvas path)
    const buttons = findAll(root, (n) => n.type === "button");
    expect(buttons.some((b) => textOf(b) === "expand")).toBe(true);
    // it is NOT the oversized-collapse path
    expect(JSON.stringify(root)).not.toContain("render diagram (");
    // raw scene JSON is not dumped as a <pre> code block
    expect(findAll(root, (n) => n.type === "pre")).toHaveLength(0);
  });

  it("singularizes a one-element scene's count", () => {
    const { root } = renderBody(fence(JSON.stringify({ type: "excalidraw", elements: [{ id: "a" }] })));
    const label = findAll(root, hasClass("excalidrawLabel"))[0]!;
    expect(textOf(label)).toBe("excalidraw diagram · 1 element");
  });
});

describe("ExcalidrawBlock — invalid scene fallback", () => {
  it("degrades invalid JSON to a code block with an 'invalid excalidraw scene' note, never a crash", () => {
    const { root } = renderBody(fence("{ not json"));
    const code = findAll(root, hasClass("codeWrap"));
    expect(code).toHaveLength(1);
    // the raw body is still shown…
    expect(JSON.stringify(root)).toContain("{ not json");
    // …plus the one-line invalid note
    const note = findAll(root, hasClass("excalidrawInvalid"));
    expect(note).toHaveLength(1);
    expect(textOf(note[0]!)).toBe("invalid excalidraw scene");
    // and NOT an excalidraw canvas
    expect(findAll(root, hasClass("excalidrawWrap"))).toHaveLength(0);
  });

  it("degrades a wrong-envelope scene (no elements array) to the code+note fallback", () => {
    const { root } = renderBody(fence(JSON.stringify({ type: "excalidraw", version: 2 })));
    expect(findAll(root, hasClass("excalidrawInvalid"))).toHaveLength(1);
    expect(findAll(root, hasClass("excalidrawWrap"))).toHaveLength(0);
  });
});

describe("ExcalidrawBlock — oversized collapse guardrail", () => {
  it("collapses a >100-element scene behind a 'render diagram (N elements)' button (no canvas auto-mount)", () => {
    const { root } = renderBody(fence(oversizedScene));
    // wrapper + count present, but the canvas is gated behind an opt-in button
    expect(findAll(root, hasClass("excalidrawWrap"))).toHaveLength(1);
    const renderBtn = findAll(root, (n) => n.type === "button").find((b) => textOf(b).includes("render diagram (150 elements)"));
    expect(renderBtn).toBeTruthy();
    // the expand affordance only appears once the diagram is actually shown
    expect(findAll(root, (n) => n.type === "button").some((b) => textOf(b) === "expand")).toBe(false);
  });

  it("mounts the canvas (shows the expand control) after the user clicks the render button", () => {
    const { root, renderer } = renderBody(fence(oversizedScene));
    const renderBtn = findAll(root, (n) => n.type === "button").find((b) => textOf(b).includes("render diagram"))!;
    act(() => (renderBtn.props["onClick"] as () => void)());
    const after = renderer.toJSON() as TreeNode;
    expect(findAll(after, (n) => n.type === "button").some((b) => textOf(b) === "expand")).toBe(true);
    expect(JSON.stringify(after)).not.toContain("render diagram (");
  });
});

describe("ExcalidrawBlock — expand overlay", () => {
  it("opens a full-screen dialog overlay when 'expand' is clicked", () => {
    const { root, renderer } = renderBody(fence(smallScene));
    const expandBtn = findAll(root, (n) => n.type === "button").find((b) => textOf(b) === "expand")!;
    act(() => (expandBtn.props["onClick"] as () => void)());
    const after = renderer.toJSON() as TreeNode;
    const dialog = findAll(after, (n) => n.props["role"] === "dialog");
    expect(dialog).toHaveLength(1);
    expect(findAll(after, (n) => n.type === "button").some((b) => textOf(b) === "close")).toBe(true);
  });
});

describe("ExcalidrawBlock — overlay portal", () => {
  // A minimal fake `document` carrying the exact surface the overlay touches:
  // `body` (the portal container — a distinct sentinel object, standing in for
  // the real <body>, so we can assert identity) plus the fullscreen-lifecycle
  // surface already exercised by the "full screen" tests below.
  function withPortalDom(run: (ctx: { body: object; doc: { body: object; fullscreenElement: unknown } }) => void) {
    const handlers: Record<string, Array<() => void>> = {};
    const body = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc: any = {
      body,
      fullscreenElement: null,
      addEventListener: (t: string, cb: () => void) => void (handlers[t] ??= []).push(cb),
      removeEventListener: (t: string, cb: () => void) => void (handlers[t] = (handlers[t] ?? []).filter((h) => h !== cb)),
      exitFullscreen: vi.fn(() => Promise.resolve()),
    };
    const prev = (globalThis as unknown as { document?: unknown }).document;
    (globalThis as unknown as { document: unknown }).document = doc;
    try {
      run({ body, doc });
    } finally {
      if (prev === undefined) delete (globalThis as unknown as { document?: unknown }).document;
      else (globalThis as unknown as { document: unknown }).document = prev;
    }
  }

  it("hands the overlay to createPortal with document.body as the container when expanded", () => {
    withPortalDom(({ body }) => {
      createPortalMock.mockClear();
      const { root } = renderBody(fence(smallScene));
      const expandBtn = findAll(root, (n) => n.type === "button").find((b) => textOf(b) === "expand")!;
      act(() => (expandBtn.props["onClick"] as () => void)());

      expect(createPortalMock).toHaveBeenCalledTimes(1);
      // the container argument is document.body itself (identity, not just
      // truthy) — this is what makes the real overlay a child of <body>,
      // never a descendant of the transcript's virtualized message blocks.
      expect(createPortalMock.mock.calls[0]![1]).toBe(body);
    });
  });

  it("does not call createPortal before the overlay is opened, and stops rendering the dialog once closed (no stranded portal)", () => {
    withPortalDom(() => {
      createPortalMock.mockClear();
      const { root, renderer } = renderBody(fence(smallScene));
      expect(createPortalMock).not.toHaveBeenCalled();

      const expandBtn = findAll(root, (n) => n.type === "button").find((b) => textOf(b) === "expand")!;
      act(() => (expandBtn.props["onClick"] as () => void)());
      expect(createPortalMock).toHaveBeenCalledTimes(1);

      const closeBtn = findAll(renderer.toJSON() as TreeNode, (n) => n.type === "button").find((b) => textOf(b) === "close")!;
      act(() => (closeBtn.props["onClick"] as () => void)());
      const after = renderer.toJSON() as TreeNode;
      expect(findAll(after, (n) => n.props["role"] === "dialog")).toHaveLength(0);
    });
  });

  it("toggling full screen (fallback path) still applies the maximized state through the portal", () => {
    withPortalDom(() => {
      let renderer!: ReturnType<typeof create>;
      act(() => {
        renderer = create(
          React.createElement(MessageBody, { text: fence(smallScene), done: true, rawView: false }),
          // ref-mock WITHOUT requestFullscreen → forces the maximized fallback
          { createNodeMock: (el) => ((el.props as { role?: string }).role === "dialog" ? {} : null) },
        );
      });
      const expandBtn = findAll(renderer.toJSON() as TreeNode, (n) => n.type === "button").find((b) => textOf(b) === "expand")!;
      act(() => (expandBtn.props["onClick"] as () => void)());
      const fsBtn = findAll(renderer.toJSON() as TreeNode, (n) => n.type === "button").find((b) => textOf(b).includes("full screen"))!;
      act(() => (fsBtn.props["onClick"] as () => void)());

      const dialog = findAll(renderer.toJSON() as TreeNode, (n) => n.props["role"] === "dialog")[0]!;
      expect(dialog.props["className"]).toContain("excalidrawOverlayMaximized");
    });
  });
});

describe("ExcalidrawBlock — full screen", () => {
  // node env has no DOM, so we stub the exact Fullscreen API surface the overlay
  // touches (document.fullscreenElement + add/removeEventListener + exitFullscreen)
  // and hand the overlay div a ref-mock carrying requestFullscreen. Then we assert
  // the "⛶ full screen" button requests fullscreen ON THE OVERLAY element and that
  // the toggle re-syncs off the fullscreenchange event (not off its own click).
  function withFullscreenDom(run: (ctx: { overlayEl: { requestFullscreen: ReturnType<typeof vi.fn> }; doc: { exitFullscreen: ReturnType<typeof vi.fn>; fullscreenElement: unknown } }) => void) {
    const handlers: Record<string, Array<() => void>> = {};
    const fire = (t: string) => (handlers[t] ?? []).slice().forEach((h) => h());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const overlayEl: any = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc: any = {
      fullscreenElement: null,
      addEventListener: (t: string, cb: () => void) => void (handlers[t] ??= []).push(cb),
      removeEventListener: (t: string, cb: () => void) => void (handlers[t] = (handlers[t] ?? []).filter((h) => h !== cb)),
      exitFullscreen: vi.fn(() => {
        doc.fullscreenElement = null;
        fire("fullscreenchange");
        return Promise.resolve();
      }),
    };
    overlayEl.requestFullscreen = vi.fn(() => {
      doc.fullscreenElement = overlayEl;
      fire("fullscreenchange");
      return Promise.resolve();
    });
    const prev = (globalThis as unknown as { document?: unknown }).document;
    (globalThis as unknown as { document: unknown }).document = doc;
    try {
      run({ overlayEl, doc });
    } finally {
      if (prev === undefined) delete (globalThis as unknown as { document?: unknown }).document;
      else (globalThis as unknown as { document: unknown }).document = prev;
    }
  }

  const fsButton = (root: TreeNode) => findAll(root, (n) => n.type === "button").find((b) => textOf(b).includes("full screen"));

  it("overlay bar has a ⛶ full-screen button that calls requestFullscreen on the overlay element + syncs on fullscreenchange", () => {
    withFullscreenDom(({ overlayEl, doc }) => {
      let renderer!: ReturnType<typeof create>;
      act(() => {
        renderer = create(
          React.createElement(MessageBody, { text: fence(smallScene), done: true, rawView: false }),
          // only the overlay div carries a ref → give IT the fullscreen-capable mock
          { createNodeMock: (el) => ((el.props as { role?: string }).role === "dialog" ? overlayEl : null) },
        );
      });
      // open the overlay
      const expandBtn = findAll(renderer.toJSON() as TreeNode, (n) => n.type === "button").find((b) => textOf(b) === "expand")!;
      act(() => (expandBtn.props["onClick"] as () => void)());

      // the bar carries the full-screen toggle, initially "enter"
      const enterBtn = fsButton(renderer.toJSON() as TreeNode)!;
      expect(enterBtn).toBeTruthy();
      expect(textOf(enterBtn)).toBe("⛶ full screen");

      // clicking it requests fullscreen on the OVERLAY element (not document.body)
      act(() => (enterBtn.props["onClick"] as () => void)());
      expect(overlayEl.requestFullscreen).toHaveBeenCalledTimes(1);
      expect(doc.fullscreenElement).toBe(overlayEl);

      // the fullscreenchange event (fired by our mock) flipped the toggle label
      const exitBtn = fsButton(renderer.toJSON() as TreeNode)!;
      expect(textOf(exitBtn)).toBe("⛶ exit full screen");
      expect(exitBtn.props["aria-pressed"]).toBe(true);

      // clicking again exits via the API, and the sync flips the label back
      act(() => (exitBtn.props["onClick"] as () => void)());
      expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
      expect(textOf(fsButton(renderer.toJSON() as TreeNode)!)).toBe("⛶ full screen");
    });
  });

  it("falls back to a maximized CSS state when the Fullscreen API is unavailable", () => {
    withFullscreenDom(({ doc }) => {
      let renderer!: ReturnType<typeof create>;
      act(() => {
        renderer = create(
          React.createElement(MessageBody, { text: fence(smallScene), done: true, rawView: false }),
          // ref-mock WITHOUT requestFullscreen → forces the fallback path
          { createNodeMock: (el) => ((el.props as { role?: string }).role === "dialog" ? {} : null) },
        );
      });
      const expandBtn = findAll(renderer.toJSON() as TreeNode, (n) => n.type === "button").find((b) => textOf(b) === "expand")!;
      act(() => (expandBtn.props["onClick"] as () => void)());
      act(() => (fsButton(renderer.toJSON() as TreeNode)!.props["onClick"] as () => void)());

      // no native fullscreen was entered…
      expect(doc.fullscreenElement).toBe(null);
      // …but the overlay took the maximized CSS class + the toggle reads "exit"
      const dialog = findAll(renderer.toJSON() as TreeNode, (n) => n.props["role"] === "dialog")[0]!;
      expect(dialog.props["className"]).toContain("excalidrawOverlayMaximized");
      expect(textOf(fsButton(renderer.toJSON() as TreeNode)!)).toBe("⛶ exit full screen");
    });
  });
});

describe("ExcalidrawBlock — the chimera permission-flow sample scene", () => {
  // The SAME fixture the manual dev-build smoke renders (a few rectangles,
  // arrows and labels). Proves a realistic multi-element scene detects and
  // takes the canvas path.
  const fixture = readFileSync(new URL("./fixtures/permission-flow.excalidraw.json", import.meta.url), "utf8");

  it("is valid JSON with the {type:'excalidraw', elements[]} envelope", () => {
    const scene = JSON.parse(fixture) as { type: string; elements: unknown[] };
    expect(scene.type).toBe("excalidraw");
    expect(Array.isArray(scene.elements)).toBe(true);
    expect(scene.elements.length).toBe(11);
  });

  it("renders the fixture as an inline excalidraw canvas (not a code dump)", () => {
    const { root } = renderBody(["```excalidraw", fixture, "```", ""].join("\n"));
    expect(findAll(root, hasClass("excalidrawWrap"))).toHaveLength(1);
    const label = findAll(root, hasClass("excalidrawLabel"))[0]!;
    expect(textOf(label)).toBe("excalidraw diagram · 11 elements");
    expect(findAll(root, (n) => n.type === "pre")).toHaveLength(0);
  });
});

// The public repository ships without maintainer docs, so this doc guard runs only where the doc exists.
const CLAUDE_MD = new URL("../../../CLAUDE.md", import.meta.url);
describe("EXCALIDRAW-DIAGRAMS — contract documented in CLAUDE.md", () => {
  it.skipIf(!existsSync(CLAUDE_MD))("repo CLAUDE.md carries the ```excalidraw fence contract so future agents know it", () => {
    const claudeMd = readFileSync(CLAUDE_MD, "utf8");
    expect(claudeMd).toContain("## Diagrams");
    expect(claudeMd).toContain("excalidraw");
    expect(claudeMd).toContain('"type": "excalidraw"');
  });
});

describe("ExcalidrawBlock — streaming", () => {
  it("shows a dim 'diagram streaming…' placeholder while an excalidraw fence is still open (not raw JSON)", () => {
    const { root } = renderBody('```excalidraw\n{"type":"excalidraw","elements":[', false);
    const ph = findAll(root, hasClass("streamingPlaceholder"));
    expect(ph).toHaveLength(1);
    expect(textOf(ph[0]!)).toBe("diagram streaming…");
    expect(JSON.stringify(root)).not.toContain("excalidrawWrap");
  });
});
