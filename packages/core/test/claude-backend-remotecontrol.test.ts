import { describe, it, expect, vi } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { ResolvedAgentSpec } from "@chimera/core/backend";

// REMOTE-CONTROL: the claude.ts handle's remoteControl() calls the SDK Query object's
// `enableRemoteControl` control request LIVE (no kill/respawn) — verified empirically
// against a real CLI session (docs/superpowers/design-plans/REMOTE-CONTROL.md); this
// method is undocumented in the SDK's public Query type, so the backend reaches for it
// defensively via a cast and fails clearly if a build doesn't have it.

type Msg = Record<string, unknown>;
function spec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/repo", isolation: "none", ...over }),
    agentId: "ag-1", accountName: "second", resolvedProvider: "claude",
    env: { ANTHROPIC_AUTH_TOKEN: "tok-x", CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}
const settle = () => new Promise((r) => setTimeout(r, 20));

function fakeQueryWithRemoteControl(messages: Msg[], enableRemoteControl?: (enabled: boolean, name?: string) => Promise<unknown>) {
  const fn = ((_args: unknown) => ({
    async *[Symbol.asyncIterator]() { for (const m of messages) yield m; },
    interrupt: vi.fn(async () => {}),
    ...(enableRemoteControl ? { enableRemoteControl } : {}),
  })) as never;
  return fn;
}

describe("ClaudeAgentBackend handle.remoteControl", () => {
  it("enable: forwards to the SDK's enableRemoteControl and maps session_url/connect_url", async () => {
    const enableRemoteControl = vi.fn(async (enabled: boolean, name?: string) => {
      expect(enabled).toBe(true);
      expect(name).toBe("chimera-ag1");
      return { session_url: "https://claude.ai/code/session_abc", connect_url: "https://claude.ai/code?environment=" };
    });
    const fn = fakeQueryWithRemoteControl([{ type: "system", subtype: "init", session_id: "s1" }], enableRemoteControl);
    const handle = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true);
    await settle();

    const result = await handle.remoteControl!(true, "chimera-ag1");

    expect(enableRemoteControl).toHaveBeenCalledWith(true, "chimera-ag1");
    expect(result).toEqual({ sessionUrl: "https://claude.ai/code/session_abc", connectUrl: "https://claude.ai/code?environment=" });
  });

  it("disable: forwards enabled:false and returns undefined for an undefined SDK response", async () => {
    const enableRemoteControl = vi.fn(async () => undefined);
    const fn = fakeQueryWithRemoteControl([{ type: "system", subtype: "init", session_id: "s1" }], enableRemoteControl);
    const handle = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true);
    await settle();

    const result = await handle.remoteControl!(false);

    expect(enableRemoteControl).toHaveBeenCalledWith(false, undefined);
    expect(result).toBeUndefined();
  });

  it("throws a clear error when the SDK build has no enableRemoteControl method", async () => {
    const fn = fakeQueryWithRemoteControl([{ type: "system", subtype: "init", session_id: "s1" }]);   // no enableRemoteControl
    const handle = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true);
    await settle();

    await expect(handle.remoteControl!(true)).rejects.toThrow(/enableRemoteControl/);
  });
});
