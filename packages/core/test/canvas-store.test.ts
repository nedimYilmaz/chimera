import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyCanvasLayout } from "@chimera/protocol";
import { CanvasStore } from "../src/canvas-store.js";

describe("canvas cosmetic storage", () => {
  it("persists positions/groups/zoom, refuses competing writers, prunes removals without reflow and isolates project paths", () => {
    const home = mkdtempSync(join(tmpdir(), "canvas-"));
    try {
      const store = new CanvasStore(home), refs = new Set(["agent:a", "agent:b"]);
      const layout = { ...emptyCanvasLayout(), positions: { "agent:a": { x: 130, y: -20, group: "g" }, "agent:b": { x: 9, y: 5 } }, groups: [{ id: "g", title: "Review" }], viewport: { x: 70, y: 40, zoom: 0.5 } };
      expect(store.save("../project", 0, layout, refs)).toEqual({ revision: 1 });
      expect(new CanvasStore(home).get("../project", refs).layout).toEqual(layout);
      expect(() => store.save("../project", 0, layout, refs)).toThrow("stale_revision");
      expect(store.get("../project", new Set(["agent:a"])).layout.positions).toEqual({ "agent:a": layout.positions["agent:a"] });
      expect(store.get("different", refs).revision).toBe(0);
      expect(() => store.save("../project", 1, layout, new Set(["agent:a"]))).toThrow("outside this project");
      expect(() => store.save("../project", 1, { ...layout, viewport: { x: 0, y: 0, zoom: 0 } }, refs)).toThrow();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it("never overwrites unknown versions, corruption or oversized files", () => {
    const home = mkdtempSync(join(tmpdir(), "canvas-"));
    try {
      const store = new CanvasStore(home), file = store.path("p"), refs = new Set<string>();
      writeFileSync(file, '{"v":2,"private":"future"}');
      expect(store.get("p", refs).readOnly).toBe(true);
      expect(() => store.save("p", 0, emptyCanvasLayout(), refs)).toThrow("read-only");
      expect(readFileSync(file, "utf8")).toContain("future");
      writeFileSync(file, "invalid"); expect(() => store.save("p", 0, emptyCanvasLayout(), refs)).toThrow();
      writeFileSync(file, "x".repeat(256 * 1024 + 1)); expect(() => store.get("p", refs)).toThrow("256 KiB");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
it("refuses an oversized new arrangement before replacing the last good file", () => {
  const home = mkdtempSync(join(tmpdir(), "canvas-size-"));
  try {
    const store = new CanvasStore(home); store.save("p", 0, emptyCanvasLayout(), new Set());
    const before = readFileSync(store.path("p"), "utf8");
    const positions = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`agent:${String(i).padStart(233, "x")}`, { x: 100000, y: 100000, collapsed: true }]));
    expect(() => store.save("p", 1, { ...emptyCanvasLayout(), positions }, new Set(Object.keys(positions)))).toThrow("256 KiB");
    expect(readFileSync(store.path("p"), "utf8")).toBe(before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
