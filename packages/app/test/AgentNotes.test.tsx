import { afterEach, expect, it, vi } from "vitest";
import { act, create } from "react-test-renderer";
import { AgentNotes, agentNotesKey } from "../src/components/AgentNotes";

afterEach(() => vi.unstubAllGlobals());
it("stores notes locally by exact identity and isolates agent switches", () => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) });
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(<AgentNotes key="a" agentId="a" />); });
  act(() => tree.root.findByType("textarea").props.onChange({ target: { value: "operator note" } }));
  act(() => tree.root.findByType("button").props.onClick());
  expect(data.get(agentNotesKey("a"))).toBe("operator note");
  act(() => tree.update(<AgentNotes key="b" agentId="b" />));
  expect(tree.root.findByType("textarea").props.value).toBe("");
  act(() => tree.unmount());
});
it("keeps the draft if browser storage fails", () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("quota"); } });
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(<AgentNotes agentId="a" />); });
  act(() => tree.root.findByType("textarea").props.onChange({ target: { value: "draft" } }));
  act(() => tree.root.findByType("button").props.onClick());
  expect(tree.root.findByType("textarea").props.value).toBe("draft");
  expect(JSON.stringify(tree.toJSON())).toContain("Unable to save");
  act(() => tree.unmount());
});
