import { describe, it, expect, vi } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { ResolvedAgentSpec, DialogDecider, DialogRequest, DialogDecision } from "@chimera/core/backend";

type Msg = Record<string, unknown>;
function fakeQuery(messages: Msg[] = []) {
  const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const fn = ((args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    return {
      async *[Symbol.asyncIterator]() { for (const m of messages) yield m; },
      interrupt: vi.fn(async () => {}),
    };
  }) as never;
  return { fn, calls };
}
function spec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/repo", isolation: "none", ...over }),
    agentId: "ag-1", accountName: "second", resolvedProvider: "claude",
    env: { ANTHROPIC_AUTH_TOKEN: "tok-x", CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("ClaudeAgentBackend: dialog wiring (DLG2)", () => {
  it("declares supportedDialogKinds", async () => {
    const { fn, calls } = fakeQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true);
    await settle();
    expect(calls[0]!.options.supportedDialogKinds).toEqual([
      "permission_ask_user_question", "elicitation_dialog", "elicitation_url_dialog",
    ]);
  });

  it("AGENT-AUTONOMY: autonomy:\"full\" omits supportedDialogKinds entirely (fails closed — no AskUserQuestion dialog is ever emitted)", async () => {
    const { fn, calls } = fakeQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ autonomy: "full" }), () => {}, async () => true);
    await settle();
    expect("supportedDialogKinds" in calls[0]!.options).toBe(false);
  });

  it("AGENT-AUTONOMY: default autonomy \"ask\" keeps supportedDialogKinds byte-identical to before this feature", async () => {
    const { fn, calls } = fakeQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true);
    await settle();
    expect(calls[0]!.options.supportedDialogKinds).toEqual([
      "permission_ask_user_question", "elicitation_dialog", "elicitation_url_dialog",
    ]);
  });

  it("onUserDialog round-trips the decider's decision verbatim, threading dialogId/dialogKind/payload/toolUseId", async () => {
    const { fn, calls } = fakeQuery();
    const decideDialog = vi.fn(async (): Promise<DialogDecision> => ({ behavior: "completed", result: { answers: { a: "x" } } }));
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true, decideDialog);
    await settle();
    const onUserDialog = calls[0]!.options.onUserDialog as (req: unknown) => Promise<unknown>;
    const request = { dialogKind: "permission_ask_user_question", payload: { questions: ["q1"] }, toolUseID: "tu1" };
    const result = await onUserDialog(request);
    expect(decideDialog).toHaveBeenCalledWith({
      dialogId: "tu1", dialogKind: "permission_ask_user_question", payload: { questions: ["q1"] }, toolUseId: "tu1",
    } satisfies DialogRequest);
    expect(result).toEqual({ behavior: "completed", result: { answers: { a: "x" } } });
  });

  it("routes AskUserQuestion through canUseTool → decideDialog → allow with answers pre-filled in updatedInput", async () => {
    const { fn, calls } = fakeQuery();
    const decideDialog = vi.fn(async (): Promise<DialogDecision> => ({ behavior: "completed", result: { answers: { Nehir: "Kızılırmak" } } }));
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true, decideDialog);
    await settle();
    const canUseTool = calls[0]!.options.canUseTool as (t: string, i: unknown, o?: { toolUseID?: string }) => Promise<unknown>;
    const input = { questions: [{ question: "Türkiye'nin en uzun nehri?", header: "Nehir", options: [{ label: "Kızılırmak" }] }] };
    const res = await canUseTool("AskUserQuestion", input, { toolUseID: "tuQ" });
    expect(decideDialog).toHaveBeenCalledWith({
      dialogId: "tuQ", dialogKind: "permission_ask_user_question", payload: input, toolUseId: "tuQ",
    } satisfies DialogRequest);
    expect(res).toEqual({ behavior: "allow", updatedInput: { ...input, answers: { Nehir: "Kızılırmak" } } });
  });

  // CAN_USE_TOOL_SHADOWED / toolPolicy-shadow FIX: under full/bypass, canUseTool is shadowed,
  // so AskUserQuestion must route through the PreToolUse hook instead. This asserts the hook
  // renders it as a dialog and threads the answer back via updatedInput (permissionDecision:allow),
  // identically to the non-bypass canUseTool path above.
  it("full/bypass: AskUserQuestion routes through the PreToolUse hook → allow with answers in updatedInput", async () => {
    const { fn, calls } = fakeQuery();
    const decideDialog = vi.fn(async (): Promise<DialogDecision> => ({ behavior: "completed", result: { answers: { Nehir: "Kızılırmak" } } }));
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ permissionProfile: "full" }), () => {}, async () => true, decideDialog);
    await settle();
    expect("canUseTool" in calls[0]!.options).toBe(false);              // shadowed → not passed
    expect(calls[0]!.options.allowDangerouslySkipPermissions).toBe(true);
    const hooks = calls[0]!.options.hooks as { PreToolUse: Array<{ hooks: Array<(i: unknown) => Promise<Record<string, unknown>>> }> };
    const gate = hooks.PreToolUse[0]!.hooks[0]!;
    const input = { questions: [{ question: "Türkiye'nin en uzun nehri?", header: "Nehir", options: [{ label: "Kızılırmak" }] }] };
    const res = await gate({ tool_name: "AskUserQuestion", tool_input: input, tool_use_id: "tuQ" });
    expect(decideDialog).toHaveBeenCalledWith({
      dialogId: "tuQ", dialogKind: "permission_ask_user_question", payload: input, toolUseId: "tuQ",
    } satisfies DialogRequest);
    expect(res.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...input, answers: { Nehir: "Kızılırmak" } },
    });
  });

  it("full/bypass: AskUserQuestion cancelled → hook denies (permissionDecision:deny), never hits normal decide", async () => {
    const { fn, calls } = fakeQuery();
    const decideDialog = vi.fn(async (): Promise<DialogDecision> => ({ behavior: "cancelled" }));
    const decide = vi.fn(async () => true);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ permissionProfile: "full" }), () => {}, decide, decideDialog);
    await settle();
    const hooks = calls[0]!.options.hooks as { PreToolUse: Array<{ hooks: Array<(i: unknown) => Promise<Record<string, unknown>>> }> };
    const gate = hooks.PreToolUse[0]!.hooks[0]!;
    const res = await gate({ tool_name: "AskUserQuestion", tool_input: { questions: [] }, tool_use_id: "tuC" });
    expect((res.hookSpecificOutput as { permissionDecision: string }).permissionDecision).toBe("deny");
    expect(decide).not.toHaveBeenCalled();
  });

  it("AskUserQuestion cancelled → deny, and never hits the normal permission decide", async () => {
    const { fn, calls } = fakeQuery();
    const decideDialog = vi.fn(async (): Promise<DialogDecision> => ({ behavior: "cancelled" }));
    const decide = vi.fn(async () => true);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, decide, decideDialog);
    await settle();
    const canUseTool = calls[0]!.options.canUseTool as (t: string, i: unknown, o?: { toolUseID?: string }) => Promise<unknown>;
    const res = await canUseTool("AskUserQuestion", { questions: [] }, { toolUseID: "tuC" });
    expect((res as { behavior: string }).behavior).toBe("deny");
    expect(decide).not.toHaveBeenCalled();
  });

  it("a NON-AskUserQuestion tool still uses the normal permission decide (unchanged)", async () => {
    const { fn, calls } = fakeQuery();
    const decideDialog = vi.fn(async (): Promise<DialogDecision> => ({ behavior: "cancelled" }));
    const decide = vi.fn(async () => true);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, decide, decideDialog);
    await settle();
    const canUseTool = calls[0]!.options.canUseTool as (t: string, i: unknown, o?: { toolUseID?: string }) => Promise<unknown>;
    const res = await canUseTool("Bash", { command: "ls" }, { toolUseID: "tuB" });
    expect(decideDialog).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalled();
    expect((res as { behavior: string }).behavior).toBe("allow");
  });

  it("onUserDialog round-trips a cancelled decision verbatim", async () => {
    const { fn, calls } = fakeQuery();
    const decideDialog = vi.fn(async (): Promise<DialogDecision> => ({ behavior: "cancelled" }));
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true, decideDialog);
    await settle();
    const onUserDialog = calls[0]!.options.onUserDialog as (req: unknown) => Promise<unknown>;
    const result = await onUserDialog({ dialogKind: "permission_ask_user_question", payload: {}, toolUseID: "tu2" });
    expect(result).toEqual({ behavior: "cancelled" });
  });

  it("onUserDialog falls back to a generated uuid dialogId when toolUseID is absent, and still routes through decideDialog", async () => {
    const { fn, calls } = fakeQuery();
    const decideDialog = vi.fn(async (): Promise<DialogDecision> => ({ behavior: "cancelled" }));
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true, decideDialog);
    await settle();
    const onUserDialog = calls[0]!.options.onUserDialog as (req: unknown) => Promise<unknown>;
    await onUserDialog({ dialogKind: "permission_ask_user_question", payload: {} });
    expect(decideDialog).toHaveBeenCalledTimes(1);
    const passed = decideDialog.mock.calls[0]![0] as DialogRequest;
    expect(passed.dialogId).toBeTruthy();
    expect(typeof passed.dialogId).toBe("string");
    expect(passed.toolUseId).toBeUndefined();
  });

  it("onUserDialog defaults dialogKind to 'unknown' and payload to {} when the SDK omits them", async () => {
    const { fn, calls } = fakeQuery();
    const decideDialog = vi.fn(async (): Promise<DialogDecision> => ({ behavior: "cancelled" }));
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true, decideDialog);
    await settle();
    const onUserDialog = calls[0]!.options.onUserDialog as (req: unknown) => Promise<unknown>;
    await onUserDialog({});
    const passed = decideDialog.mock.calls[0]![0] as DialogRequest;
    expect(passed.dialogKind).toBe("unknown");
    expect(passed.payload).toEqual({});
  });

  it("onElicitation with mode:'form' uses dialogKind 'elicitation_dialog' and maps a completed decision to accept+content", async () => {
    const { fn, calls } = fakeQuery();
    const decideDialog = vi.fn(async (): Promise<DialogDecision> => ({ behavior: "completed", result: { foo: "bar" } }));
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true, decideDialog);
    await settle();
    const onElicitation = calls[0]!.options.onElicitation as (req: unknown) => Promise<unknown>;
    const request = { mode: "form", message: "m", serverName: "s", elicitationId: "e1" };
    const result = await onElicitation(request);
    expect(decideDialog).toHaveBeenCalledWith({
      dialogId: "e1", dialogKind: "elicitation_dialog", payload: request, toolUseId: "e1",
    } satisfies DialogRequest);
    expect(result).toEqual({ action: "accept", content: { foo: "bar" } });
  });

  it("onElicitation with mode:'url' uses dialogKind 'elicitation_url_dialog'", async () => {
    const { fn, calls } = fakeQuery();
    const decideDialog = vi.fn(async (): Promise<DialogDecision> => ({ behavior: "completed", result: {} }));
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true, decideDialog);
    await settle();
    const onElicitation = calls[0]!.options.onElicitation as (req: unknown) => Promise<unknown>;
    await onElicitation({ mode: "url", url: "https://example.com", elicitationId: "e2" });
    const passed = decideDialog.mock.calls[0]![0] as DialogRequest;
    expect(passed.dialogKind).toBe("elicitation_url_dialog");
  });

  it("onElicitation maps a cancelled decision to {action:'cancel'} with no content key", async () => {
    const { fn, calls } = fakeQuery();
    const decideDialog = vi.fn(async (): Promise<DialogDecision> => ({ behavior: "cancelled" }));
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true, decideDialog);
    await settle();
    const onElicitation = calls[0]!.options.onElicitation as (req: unknown) => Promise<unknown>;
    const result = await onElicitation({ mode: "form", elicitationId: "e3" });
    expect(result).toEqual({ action: "cancel" });
  });

  it("onElicitation with a completed decision whose result is undefined maps content to {}", async () => {
    const { fn, calls } = fakeQuery();
    const decideDialog = vi.fn(async (): Promise<DialogDecision> => ({ behavior: "completed", result: undefined }));
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true, decideDialog);
    await settle();
    const onElicitation = calls[0]!.options.onElicitation as (req: unknown) => Promise<unknown>;
    const result = await onElicitation({ mode: "form", elicitationId: "e4" });
    expect(result).toEqual({ action: "accept", content: {} });
  });

  it("onElicitation falls back to a generated uuid dialogId when elicitationId is absent", async () => {
    const { fn, calls } = fakeQuery();
    const decideDialog = vi.fn(async (): Promise<DialogDecision> => ({ behavior: "cancelled" }));
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true, decideDialog);
    await settle();
    const onElicitation = calls[0]!.options.onElicitation as (req: unknown) => Promise<unknown>;
    await onElicitation({ mode: "form", message: "m" });
    const passed = decideDialog.mock.calls[0]![0] as DialogRequest;
    expect(passed.dialogId).toBeTruthy();
    expect(passed.toolUseId).toBeUndefined();
  });

  it("with decideDialog absent (3-arg spawn), onUserDialog resolves {behavior:'cancelled'} and onElicitation resolves {action:'cancel'} without throwing, while supportedDialogKinds is still present", async () => {
    const { fn, calls } = fakeQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true);   // no 4th arg
    await settle();
    const o = calls[0]!.options;
    expect(o.supportedDialogKinds).toEqual([
      "permission_ask_user_question", "elicitation_dialog", "elicitation_url_dialog",
    ]);
    const onUserDialog = o.onUserDialog as (req: unknown) => Promise<unknown>;
    const onElicitation = o.onElicitation as (req: unknown) => Promise<unknown>;
    await expect(onUserDialog({ dialogKind: "permission_ask_user_question", payload: {}, toolUseID: "tu9" }))
      .resolves.toEqual({ behavior: "cancelled" });
    await expect(onElicitation({ mode: "form", elicitationId: "e9" })).resolves.toEqual({ action: "cancel" });
  });

  it("regression: an existing claude-backend behavior (canUseTool allow/deny) is unaffected by the dialog wiring", async () => {
    const SCRIPT: Msg[] = [{ type: "system", subtype: "init", session_id: "s1", model: "m1" }];
    const { fn, calls } = fakeQuery(SCRIPT);
    const decide = vi.fn(async ({ toolName }: { toolName: string }) => toolName === "Edit");
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, decide as never, async () => ({ behavior: "cancelled" }));
    await settle();
    const canUseTool = calls[0]!.options.canUseTool as (t: string, i: unknown) => Promise<{ behavior: string }>;
    expect((await canUseTool("Edit", {})).behavior).toBe("allow");
    expect((await canUseTool("Bash", {})).behavior).toBe("deny");
  });

  it("providerOptions can still override the dialog callbacks (spread order preserved)", async () => {
    const { fn, calls } = fakeQuery();
    const customOnUserDialog = async () => ({ behavior: "cancelled" as const });
    new ClaudeAgentBackend({ queryFn: fn }).spawn(
      spec({ providerOptions: { onUserDialog: customOnUserDialog } }),
      () => {}, async () => true, async () => ({ behavior: "completed", result: {} }),
    );
    await settle();
    expect(calls[0]!.options.onUserDialog).toBe(customOnUserDialog);
  });
});
