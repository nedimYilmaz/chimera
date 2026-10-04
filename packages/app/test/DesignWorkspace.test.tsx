import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/design/documents", async (original) => ({ ...(await original<typeof import("../src/design/documents")>()), staticDesignDocument: (text: string) => ({ html: text, removed: 0 }) }));
import { DesignPanel } from "../src/components/DesignWorkspace";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReactTestRenderer[] = [];
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); });
const artifact = (id: string) => ({ id, kind: "file", label: "Page", path: "/p/page.html", agentId: "test", taskId: null, createdAt: id === "v2" ? 2 : 1, sizeBytes: 20, url: null });
async function mount(request: any, readSnapshot: any) {
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<DesignPanel scope={{ agentId: "test" }} label="test" request={request} readSnapshot={readSnapshot} />); });
  roots.push(root);return root;
}
describe("DesignPanel async snapshots", () => {
 it("mounts safely before any artifact or snapshot exists", async () => {
   const root = await mount(() => new Promise(() => {}), vi.fn());
   expect(JSON.stringify(root.toJSON())).toContain("Loading designs");
 });
 it("reports list failures without pretending there are no designs", async () => {
   const root = await mount(async () => { throw new Error("unavailable"); }, vi.fn());
   expect(root.root.findByProps({ role: "alert" }).children).toContain("unavailable");
 });
 it("does not let a late previous revision overwrite the chosen one", async () => {
   let finishOld!: (text: string) => void;
   const root = await mount(async () => [artifact("v1"),artifact("v2")], (id: string) => id === "v2" ? new Promise((r) => { finishOld = r; }) : Promise.resolve("old version"));
   await act(async () => { root.root.findByProps({ "aria-label": "Design revision" }).props.onChange({ target: { value: "v1" } }); });
   expect(root.root.findByType("iframe").props.srcDoc).toBe("old version");
   await act(async () => { finishOld("late new version"); });
   expect(root.root.findByType("iframe").props.srcDoc).toBe("old version");
 });
 it("rejects oversized snapshots before reading them", async () => {
   const read = vi.fn();
   const root = await mount(async () => [{ ...artifact("large"), sizeBytes: 1048577 }], read);
   expect(read).not.toHaveBeenCalled();
   expect(root.root.findByProps({ role: "alert" }).children.join("")).toContain("1 MiB");
 });
});
