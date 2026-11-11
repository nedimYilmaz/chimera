import { afterEach, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Collapse } from "../src/components/Collapse";

let tree: ReactTestRenderer | undefined;
const render = (open: boolean) => React.createElement(Collapse, { open }, React.createElement("span", null, "content"));
function start() {
  vi.useFakeTimers();
  act(() => { tree = create(render(true)); });
  act(() => { tree!.update(render(false)); });
}
afterEach(() => {
  if (tree) act(() => tree!.unmount());
  tree = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("removes closed contents even when the browser emits no transitionend", () => {
  start();
  expect(tree!.toJSON()).not.toBeNull();
  act(() => { vi.advanceTimersByTime(300); });
  expect(tree!.toJSON()).toBeNull();
});

it("cancels delayed removal when reopened during the closing animation", () => {
  start();
  act(() => { vi.advanceTimersByTime(100); tree!.update(render(true)); });
  act(() => { vi.advanceTimersByTime(1000); });
  expect(tree!.toJSON()).not.toBeNull();
});

it("ignores a nested transition but removes on its own grid transition", () => {
  start();
  const wrapper = tree!.root.findAllByType("div")[0]!;
  const node = {};
  act(() => wrapper.props.onTransitionEnd({ propertyName: "grid-template-rows", target: {}, currentTarget: node }));
  expect(tree!.toJSON()).not.toBeNull();
  act(() => wrapper.props.onTransitionEnd({ propertyName: "grid-template-rows", target: node, currentTarget: node }));
  expect(tree!.toJSON()).toBeNull();
});

it("removes immediately under reduced motion", () => {
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
  start();
  expect(tree!.toJSON()).toBeNull();
});
