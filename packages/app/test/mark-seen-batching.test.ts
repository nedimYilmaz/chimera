import { describe, expect, it } from "vitest";
import { createStore } from "@chimera/ui-state";
import { AgentMarkSeenParamsSchema } from "@chimera/protocol";
import { createAgentCommands } from "../src/state/commands.agents";

// F47 "mark all seen" is a FLEET-WIDE sweep (AgentList's header chip passes
// unseenAgentIds(state) unfiltered), but agent.markSeen's params cap the array — so the sweep
// and the schema have to agree or a big fleet silently marks nothing.
describe("mark-all-seen on a fleet larger than the RPC id cap", () => {
  it("marks every id, splitting into as many calls as the cap requires", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `agent-${i}`);
    const store = createStore();
    const marked: string[] = [];
    let calls = 0;
    const cmds = createAgentCommands(store, async (method: string, params?: unknown) => {
      if (method !== "agent.markSeen") return undefined as never;
      calls++;
      // the daemon validates with the REAL schema before mutating anything (engine.ts:2440)
      marked.push(...AgentMarkSeenParamsSchema.parse(params).agentIds);
      return { ok: true, count: 0 } as never;
    });
    await cmds.markSeen(ids);
    expect(marked).toEqual(ids);
    expect(calls).toBe(2);
    expect(store.getState().commandError).toBeUndefined();
  });
});

// F47.FIX M-2: chunking means the sweep is NOT atomic — chunk N failing leaves 1..N-1 stamped.
// The operator must be told the boundary, not handed an error that reads as "nothing happened".
describe("a chunked sweep that fails partway (F47.FIX M-2)", () => {
  it("reports how many agents actually landed before the failure", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `agent-${i}`);
    const store = createStore();
    let calls = 0;
    const cmds = createAgentCommands(store, async (method: string) => {
      if (method !== "agent.markSeen") return undefined as never;
      // chunk 1 succeeds; chunk 2 and its retry both die on transport, not on an unknown method
      if (++calls >= 2) throw new Error("daemon closed the connection");
      return { ok: true, count: 500, unknownIds: [] } as never;
    });

    await cmds.markSeen(ids, { skipUnknown: true });

    // guarded() routes a thrown command error onto `lastError` (commands.agents.ts:1057).
    expect(store.getState().lastError).toContain("marked 500 of 501 agents");
    expect(store.getState().lastError).toContain("daemon closed the connection");
  });

  it("a daemon predating skipUnknown rejects the key, and the plain retry carries the sweep", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `agent-${i}`);
    const store = createStore();
    const marked: string[] = [];
    const cmds = createAgentCommands(store, async (method: string, params?: unknown) => {
      if (method !== "agent.markSeen") return undefined as never;
      // a pre-fix daemon parses with a .strict() schema: an unknown KEY is rejected outright.
      if ((params as { skipUnknown?: boolean }).skipUnknown === true) throw new Error("unrecognized key skipUnknown");
      marked.push(...AgentMarkSeenParamsSchema.parse(params).agentIds);
      return { ok: true, count: 0 } as never;
    });

    await cmds.markSeen(ids, { skipUnknown: true });

    expect(marked).toEqual(ids);
    expect(store.getState().lastError).toBeNull();
  });
});
