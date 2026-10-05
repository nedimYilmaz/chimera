import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { lazyScreen } from "../src/components/lazyScreen";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("lazy screen recovery", () => {
  it("contains a rejected route and genuinely reattempts the loader without losing chrome or drafts", async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error("fixture chunk offline"))
      .mockResolvedValue({ default: () => <div>Recovered actual route</div> });
    const Screen = lazyScreen(loader);
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<div><header>Persistent chrome</header><input defaultValue="unsent draft" /><React.Suspense fallback={<div>Loading</div>}><Screen /></React.Suspense></div>);
      await flush();
    });
    expect(JSON.stringify(tree.toJSON())).toContain("Persistent chrome");
    expect(JSON.stringify(tree.toJSON())).toContain("unsent draft");
    expect(JSON.stringify(tree.toJSON())).toContain("screen could not load");
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => { tree.root.findByType("button").props.onClick(); await flush(); });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(tree.toJSON())).toContain("Recovered actual route");
    expect(JSON.stringify(tree.toJSON())).toContain("unsent draft");
    act(() => tree.unmount());
  });
});


it("does not loop on persistent import failure and navigation can leave a pending route", async () => {
  const loader = vi.fn().mockRejectedValue(new Error("still offline"));
  const Screen = lazyScreen(loader);
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<Screen />); await flush(); });
  expect(loader).toHaveBeenCalledTimes(1);
  await act(async () => { tree.root.findByType("button").props.onClick(); await flush(); });
  expect(loader).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(tree.toJSON())).toContain("screen could not load");
  let resolve!: (value: { default: React.ComponentType }) => void;
  loader.mockImplementation(() => new Promise(r => { resolve = r; }));
  await act(async () => { tree.root.findByType("button").props.onClick(); await flush(); });
  expect(loader).toHaveBeenCalledTimes(3);
  await act(async () => { tree.update(<div>Other route with preserved draft</div>); });
  await act(async () => { resolve({ default: () => <div>Obsolete route</div> }); await flush(); });
  expect(JSON.stringify(tree.toJSON())).toContain("Other route with preserved draft");
  expect(JSON.stringify(tree.toJSON())).not.toContain("Obsolete route");
  act(() => tree.unmount());
});
