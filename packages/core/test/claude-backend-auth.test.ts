import { describe, it, expect } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";

// Task AUTH-a: SDKAssistantMessage.error surfacing — the backend maps an AUTH-subtype
// `msg.error` (authentication_failed | oauth_org_not_allowed) into a status event
// carrying `authError`, so the supervisor can react. Non-auth subtypes (rate_limit,
// billing_error) must NOT produce this status event.

type Msg = Record<string, unknown>;
function fakeQuery(messages: Msg[]) {
  const fn = (() => ({
    async *[Symbol.asyncIterator]() { for (const m of messages) yield m; },
    interrupt: async () => {},
  })) as never;
  return fn;
}
function spec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/repo", isolation: "none", ...over }),
    agentId: "ag-1", accountName: "second", resolvedProvider: "claude",
    env: { ANTHROPIC_AUTH_TOKEN: "tok-x", CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("ClaudeAgentBackend: auth-error surfacing (Task AUTH-a)", () => {
  it("an assistant message with error:authentication_failed emits a status event with data.authError", async () => {
    const fn = fakeQuery([
      { type: "assistant", error: "authentication_failed", message: { role: "assistant", content: [] } },
    ]);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["status", "result"]);
    expect(evs[0]!.data).toEqual({ authError: "authentication_failed" });
  });

  it("an assistant message with error:oauth_org_not_allowed also emits a status{authError} event", async () => {
    const fn = fakeQuery([
      { type: "assistant", error: "oauth_org_not_allowed", message: { role: "assistant", content: [] } },
    ]);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["status", "result"]);
    expect(evs[0]!.data).toEqual({ authError: "oauth_org_not_allowed" });
  });

  it("an assistant message with error:rate_limit does NOT emit an authError status event", async () => {
    const fn = fakeQuery([
      { type: "assistant", error: "rate_limit", message: { role: "assistant", content: [] } },
    ]);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["result"]);
    expect(evs.some((e) => e.kind === "status")).toBe(false);
  });

  // ---------- additional branch/edge coverage ----------

  it("an assistant message with error:billing_error does NOT emit an authError status event", async () => {
    const fn = fakeQuery([
      { type: "assistant", error: "billing_error", message: { role: "assistant", content: [] } },
    ]);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.some((e) => e.kind === "status")).toBe(false);
  });

  it("an assistant message with no error field at all is unaffected (regression, no authError status)", async () => {
    const fn = fakeQuery([
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    ]);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["message_complete", "result"]);
  });

  it("a non-string error value (malformed) is ignored, not thrown", async () => {
    const fn = fakeQuery([
      { type: "assistant", error: 42, message: { role: "assistant", content: [] } },
    ]);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.some((e) => e.kind === "status")).toBe(false);
    expect(evs.some((e) => e.kind === "error")).toBe(false);
  });

  it("an unrecognized string error subtype is ignored (only the two AUTH subtypes trigger)", async () => {
    const fn = fakeQuery([
      { type: "assistant", error: "some_future_subtype", message: { role: "assistant", content: [] } },
    ]);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.some((e) => e.kind === "status")).toBe(false);
  });

  it("an authError status event still allows the SAME message's content blocks to map normally (no regression)", async () => {
    const fn = fakeQuery([
      {
        type: "assistant", error: "authentication_failed",
        message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
      },
    ]);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["status", "message_complete", "result"]);
    expect(evs[0]!.data).toEqual({ authError: "authentication_failed" });
    expect(evs[1]!.data).toEqual({ text: "partial" });
  });
});
