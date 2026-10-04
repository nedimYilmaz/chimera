import { describe, it, expect, vi } from "vitest";
import { AgentSupervisor } from "@chimera/core/supervisor";

// MANUAL-COMPACT-ANY-PROVIDER: for a provider whose SDK owns compaction, chimera asks by sending
// that CLI's own compact command. It only works VERBATIM (PARITY WS-B): sent as an ordinary
// message it arrives as "[from caller] /compact" and the attribution prefix masks the leading
// slash, so the backend never sees a command.
//
// Measured on a live agent when this was wrong: the model read "/compact" as prose and replied
// with a status summary, the context did not drop (854k → 865k → 929k across the attempt), and
// compact() still returned ok. One defaulted argument, and the result was an operation that
// reported success while doing nothing.

const harness = (handle: { compact?: () => Promise<unknown>; compactCommand?: string }) => {
  const sent: Array<{ text: string; slash: boolean }> = [];
  const appended: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const sup = Object.create(AgentSupervisor.prototype) as AgentSupervisor & Record<string, unknown>;
  Object.assign(sup, {
    status: () => ({ state: "running", provider: "claude" }),
    handles: new Map([["a1", handle]]),
    deps: { events: { append: (e: { kind: string; data: Record<string, unknown> }) => appended.push(e) } },
    send: async (_id: string, text: string, _from?: string, _images?: unknown, slash?: boolean) => {
      sent.push({ text, slash: slash === true });
    },
  });
  return { sup, sent, appended };
};

describe("asking a provider to compact", () => {
  it("sends the command through the SLASH channel — the prefix would otherwise mask it", async () => {
    const { sup, sent } = harness({ compactCommand: "/compact" });
    await sup.compact("a1");
    expect(sent).toEqual([{ text: "/compact", slash: true }]);
  });

  it("says the provider owns the outcome — ok means the request went out, not that context shrank", async () => {
    const { sup } = harness({ compactCommand: "/compact" });
    const res = await sup.compact("a1") as { ok: boolean; message: string };
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/provider's to run/);
    expect(res.message).not.toMatch(/\bdone\b|compacted/);   // never claims it happened
  });

  it("a provider chimera compacts ITSELF still reports a real before/after and sends nothing", async () => {
    const compact = vi.fn(async () => ({ ok: true, before: { tokens: 100 }, after: { tokens: 20 } }));
    const { sup, sent } = harness({ compact });
    const res = await sup.compact("a1") as { after?: { tokens: number } };
    expect(sent).toEqual([]);
    expect(res.after?.tokens).toBe(20);
  });
});
