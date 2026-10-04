import { describe, it, expect } from "vitest";
import { ChimeraConfigSchema } from "@chimera/protocol";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor } from "./helpers.js";

// F08.QA: `record.failure` describes ONE death. onError stamps it and the crash-loop breaker
// forwards it deliberately — every other markFailed site (rerouted launch, resume, setModel,
// reconfigure, setAccount, handoff, rebind) never ran the classifier, so whatever is still on
// the record belongs to an EARLIER incident. agent.status and the app's terminalFailureExcerpt
// read record.failure directly, so a stale one misreports the death that actually happened.

// "second" resolves through the keychain, and helpers.ts's fakeExec only answers for service
// "svc" — so the failover reroute launch rejects, which is the path the supervisor's own
// comment names ("e.g. credential resolve fails on the new account").
const CFG_BAD_SECOND = ChimeraConfigSchema.parse({
  accounts: [
    { name: "main", provider: "claude", auth: { type: "subscription" } },
    { name: "second", provider: "claude", auth: { type: "keychain", service: "nope", injectAs: "ANTHROPIC_AUTH_TOKEN" } },
  ],
  autoOrder: ["main", "second"],
  caps: { maxAgentsTotal: 2, perAccount: { main: 1 } },
});

const RATE_FAIL: FakeStep[] = [{ fail: { message: "HTTP 429 Too Many Requests" } }];

describe("F08.QA: a failure that never ran the classifier carries no stale disposition", () => {
  it("a rerouted launch that rejects fails the agent WITHOUT the 429's provider-rate-limit disposition", async () => {
    const { sup } = makeSupervisor([RATE_FAIL], CFG_BAD_SECOND);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 3000);

    expect(final.state).toBe("failed");
    expect(final.failure).toBeUndefined();
  });
});
