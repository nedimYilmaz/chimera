import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// PARITY WS-B: the `slash` flag must survive the FULL RPC round-trip — SendParams.parse
// (engine.ts) → supervisor.send(…, p.slash) → mailbox → deliverBatch. The supervisor/store
// unit tests each cover one side of this seam; these tests cross it end-to-end through the
// engine so that dropping `slash` from SendParams or the send() call is actually caught.
function engineWithScenarios(scenarios: FakeStep[][]): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]),
  });
}
const spawnBody = () => ({ spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } });

describe("Engine.handle agent.send — WS-B slash round-trip", () => {
  it("delivers a slash:true message VERBATIM (the fake echoes the exact delivered text)", async () => {
    const e = engineWithScenarios([[{ awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };

    await e.handle("agent.send", { agentId: rec.agentId, text: "/compact go", from: "tui", slash: true });
    await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });

    const echo = e.events.tail(rec.agentId, 50).find((ev) => ev.kind === "message_complete");
    expect(echo?.data["text"]).toBe("echo:/compact go");       // no "[from tui] " prefix
  });

  it("still prefixes when slash is omitted (default false) — proves the flag, not text, drives it", async () => {
    const e = engineWithScenarios([[{ awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };

    await e.handle("agent.send", { agentId: rec.agentId, text: "/compact go", from: "tui" });   // no slash key
    await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });

    const echo = e.events.tail(rec.agentId, 50).find((ev) => ev.kind === "message_complete");
    expect(echo?.data["text"]).toBe("echo:[from tui] /compact go");
  });
});
