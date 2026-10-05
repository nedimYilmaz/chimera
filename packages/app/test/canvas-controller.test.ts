import { it, expect } from "vitest";
import { emptyCanvasLayout } from "@chimera/protocol";
import { CanvasController, type CanvasRequest } from "../src/state/canvas-controller";
const graph = () => ({ revision: 0, readOnly: false, layout: emptyCanvasLayout(), nodes: [{ ref: "agent:a", entityId: "a", kind: "agent", label: "A", status: "idle" }], edges: [], truncated: false });
it("retains local arrangement and selection on stale revision, retries against refreshed revision", async () => {
  let server = graph(), conflict = true;
  const saved: unknown[] = [];
  const request = (async (method: string, params: unknown) => {
    if (method === "canvas.get") return server;
    saved.push(params);
    if (conflict) { conflict = false; server = { ...server, revision: 8 }; throw new Error("stale_revision"); }
    return { revision: 9 };
  }) as CanvasRequest;
  const c = new CanvasController("p", request); await c.load(); c.select("agent:a");
  c.update({ ...c.getState().layout, positions: { "agent:a": { x: 91, y: 22 } } }, "agent:a");
  await c.save(); expect(c.getState()).toMatchObject({ dirty: true, selected: "agent:a", layout: { positions: { "agent:a": { x: 91 } } }, saveError: expect.stringContaining("retained") });
  await c.save(); expect(saved[1]).toMatchObject({ baseRevision: 8 }); expect(c.getState().dirty).toBe(false);
});
it("drops old replies on disconnect/dispose, preserves last good data on transient error and clears removed selection", async () => {
  let deferred: ((v: unknown) => void) | null = null, fail = false, value = graph();
  const request = (async () => { if (fail) throw new Error("temporary"); if (deferred) return await new Promise(resolve => { deferred = resolve; }); return value; }) as CanvasRequest;
  const c = new CanvasController("p", request); await c.load(); c.select("agent:a");
  fail = true; await c.load(); expect(c.status.getState().error).toBe("temporary"); expect(c.getState().graph?.nodes).toHaveLength(1);
  fail = false; value = { ...value, nodes: [] }; await c.load(); expect(c.getState().selected).toBeNull();
  deferred = () => {}; const pending = c.load(); c.interrupt(); deferred!(graph()); await pending; expect(c.getState().graph?.nodes).toHaveLength(0);
  c.dispose();
});
it("keeps edits made during a save dirty for the next revision and separates project owners", async () => {
  let resolve: (v: unknown) => void = () => {};
  const request = (async (m: string) => m === "canvas.get" ? graph() : await new Promise(r => { resolve = r; })) as CanvasRequest;
  const c = new CanvasController("p", request); await c.load(); c.update({ ...c.getState().layout, viewport: { x: 20, y: 0, zoom: 1 } }); const saving = c.save(); c.update({ ...c.getState().layout, viewport: { x: 40, y: 0, zoom: 1 } }); resolve({ revision: 1 }); await saving;
  expect(c.getState()).toMatchObject({ dirty: true, layout: { viewport: { x: 40 } }, graph: { revision: 1 } });
  expect(new CanvasController("other", request).getState().layout.viewport.x).toBe(0);
});
it("isolates project switches and rejects old owner's delayed responses after disposal", async () => {
  let finish: (v: unknown) => void = () => {};
  const oldOwner = new CanvasController("old", (async () => await new Promise(r => { finish = r; })) as CanvasRequest);
  const pending = oldOwner.load(); oldOwner.dispose();
  const newOwner = new CanvasController("new", (async () => ({ ...graph(), revision: 6, nodes: [{ ref: "agent:new", entityId: "new", kind: "agent", label: "New project", status: "idle" }] })) as CanvasRequest);
  await newOwner.load(); finish(graph()); await pending;
  expect(oldOwner.getState().graph).toBeNull(); expect(newOwner.getState().graph?.nodes.map(n => n.ref)).toEqual(["agent:new"]);
});
it("saves after the same owner's StrictMode effect cleanup/setup cycle", async () => {
  let writes = 0;
  const c = new CanvasController("p", (async (method: string) => method === "canvas.get" ? graph() : { revision: ++writes }) as CanvasRequest);
  await c.load(); c.dispose(); c.activate(); await c.load(); c.update({ ...c.getState().layout, viewport: { x: 60, y: 0, zoom: 1 } }); await c.save();
  expect(writes).toBe(1); expect(c.getState().dirty).toBe(false);
});
