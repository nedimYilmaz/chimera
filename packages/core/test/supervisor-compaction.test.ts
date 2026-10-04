import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { UnknownAgentError, AgentNotRunningError, CompactionUnsupportedError } from "@chimera/core/supervisor";
import { makeSupervisor } from "./helpers.js";

// COMPACTION-OBSERVABILITY: AgentSupervisor.compact — the manual-trigger RPC path.
// FakeAgentBackend's handle never implements compact() (mirrors claude.ts/codex.ts's REAL
// absence — chimera doesn't own compaction for either), so exercising it via the ordinary
// makeSupervisor() fake IS the honest refusal path a real claude/codex agent hits today.
const RUNNING: FakeStep[] = [
  { emit: { kind: "agent_started", data: { sessionId: "sess-1" } } },
  { awaitSend: true },
];

describe("AgentSupervisor.compact", () => {
  it("throws UnknownAgentError for a ghost/unknown agentId", async () => {
    const { sup } = makeSupervisor([]);
    await expect(sup.compact("ghost-id")).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it("throws AgentNotRunningError for a non-running agent", async () => {
    const { sup } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await new Promise((r) => setTimeout(r, 30));   // let it settle to "done"

    await expect(sup.compact(rec.agentId)).rejects.toBeInstanceOf(AgentNotRunningError);
  });

  it("refuses honestly with CompactionUnsupportedError for a provider whose handle has no compact() — never pretends it worked", async () => {
    const { sup } = makeSupervisor([RUNNING]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await new Promise((r) => setTimeout(r, 20));

    const err = await sup.compact(rec.agentId).catch((e) => e);
    expect(err).toBeInstanceOf(CompactionUnsupportedError);
    expect(err).toMatchObject({ code: "protocol" });
    expect(err.message).toContain("claude");
    expect(err.message).toContain("does not own context compaction");
  });
});
