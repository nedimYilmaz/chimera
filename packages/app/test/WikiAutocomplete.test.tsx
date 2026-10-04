import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { useWikiAutocomplete, WikiAutocompletePopup } from "../src/components/WikiAutocomplete";

// MEM-5 (PLAN-MEMORY.md §8) — the `[[` title-autocomplete's branchy pure-ish
// core. The hook reads the live value+caret off a DOM-ish element (elRef), so we
// drive it with a hand-built fake element (this package's vitest env is plain
// node, no jsdom) and assert: open-token regex detection, candidate filter/cap,
// caret-splice insert, and keyboard nav. Same node-env shim discipline the other
// render harnesses in this suite use.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
if (typeof globalThis.requestAnimationFrame === "undefined") {
  (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = (cb) => {
    cb(0);
    return 0;
  };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FieldEl = HTMLInputElement | HTMLTextAreaElement;
type FakeEl = {
  value: string;
  selectionStart: number;
  focus: () => void;
  setSelectionRange: (a: number, b: number) => void;
  range: [number, number] | null;
};
const makeEl = (value: string, caret = value.length): FakeEl => ({
  value,
  selectionStart: caret,
  focus: () => {},
  range: null,
  setSelectionRange(a, b) {
    this.range = [a, b];
    this.selectionStart = a;
  },
});

type Api = ReturnType<typeof useWikiAutocomplete>;
let api!: Api;
function Harness({ titles, elRef, onChange }: { titles: string[]; elRef: React.RefObject<FieldEl | null>; onChange: (n: string) => void }) {
  api = useWikiAutocomplete({ titles, elRef, onChange });
  return null;
}

let mounted: ReturnType<typeof create> | null = null;
function mount(titles: string[], el: FakeEl | null, onChange = vi.fn()): { ref: { current: FieldEl | null }; onChange: ReturnType<typeof vi.fn> } {
  const ref = { current: (el as unknown as FieldEl) ?? null };
  act(() => {
    mounted = create(React.createElement(Harness, { titles, elRef: ref as React.RefObject<FieldEl | null>, onChange }));
  });
  return { ref, onChange };
}
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

// a KeyboardEvent-lite carrying just what the hook reads.
const key = (k: string) => {
  const ev = { key: k, preventDefault: vi.fn() } as unknown as React.KeyboardEvent;
  return ev;
};

const TITLES = ["Note A", "Note B", "Gate Wait Death", "abrupt-exit"];

describe("useWikiAutocomplete — open-token detection (refresh)", () => {
  it("opens on a bare `[[partial` immediately left of the caret", () => {
    const el = makeEl("see [[No");
    mount(TITLES, el);
    act(() => api.refresh());
    expect(api.showing).toBe(true);
    expect(api.query).toBe("No");
    expect(api.candidates).toEqual(["Note A", "Note B"]);
  });

  it("reads only the trailing open token, ignoring an earlier closed `[[..]]`", () => {
    const el = makeEl("[[Note A]] then [[Ga");
    mount(TITLES, el);
    act(() => api.refresh());
    expect(api.query).toBe("Ga");
    expect(api.candidates).toEqual(["Gate Wait Death"]);
  });

  it("stays closed when there is no open token left of the caret", () => {
    const el = makeEl("just some plain prose");
    mount(TITLES, el);
    act(() => api.refresh());
    expect(api.showing).toBe(false);
  });

  it("closes when a `|` or `]]` breaks the token before the caret", () => {
    const el = makeEl("[[Note A]] done");
    mount(TITLES, el);
    act(() => api.refresh());
    expect(api.showing).toBe(false);
  });

  it("uses the caret (not string end) to bound the open token", () => {
    // caret sits right after "[[No"; the "xx]]" after the caret must be ignored.
    const el = makeEl("[[Noxx]]", 4);
    mount(TITLES, el);
    act(() => api.refresh());
    expect(api.query).toBe("No");
    expect(api.showing).toBe(true);
  });

  it("closes when the element ref is null", () => {
    mount(TITLES, null);
    act(() => api.refresh());
    expect(api.showing).toBe(false);
  });
});

describe("useWikiAutocomplete — candidate filter", () => {
  it("offers every title (capped) for an empty `[[` token", () => {
    const many = Array.from({ length: 12 }, (_, i) => `T${i}`);
    const el = makeEl("[[");
    mount(many, el);
    act(() => api.refresh());
    expect(api.showing).toBe(true);
    expect(api.candidates).toHaveLength(8); // cap at 8
  });

  it("filters case-insensitively by substring", () => {
    const el = makeEl("[[note");
    mount(TITLES, el);
    act(() => api.refresh());
    expect(api.candidates).toEqual(["Note A", "Note B"]);
  });

  it("does not show when the filter has no matches", () => {
    const el = makeEl("[[zzz");
    mount(TITLES, el);
    act(() => api.refresh());
    expect(api.candidates).toEqual([]);
    expect(api.showing).toBe(false);
  });
});

describe("useWikiAutocomplete — insert (caret splice)", () => {
  it("splices `[[Title]]` at the token start and drops the caret past the `]]`", () => {
    const el = makeEl("x [[No");
    const { onChange } = mount(TITLES, el);
    act(() => api.refresh());
    act(() => api.insert("Note A"));
    expect(onChange).toHaveBeenCalledWith("x [[Note A]]");
    // caret = tokenStart(2) + title.length(6) + 4 = 12
    expect(el.range).toEqual([12, 12]);
  });

  it("preserves text after the caret when splicing mid-string", () => {
    const el = makeEl("a [[No tail", 6); // caret right after "[[No"
    const { onChange } = mount(TITLES, el);
    act(() => api.refresh());
    act(() => api.insert("Note B"));
    expect(onChange).toHaveBeenCalledWith("a [[Note B]] tail");
  });

  it("is a no-op when no open token was established", () => {
    const el = makeEl("plain");
    const { onChange } = mount(TITLES, el);
    act(() => api.insert("Note A"));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("useWikiAutocomplete — keyboard nav (onKeyDown)", () => {
  it("returns false (does not consume) while closed", () => {
    const el = makeEl("plain");
    mount(TITLES, el);
    act(() => api.refresh());
    let consumed = true;
    act(() => { consumed = api.onKeyDown(key("Enter")); });
    expect(consumed).toBe(false);
  });

  it("ArrowDown/ArrowUp move the active index, wrapping at the ends", () => {
    const el = makeEl("[[note"); // 2 candidates
    mount(TITLES, el);
    act(() => api.refresh());
    expect(api.active).toBe(0);
    act(() => { api.onKeyDown(key("ArrowDown")); });
    expect(api.active).toBe(1);
    act(() => { api.onKeyDown(key("ArrowDown")); });
    expect(api.active).toBe(0); // wraps
    act(() => { api.onKeyDown(key("ArrowUp")); });
    expect(api.active).toBe(1); // wraps back
  });

  it("Enter inserts the active candidate and consumes the key", () => {
    const el = makeEl("[[note");
    const { onChange } = mount(TITLES, el);
    act(() => api.refresh());
    act(() => { api.onKeyDown(key("ArrowDown")); }); // active → Note B
    let consumed = false;
    act(() => { consumed = api.onKeyDown(key("Enter")); });
    expect(consumed).toBe(true);
    expect(onChange).toHaveBeenCalledWith("[[Note B]]");
  });

  it("Escape closes the popup and consumes the key", () => {
    const el = makeEl("[[note");
    mount(TITLES, el);
    act(() => api.refresh());
    expect(api.showing).toBe(true);
    let consumed = false;
    act(() => { consumed = api.onKeyDown(key("Escape")); });
    expect(consumed).toBe(true);
    expect(api.showing).toBe(false);
  });
});

// ---------------------------------------------------------------------------

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };
const findAll = (node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] => {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) if (typeof c !== "string") findAll(c, pred, out);
  return out;
};

describe("WikiAutocompletePopup", () => {
  it("renders one option per candidate and marks the active one", () => {
    let r!: ReturnType<typeof create>;
    act(() => {
      r = create(React.createElement(WikiAutocompletePopup, { candidates: ["Note A", "Note B"], active: 1, onPick: vi.fn() }));
    });
    const tree = r.toJSON() as TreeNode;
    const options = findAll(tree, (n) => n.props["role"] === "option");
    expect(options.map((o) => o.props["data-wiki-option"])).toEqual(["Note A", "Note B"]);
    expect(options[1]!.props["aria-selected"]).toBe(true);
    expect(options[0]!.props["aria-selected"]).toBe(false);
    act(() => r.unmount());
  });

  it("fires onPick on mousedown (before the field blurs)", () => {
    const onPick = vi.fn();
    let r!: ReturnType<typeof create>;
    act(() => {
      r = create(React.createElement(WikiAutocompletePopup, { candidates: ["Note A"], active: 0, onPick }));
    });
    const option = findAll(r.toJSON() as TreeNode, (n) => n.props["role"] === "option")[0]!;
    (option.props["onMouseDown"] as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
    expect(onPick).toHaveBeenCalledWith("Note A");
    act(() => r.unmount());
  });
});
