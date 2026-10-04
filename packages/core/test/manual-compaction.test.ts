import { describe, it, expect, vi } from "vitest";
import { AgentSupervisor } from "@chimera/core/supervisor";

// MANUAL-COMPACT-ANY-PROVIDER: one operator gesture over two genuinely different mechanisms —
// chimera compacting the context it owns, versus chimera ASKING a provider's own agent loop to
// compact via the slash command its CLI already understands. The third case is the one that must
// stay honest: a provider offering neither still refuses rather than silently no-opping.

type Handle = { compact?: () => Promise<unknown>; compactCommand?: string };

const harness = (handle: Handle, state = "running") => {
  const appended: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const sent: string[] = [];
  const sup = Object.create(AgentSupervisor.prototype) as AgentSupervisor & Record<string, unknown>;
  Object.assign(sup, {
    status: () => ({ state, provider: "claude" }),
    handles: new Map([["a1", handle]]),
    deps: { events: { append: (e: { kind: string; data: Record<string, unknown> }) => appended.push(e) } },
    send: async (_id: string, text: string) => { sent.push(text); },
  });
  return { sup, appended, sent };
};

describe("supervisor.compact", () => {
  it("compacts directly when chimera owns the context", async () => {
    const compact = vi.fn(async () => ({ before: { tokens: 100 }, after: { tokens: 20 } }));
    const { sup, appended, sent } = harness({ compact });
    await sup.compact("a1");
    expect(compact).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
    expect(appended[0]).toMatchObject({ kind: "compaction", data: { phase: "start", owner: "chimera" } });
  });

  it("asks the PROVIDER's own loop when only a compact command exists — the claude/codex case", async () => {
    const { sup, appended, sent } = harness({ compactCommand: "/compact" });
    await sup.compact("a1");
    expect(sent).toEqual(["/compact"]);
    // owner is the SDK's, not chimera's — chimera did not perform this compaction and must not
    // claim a before/after it never observed
    expect(appended[0]).toMatchObject({ kind: "compaction", data: { phase: "start", owner: "sdk" } });
  });

  it("still refuses a provider offering neither, and says so without pretending", async () => {
    const { sup, appended } = harness({});
    await expect(sup.compact("a1")).rejects.toThrow(/no compact command/);
    expect(appended).toEqual([]);        // nothing announced for something that never started
  });

  it("emits an abort so a UI is never left pinned on 'compacting' by a failed trigger", async () => {
    const { sup, appended } = harness({ compact: async () => { throw new Error("stream closed"); } });
    await expect(sup.compact("a1")).rejects.toThrow(/stream closed/);
    expect(appended.map((e) => e.data["phase"])).toEqual(["start", "aborted"]);
  });

  it("refuses a non-running agent before announcing anything", async () => {
    const { sup, appended } = harness({ compactCommand: "/compact" }, "paused");
    await expect(sup.compact("a1")).rejects.toThrow(/cannot compact/);
    expect(appended).toEqual([]);
  });
});
