import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it } from "vitest";
import { ContextRing } from "../src/components/ContextRing";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReactTestRenderer;
afterEach(() => { if (root) act(() => root.unmount()); });
it("keeps unknown prompt occupancy distinct from zero", () => {
  act(() => { root = create(<ContextRing used={null} limit={100} />); });
  expect(root.root.findByProps({ role: "meter" }).props["aria-valuenow"]).toBeUndefined();
  act(() => root.update(<ContextRing used={0} limit={100} />));
  expect(root.root.findByProps({ role: "meter" }).props["aria-valuenow"]).toBe(0);
});
it.each([[69,"normal"],[70,"warning"],[90,"danger"],[150,"danger"]])("preserves occupancy thresholds at %s", (used,tone) => {
  act(() => { root = create(<ContextRing used={used as number} limit={100} compacting={false} />); });
  const meter = root.root.findByProps({ role: "meter" });
  expect(meter.props["data-tone"]).toBe(tone);
  expect(meter.props["aria-valuenow"]).toBe(Math.min(used as number,100));
});
it("compaction animates without replacing measured occupancy, then restores its tone", () => {
  act(() => { root = create(<ContextRing used={92} limit={100} compacting />); });
  expect(root.root.findByProps({ role: "meter" }).props).toMatchObject({"aria-valuenow":92,"aria-busy":true,"data-tone":"compacting"});
  expect(root.root.findAllByType("circle")).toHaveLength(3);
  act(() => root.update(<ContextRing used={35} limit={100} compacting={false} compactions={1} />));
  expect(root.root.findByProps({ role: "meter" }).props).toMatchObject({"aria-valuenow":35,"aria-busy":false,"data-tone":"normal"});
  expect(root.root.findAllByType("circle")).toHaveLength(2);
});
