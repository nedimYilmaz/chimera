import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { ChronicleSearchResponse, ChronicleExportResponse } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

// The agent-facing events_search used to search every agent's transcript, tool_input and
// tool_result. Lineage comes from real agent.spawn records; event text is appended directly so
// the assertion is about scoping alone, not about what a fake backend happens to emit.
const RUNNING: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "x" } }];

async function fleet() {
  const e = new Engine({ home: makeEngineHome(), backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([RUNNING, RUNNING, RUNNING, RUNNING])]]) });
  const spawn = async (parentId?: string) => (await e.handle("agent.spawn", {
    spec: { prompt: "p", cwd: "/tmp", isolation: "none" }, ...(parentId ? { parentId } : {}),
  }) as { agentId: string }).agentId;
  const parent = await spawn();
  const child = await spawn(parent);
  const grandchild = await spawn(child);
  const sibling = await spawn();
  const log = (e as unknown as { events: { append(ev: unknown): void } }).events;
  for (const agentId of [parent, child, grandchild, sibling]) {
    log.append({ agentId, kind: "tool_result", data: { output: `needle from ${agentId}` } });
  }
  const search = async (params: Record<string, unknown>) =>
    new Set(((await e.handle("events.search", { query: "needle", ...params })) as ChronicleSearchResponse).hits.map((h) => h.agentId));
  return { e, parent, child, grandchild, sibling, search };
}

describe("events.search caller scoping", () => {
  it("confines an agent caller to itself and its descendants", async () => {
    const { parent, child, grandchild, sibling, search } = await fleet();
    expect(await search({ callerAgentId: parent })).toEqual(new Set([parent, child, grandchild]));
    expect(await search({ callerAgentId: child })).toEqual(new Set([child, grandchild]));
    expect(await search({ callerAgentId: sibling })).toEqual(new Set([sibling]));
  });

  it("lets a requested agentIds scope narrow but never widen", async () => {
    const { parent, child, sibling, search } = await fleet();
    expect(await search({ callerAgentId: parent, scope: { agentIds: [child] } })).toEqual(new Set([child]));
    expect(await search({ callerAgentId: child, scope: { agentIds: [parent, sibling] } })).toEqual(new Set());
  });

  it("keeps the operator's unscoped search fleet-wide", async () => {
    const { parent, child, grandchild, sibling, search } = await fleet();
    expect(await search({})).toEqual(new Set([parent, child, grandchild, sibling]));
  });

  it("applies the same confinement to the export", async () => {
    const { e, child, sibling } = await fleet();
    const out = (await e.handle("events.searchExport", { query: "needle", callerAgentId: child })) as ChronicleExportResponse;
    expect(out.content).toContain(`needle from ${child}`);
    expect(out.content).not.toContain(sibling);
  });
});
