import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
vi.mock("../src/rpc/bridge", () => ({ rpcCall: vi.fn(), onDaemonEvent: vi.fn(() => () => {}), onDaemonState: vi.fn(() => () => {}), setDockBadge: vi.fn() }));
import { rpcCall } from "../src/rpc/bridge";
import { AgentPermissionSelect } from "../src/components/AgentPermissionSelect";
import { interpretCompose } from "../src/state/commands.agents";
let renderer: ReactTestRenderer | undefined;
afterEach(() => { act(() => renderer?.unmount()); vi.resetAllMocks(); });
function render(provider = "codex", disabled = false) {
  act(() => { renderer = create(<AgentPermissionSelect agentId="selected-a" value="readOnly" executionMode="auto" provider={provider} disabled={disabled} />); });
  return renderer!.root.findByType("select");
}
describe("composer permission selector", () => {
  it("applies only the selected agent's mode without changing routing or spawning", async () => {
    vi.mocked(rpcCall).mockResolvedValueOnce({ applied: ["executionMode"] }).mockResolvedValueOnce([]);
    const select = render();
    await act(async () => select.props.onChange({ target: { value: "auto" } }));
    expect(rpcCall).toHaveBeenNthCalledWith(1, "agent.reconfigure", { agentId: "selected-a", live: { executionMode: "auto" } });
    expect(rpcCall).toHaveBeenCalledTimes(2);
  });
  it("an explicit unrestricted choice carries the Codex grant, never for other profiles/providers", async () => {
    vi.mocked(rpcCall).mockResolvedValueOnce({ applied: ["executionMode"] }).mockResolvedValueOnce([]);
    const select = render();
    expect(select.findAllByType("option").at(-1)?.children.join("")).toContain("Full access");
    await act(async () => select.props.onChange({ target: { value: "bypassPermissions" } }));
    expect(rpcCall).toHaveBeenNthCalledWith(1, "agent.reconfigure", { agentId: "selected-a", live: { executionMode: "bypassPermissions" }, patch: { acknowledgeCodexFullAccessRisk: true } });
  });
  it("rejects missing acknowledgement and restores the actual profile on an error", async () => {
    vi.mocked(rpcCall).mockResolvedValueOnce({ applied: [] });
    const select = render("claude");
    await act(async () => select.props.onChange({ target: { value: "bypassPermissions" } }));
    expect(select.props.value).toBe("auto");
    expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain("did not acknowledge");
    expect(rpcCall).toHaveBeenCalledTimes(1);
  });
  it("Claude native Full access changes only execution mode, not Chimera profile or routing", async () => {
    vi.mocked(rpcCall).mockResolvedValueOnce({ applied: ["executionMode"] }).mockResolvedValueOnce([]);
    const select = render("claude");
    expect(select.props["aria-label"]).toBe("Execution mode");
    expect(select.findAllByType("option").map(o => o.props.value)).toEqual(["auto", "plan", "bypassPermissions"]);
    await act(async () => select.props.onChange({ target: { value: "bypassPermissions" } }));
    expect(rpcCall).toHaveBeenNthCalledWith(1, "agent.reconfigure", { agentId: "selected-a", live: { executionMode: "bypassPermissions" } });
    expect(select.props.value).toBe("bypassPermissions");
  });
  it("Claude policy refusal leaves Auto selected and shows the actual error", async () => {
    vi.mocked(rpcCall).mockRejectedValueOnce(new Error("Managed policy disables bypass permissions"));
    const select = render("claude");
    await act(async () => select.props.onChange({ target: { value: "bypassPermissions" } }));
    expect(select.props.value).toBe("auto");
    expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain("Managed policy");
  });
  it("disables selection for disconnected/replay/shadow targets", () => { expect(render("codex", true).props.disabled).toBe(true); });
});
describe("explicit Bash input", () => {
  const opts = { hasPendingImages: false, isBuiltin: () => false };
  it.each(["! pwd", "!\nset -e\nprintf 'a\\nb'", "  ! echo x | cat  "])("recognizes %s without rewriting shell syntax", input => {
    expect(interpretCompose(input, opts)).toEqual({ kind: "shell", command: input.trim().slice(1).trim() });
  });
  it("keeps prose punctuation and embedded commands as messages", () => {
    for (const input of ["Great!", "Please run ! pwd", "!important"]) expect(interpretCompose(input, opts).kind).toBe("text");
  });
  it("keeps empty/attached bang input on the shell path so the UI can reject, never ask an LLM to execute it", () => {
    expect(interpretCompose("!", opts)).toEqual({ kind: "shell", command: "" });
    expect(interpretCompose("! pwd", { ...opts, hasPendingImages: true }).kind).toBe("shell");
  });
});

it.each(["kimi", "openai", "gemini", "custom-provider"])("%s uses the common mode contract", async provider => {
  vi.mocked(rpcCall).mockResolvedValueOnce({ applied: ["executionMode"] }).mockResolvedValueOnce([]);
  const select = render(provider);
  expect(select.props["aria-label"]).toBe("Execution mode");
  expect(select.findAllByType("option").some(o => o.props.value === "plan")).toBe(provider !== "kimi");
  await act(async () => select.props.onChange({ target: { value: "bypassPermissions" } }));
  expect(rpcCall).toHaveBeenNthCalledWith(1, "agent.reconfigure", { agentId: "selected-a", live: { executionMode: "bypassPermissions" } });
});
it("keeps only a spinner until native mode is observed", async () => {
  vi.mocked(rpcCall).mockResolvedValueOnce({ applied: ["executionMode"], executionModePending: true }).mockResolvedValueOnce([]);
  const select = render();
  await act(async () => select.props.onChange({ target: { value: "plan" } }));
  expect(renderer!.root.findByProps({ role: "status" }).props["aria-label"]).toBe("Applying execution mode");
  expect(renderer!.root.findByProps({ role: "status" }).children).toHaveLength(0);
  expect(select.props["aria-busy"]).toBe(true);
  act(() => renderer!.update(<AgentPermissionSelect agentId="selected-a" provider="codex" executionMode="plan" requestedMode="plan" modePending={false} disabled={false} />));
  expect(renderer!.root.findAllByProps({ role: "status" })).toHaveLength(0);
});

it("shows a spinner for an in-flight request and clears it on rejection", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(rpcCall).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const select = render();
  act(() => { select.props.onChange({ target: { value: "plan" } }); });
  expect(select.props["aria-busy"]).toBe(true);
  expect(renderer!.root.findByProps({ "data-agent-permission": true }).props["data-mode"]).toBe("plan");
  await act(async () => reject(new Error("Refused")));
  expect(select.props.value).toBe("auto");
  expect(select.props["aria-busy"]).toBe(false);
  expect(renderer!.root.findAllByProps({ role: "status" })).toHaveLength(0);
  expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain("Refused");
});
