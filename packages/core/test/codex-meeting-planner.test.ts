import { describe, it, expect, vi } from "vitest";
import { CodexMeetingPlanner } from "../src/backends/codex-meeting-planner.js";
import type { CodexRpc } from "../src/backends/codex-rpc.js";

const result = { action: "speak", agentId: "atlas", discussion: true, topic: "Latency", contribution: "Explain the tradeoff", reason: "Relevant earlier contribution" };
function setup() {
  const request = vi.fn(async (method: string) => method === "config/read" ? { config: { mcp_servers: { secretConnector: { url: "private" } }, plugins: { shared: {} }, apps: { drive: {} } } } : method === "thread/start" ? { thread: { id: "planner" } } : method === "turn/start" ? { turn: { id: "plan-turn" } } : {});
  const planner = new CodexMeetingPlanner({ request } as unknown as CodexRpc);
  const send = (method: string, data: object) => planner.notification(method, { threadId: "planner", ...data });
  return { planner, request, send };
}
describe("isolated Codex meeting participation planning", () => {
  it("uses ephemeral restricted planning, validates output and never consumes coding events", async () => {
    const s = setup(); const pending = s.planner.plan("conversation-data", new AbortController().signal);
    await vi.waitFor(() => expect(s.request).toHaveBeenCalledWith("turn/start", expect.anything()));
    expect(s.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ ephemeral: true, approvalPolicy: "untrusted", sandbox: "read-only", config: expect.objectContaining({ "features.shell_tool": false, "features.apps": false, mcp_servers: { secretConnector: { enabled: false } } }) }));
    expect(s.planner.notification("turn/started", { threadId: "coding", turn: { id: "coding-turn" } })).toBe(false);
    s.send("item/completed", { item: { type: "agentMessage", text: JSON.stringify(result) } });
    s.send("turn/completed", { turn: { status: "completed" } });
    expect(await pending).toEqual(result);
    expect(s.request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "planner" });
    expect(JSON.stringify(s.request.mock.calls.find(([m]) => m === "turn/start"))).not.toContain("private");
  });
  it.each(["invalid-json", JSON.stringify({ ...result, agentId: null }), JSON.stringify({ ...result, contribution: "x".repeat(501) })])("rejects malformed or unbounded output", async output => {
    const s = setup(); const pending = s.planner.plan("topic", new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow("Invalid participation");
    await vi.waitFor(() => expect(s.request).toHaveBeenCalledWith("turn/start", expect.anything()));
    s.send("item/completed", { item: { type: "agentMessage", text: output } }); s.send("turn/completed", { turn: { status: "completed" } });
    await rejected;
  });
  it("cancels only its planning turn and ignores late results", async () => {
    const s = setup(), controller = new AbortController(); const pending = s.planner.plan("topic", controller.signal);
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(s.request).toHaveBeenCalledWith("turn/start", expect.anything()));
    s.send("turn/started", { turn: { id: "plan-turn" } }); controller.abort(); await rejected;
    expect(s.request).toHaveBeenCalledWith("turn/interrupt", { threadId: "planner", turnId: "plan-turn" });
    expect(s.planner.notification("item/completed", { threadId: "planner", item: { type: "agentMessage", text: JSON.stringify(result) } })).toBe(false);
    expect(s.request.mock.calls.some(([, p]: any[]) => p?.threadId === "coding")).toBe(false);
  });
});
