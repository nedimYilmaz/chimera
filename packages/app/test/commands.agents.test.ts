import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { NormalizedEvent } from "@chimera/protocol";
import { emptyAgent, initialState, reduce, type Action, type AgentView, type UiState, type UiStore } from "@chimera/ui-state";
import {
  buildQuotedPrefix,
  canInterruptSelected,
  createAgentCommands,
  createLocalStore,
  cycleValue,
  deleteLineLeft,
  deleteWordLeft,
  filterSlashEntries,
  findBuiltin,
  findImageTags,
  imagePathMediaType,
  imageTagText,
  interpretCompose,
  lineEnd,
  lineStart,
  nextToolDetail,
  quoteFromAgent,
  quoteFromMessageKey,
  remainingSec,
  resolveEscTier,
  resolveTargetIds,
  slashQuery,
  splitComposeContent,
  tagEndingAt,
  tagStartingAt,
  targetLabel,
  useAgentStatus,
  visibleDialog,
  visiblePermission,
  visibleQuestion,
  wordLeft,
  wordRight,
  type EscSnapshot,
  type RpcFn,
} from "../src/state/commands.agents";

// A tiny store over the REAL reducer with a REAL subscribe (the outbox-flush
// watcher rides subscriptions), mirroring keymap.test.ts's makeStore.
function makeStore(seed?: Partial<UiState>): UiStore & { readonly state: UiState } {
  let state: UiState = { ...initialState, ...seed };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: (a: Action) => {
      const next = reduce(state, a);
      if (next === state) return;
      state = next;
      for (const fn of listeners) fn();
    },
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    connectAndLoad: () => Promise.resolve(),
    get state() { return state; },
  };
}

function makeRpc(): { rpc: RpcFn; calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let spawnSeq = 0;
  const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
    if (method === "agent.spawn") return { agentId: `main-${++spawnSeq}` } as T;
    // ONBOARDING-GATE R3: the default stub emulates an OLDER daemon that
    // doesn't know main.conductor.ensure yet, so every pre-existing test here
    // keeps exercising sendToMain's fallback (client-side adopt/spawn) path
    // unchanged. Tests for the NEW ensure-first path stub their own rpc.
    if (method === "main.conductor.ensure") {
      throw { code: "protocol", message: 'unknown method "main.conductor.ensure"' };
    }
    return {} as T;
  };
  return { rpc, calls };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("quick-spawn session defaults", () => {
  it.each(["ask", "bypass"] as const)("uses full autonomy, 500k compaction and 120 turns with %s permissions", async (permissionMode) => {
    const store = makeStore({ permissionMode });
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).spawnDefault();
    const spec = calls.find((c) => c.method === "agent.spawn")!.params.spec as Record<string, unknown>;
    expect(spec).toMatchObject({
      autonomy: "full", compactionThreshold: 500_000, maxTurns: 120,
      session: true, isolation: "none", resume: null, resumeOnly: true,
      orchestration: { allow: true },
      on: { permissionRequest: permissionMode === "bypass" ? "auto" : "tui" },
    });
    expect(spec.permissionProfile).toBe(permissionMode === "bypass" ? "full" : undefined);
    expect(spec.acknowledgeCodexFullAccessRisk).toBe(permissionMode === "bypass" ? true : undefined);
    expect(store.state.selectedAgentId).toBe("main-1");
    expect(store.state.activeTab).toBe("agents");
  });
});

describe("operator Codex full-access spawn consent", () => {
  it.each([
    ["bypass", undefined, undefined, true],
    ["ask", "full", undefined, true],
    ["bypass", "readOnly", true, undefined],
    ["bypass", "acceptEdits", undefined, undefined],
    ["ask", undefined, undefined, undefined],
    ["ask", undefined, true, true],
  ] as const)("%s / %s / explicit acknowledgement %s", async (permissionMode, permissionProfile, acknowledgeCodexFullAccessRisk, expected) => {
    const store = makeStore({ permissionMode }); const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).spawnAgent({ prompt: "work", cwd: "/tmp", provider: "codex", account: "codex-main", autonomy: "full", permissionProfile, acknowledgeCodexFullAccessRisk });
    const spec = calls.find(c => c.method === "agent.spawn")!.params.spec as Record<string, unknown>;
    expect(spec.acknowledgeCodexFullAccessRisk).toBe(expected);
    expect(spec.permissionProfile).toBe(permissionProfile ?? (permissionMode === "bypass" ? "full" : undefined));
    expect(spec).toMatchObject({ provider: "codex", account: "codex-main", autonomy: "full" });
  });
});

const running = (id: string, extra: Partial<AgentView> = {}): AgentView =>
  ({ ...emptyAgent(id), state: "running", ...extra });

const ev = (seq: number, agentId: string, kind: string, data: Record<string, unknown> = {}): NormalizedEvent =>
  ({ seq, ts: 1000 + seq, agentId, kind, data } as unknown as NormalizedEvent);

// ---------------------------------------------------------------------------
// interpretCompose (A1-2)
// ---------------------------------------------------------------------------
describe("interpretCompose", () => {
  const opts = { hasPendingImages: false, isBuiltin: (n: string) => findBuiltin(n) !== undefined };
  it("routes a leading-slash builtin locally and other slashes to the agent", () => {
    expect(interpretCompose("/Users/me/notes.txt", opts)).toEqual({ kind: "text", text: "/Users/me/notes.txt" });
    expect(interpretCompose("/kill", opts)).toEqual({ kind: "builtin", name: "kill", args: "" });
    expect(interpretCompose("/compact now please", opts)).toEqual({ kind: "slash", name: "compact", args: "now please" });
  });
  it("treats an image-extension path as an attachment — the path NEVER reaches the model (caption=basename)", () => {
    const intent = interpretCompose("/Users/me/shots/pic.png", opts);
    expect(intent).toEqual({ kind: "imagePath", path: "/Users/me/shots/pic.png", caption: "pic.png", mediaType: "image/png" });
  });
  it("keeps a '/…' WITH pending images on the text path (a slash command carries no attachment)", () => {
    expect(interpretCompose("/status", { ...opts, hasPendingImages: true })).toEqual({ kind: "text", text: "/status" });
  });
  it("no-ops an empty submit; an image-only send gets the '(image)' caption", () => {
    expect(interpretCompose("   ", opts)).toEqual({ kind: "noop" });
    expect(interpretCompose("", { ...opts, hasPendingImages: true })).toEqual({ kind: "text", text: "(image)" });
  });
  it("plain text passes through trimmed", () => {
    expect(interpretCompose("  hello world ", opts)).toEqual({ kind: "text", text: "hello world" });
  });
  it("imagePathMediaType matches the TUI extension table", () => {
    expect(imagePathMediaType("x.PNG")).toBe("image/png");
    expect(imagePathMediaType("x.jpeg")).toBe("image/jpeg");
    expect(imagePathMediaType("x.txt")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F13 — inline image tags: atomic [▣ #N name] tokens in the compose buffer
// ---------------------------------------------------------------------------
describe("findImageTags / tagEndingAt / tagStartingAt", () => {
  it("finds every tag's span, num and name in document order", () => {
    const text = `compare ${imageTagText(1, "shot-a.png")} and ${imageTagText(2, "shot-b.png")} — which?`;
    const spans = findImageTags(text);
    expect(spans.map((s) => ({ num: s.num, name: s.name }))).toEqual([
      { num: 1, name: "shot-a.png" },
      { num: 2, name: "shot-b.png" },
    ]);
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe(imageTagText(1, "shot-a.png"));
  });
  it("numbers stay stable — a gap (e.g. #1 deleted) is never renumbered", () => {
    const text = `${imageTagText(2, "b.png")} then ${imageTagText(3, "c.png")}`;
    expect(findImageTags(text).map((s) => s.num)).toEqual([2, 3]);
  });
  it("tagEndingAt matches the caret just after ']' (Backspace/⌥←) and mid-tag (mouse click)", () => {
    const tag = imageTagText(1, "a.png");
    const spans = findImageTags(tag);
    expect(tagEndingAt(spans, tag.length)?.num).toBe(1);   // right after ]
    expect(tagEndingAt(spans, 2)?.num).toBe(1);             // mid-tag
    expect(tagEndingAt(spans, 0)).toBeUndefined();           // right before [ — not "ending" here
  });
  it("tagStartingAt matches the caret just before '[' (Delete/→) and mid-tag", () => {
    const tag = imageTagText(1, "a.png");
    const spans = findImageTags(tag);
    expect(tagStartingAt(spans, 0)?.num).toBe(1);            // right before [
    expect(tagStartingAt(spans, 2)?.num).toBe(1);            // mid-tag
    expect(tagStartingAt(spans, tag.length)).toBeUndefined(); // right after ] — not "starting" here
  });
});

describe("splitComposeContent", () => {
  it("splits text-tag-text-tag-text into ordered content[] blocks at exact tag positions", () => {
    const pending = [
      { mediaType: "image/png" as const, data: "AAA", num: 1, name: "shot-a.png" },
      { mediaType: "image/png" as const, data: "BBB", num: 2, name: "shot-b.png" },
    ];
    const text = `compare ${imageTagText(1, "shot-a.png")} and ${imageTagText(2, "shot-b.png")} — which?`;
    const { content, flatText } = splitComposeContent(text, pending);
    expect(content).toEqual([
      { type: "text", text: "compare " },
      { type: "image", mediaType: "image/png", data: "AAA" },
      { type: "text", text: " and " },
      { type: "image", mediaType: "image/png", data: "BBB" },
      { type: "text", text: " — which?" },
    ]);
    expect(flatText).toBe("compare shot-a.png and shot-b.png — which?");
  });
  it("an image-only send (no surrounding text) falls back to the '(image)' caption", () => {
    const pending = [{ mediaType: "image/png" as const, data: "AAA", num: 1, name: "a.png" }];
    const { content, flatText } = splitComposeContent(imageTagText(1, "a.png"), pending);
    expect(content).toEqual([{ type: "image", mediaType: "image/png", data: "AAA" }]);
    expect(flatText).toBe("(image)");
  });
  it("a tag whose attachment was already deleted contributes no image block (name text is gone with it)", () => {
    const text = `see ${imageTagText(1, "gone.png")} now`;
    const { content, flatText } = splitComposeContent(text, []); // pendingImages already dropped #1
    expect(content).toEqual([{ type: "text", text: "see " }, { type: "text", text: " now" }]);
    expect(flatText).toBe("see  now");
  });
});

// ---------------------------------------------------------------------------
// slash popup derivations (A7-1)
// ---------------------------------------------------------------------------
describe("slashQuery / filterSlashEntries", () => {
  it("mirrors the TUI: leading '/', single line, no space yet", () => {
    expect(slashQuery("/ki")).toBe("ki");
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/kill x")).toBeNull();
    expect(slashQuery("hi")).toBeNull();
    expect(slashQuery("/a\nb")).toBeNull();
  });
  it("prefix-filters case-insensitively", () => {
    const entries = [
      { name: "kill", source: "builtin" as const },
      { name: "killall", source: "agent" as const },
      { name: "close", source: "builtin" as const },
    ];
    expect(filterSlashEntries(entries, "KIL").map((e) => e.name)).toEqual(["kill", "killall"]);
    expect(filterSlashEntries(entries, "").length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// readline chords (B5)
// ---------------------------------------------------------------------------
describe("readline editing", () => {
  it("⌥⌫ deletes the word left and lands the cursor at its start", () => {
    expect(deleteWordLeft("foo bar", 7)).toEqual({ text: "foo ", pos: 4 });
    expect(deleteWordLeft("foo bar  ", 9)).toEqual({ text: "foo ", pos: 4 });
  });
  it("⌘⌫ deletes to line start (multi-line aware)", () => {
    expect(deleteLineLeft("ab\ncdef", 6)).toEqual({ text: "ab\nf", pos: 3 });
  });
  it("⌥←/⌥→ hop words; ⌘←/⌘→ hop line bounds", () => {
    expect(wordLeft("foo  bar", 8)).toBe(5);
    expect(wordRight("foo  bar", 0)).toBe(3);
    expect(lineStart("ab\ncdef", 5)).toBe(3);
    expect(lineEnd("ab\ncdef", 0)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// esc close-priority chain (build item 10)
// ---------------------------------------------------------------------------
describe("resolveEscTier", () => {
  const base: EscSnapshot = {
    paletteOpen: false, mcpPaletteOpen: false, accountsOpen: false, resultOpen: false,
    modelOpen: false, pluginsOpen: false, hostToolsOpen: false,
    helpOpen: false, toolDetailOpen: false, agentDetailOpen: false, slashOpen: false, targetMenuOpen: false,
    spawnOpen: false, dialogVisible: false, questionVisible: false, permissionVisible: false,
    composeNonEmpty: false, queuedCount: 0, canInterrupt: false,
  };
  it("tier 0: system overlays claim esc before every inline tier (MAJOR 1)", () => {
    expect(resolveEscTier({ ...base, paletteOpen: true, mcpPaletteOpen: true })).toBe("palette");
    expect(resolveEscTier({ ...base, mcpPaletteOpen: true, accountsOpen: true })).toBe("mcpPalette");
    expect(resolveEscTier({ ...base, accountsOpen: true, resultOpen: true })).toBe("accounts");
    expect(resolveEscTier({ ...base, resultOpen: true, modelOpen: true })).toBe("result");
    expect(resolveEscTier({ ...base, modelOpen: true, pluginsOpen: true })).toBe("model");
    expect(resolveEscTier({ ...base, pluginsOpen: true, hostToolsOpen: true })).toBe("plugins");
    expect(resolveEscTier({ ...base, hostToolsOpen: true, helpOpen: true })).toBe("hostTools");
  });
  it("tier 0 beats the destructive interrupt on a busy agent (the MAJOR 1 regression)", () => {
    for (const overlay of ["paletteOpen", "mcpPaletteOpen", "accountsOpen", "resultOpen", "modelOpen", "pluginsOpen", "hostToolsOpen"] as const) {
      expect(resolveEscTier({ ...base, [overlay]: true, canInterrupt: true })).not.toBe("interrupt");
      expect(resolveEscTier({ ...base, [overlay]: true, composeNonEmpty: true })).not.toBe("clearCompose");
    }
  });
  it("walks the documented order, highest first", () => {
    expect(resolveEscTier({ ...base, helpOpen: true, toolDetailOpen: true })).toBe("help");
    expect(resolveEscTier({ ...base, toolDetailOpen: true, agentDetailOpen: true })).toBe("toolDetail");
    expect(resolveEscTier({ ...base, agentDetailOpen: true, slashOpen: true })).toBe("agentDetail");
    expect(resolveEscTier({ ...base, slashOpen: true, spawnOpen: true })).toBe("slash");
    expect(resolveEscTier({ ...base, targetMenuOpen: true, questionVisible: true })).toBe("targetMenu");
    expect(resolveEscTier({ ...base, spawnOpen: true, dialogVisible: true })).toBe("spawn");
    expect(resolveEscTier({ ...base, dialogVisible: true, questionVisible: true })).toBe("dialog");
    expect(resolveEscTier({ ...base, questionVisible: true, permissionVisible: true })).toBe("question");
    expect(resolveEscTier({ ...base, permissionVisible: true, composeNonEmpty: true })).toBe("permission");
    expect(resolveEscTier({ ...base, composeNonEmpty: true, queuedCount: 2 })).toBe("clearCompose");
    expect(resolveEscTier({ ...base, queuedCount: 2, canInterrupt: true })).toBe("dropQueued");
    expect(resolveEscTier({ ...base, canInterrupt: true })).toBe("interrupt");
    expect(resolveEscTier(base)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// countdown (A4-3)
// ---------------------------------------------------------------------------
describe("remainingSec", () => {
  it("counts down and clamps at zero", () => {
    expect(remainingSec(10_000, 0)).toBe(10);
    expect(remainingSec(10_000, 9_100)).toBe(1);
    expect(remainingSec(10_000, 10_000)).toBe(0);
    expect(remainingSec(10_000, 99_999)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// target resolution (TUI-003 / B5 row 2)
// ---------------------------------------------------------------------------
describe("resolveTargetIds / targetLabel", () => {
  const state: UiState = {
    ...initialState,
    mainConductorId: "main-1",
    selectedAgentId: "w1",
    agents: {
      "main-1": running("main-1", { conductor: true }),
      w1: running("w1", { membership: { team: "crew", role: "dev" } }),
      w2: running("w2", { membership: { team: "crew", role: "dev" } }),
      done1: { ...emptyAgent("done1"), state: "done" },
    },
    agentOrder: ["main-1", "w1", "w2", "done1"],
  };
  it("main → the conductor; empty main → lazy spawn", () => {
    expect(resolveTargetIds(state, "main")).toEqual({ ids: ["main-1"], lazyMain: false });
    expect(resolveTargetIds({ ...state, mainConductorId: null }, "main")).toEqual({ ids: [], lazyMain: true });
  });
  it("selected → the real selection; falls back to main when selection IS main/missing", () => {
    expect(resolveTargetIds(state, "selected").ids).toEqual(["w1"]);
    expect(resolveTargetIds({ ...state, selectedAgentId: "main-1" }, "selected").ids).toEqual(["main-1"]);
    expect(resolveTargetIds({ ...state, selectedAgentId: "ghost" }, "selected").ids).toEqual(["main-1"]);
  });
  it("team/all fan out over RUNNING agents only", () => {
    expect(resolveTargetIds(state, { team: "crew" }).ids).toEqual(["w1", "w2"]);
    expect(resolveTargetIds(state, "all").ids).toEqual(["main-1", "w1", "w2"]);
  });
  it("labels: the chip live-follows the selected agent's name", () => {
    expect(targetLabel("main", null)).toBe("main");
    expect(targetLabel("selected", "eager-weasel")).toBe("eager-weasel");
    expect(targetLabel({ team: "crew" }, null)).toBe("team:crew");
    expect(targetLabel("all", null)).toBe("all");
  });
});

describe("composer target default", () => {
  it("starts and resets in selected mode so the composer follows agent-list selection", () => {
    const local = createLocalStore();
    expect(local.getState().target).toBe("selected");
    local.set({ target: "main" });
    local.reset();
    expect(local.getState().target).toBe("selected");
  });

  it("keeps an explicit main target pinned to the conductor while a worker is selected", () => {
    const state: UiState = {
      ...initialState,
      mainConductorId: "main-1",
      selectedAgentId: "worker-1",
      agents: {
        "main-1": running("main-1", { conductor: true }),
        "worker-1": running("worker-1"),
      },
      agentOrder: ["main-1", "worker-1"],
    };
    expect(resolveTargetIds(state, "selected")).toEqual({ ids: ["worker-1"], lazyMain: false });
    expect(resolveTargetIds(state, "main")).toEqual({ ids: ["main-1"], lazyMain: false });
  });

  it("selected mode falls back to main for no real selection and preserves lazy-main boot", () => {
    const main = running("main-1", { conductor: true });
    const state: UiState = {
      ...initialState,
      mainConductorId: "main-1",
      selectedAgentId: null,
      agents: { "main-1": main },
      agentOrder: ["main-1"],
    };
    expect(resolveTargetIds(state, "selected")).toEqual({ ids: ["main-1"], lazyMain: false });
    expect(resolveTargetIds({ ...state, mainConductorId: null, agents: {}, agentOrder: [] }, "selected"))
      .toEqual({ ids: [], lazyMain: true });
  });
});

// ---------------------------------------------------------------------------
// visible decision cards + interrupt predicate
// ---------------------------------------------------------------------------
describe("visibleDialog / canInterruptSelected (DLG3)", () => {
  it("aggregates GLOBALLY across agents like visibleQuestion, with no dismissal filter (esc cancels instead of hiding)", () => {
    const d = { dialogId: "d1", dialogKind: "permission_ask_user_question", payload: {} };
    const state: UiState = {
      ...initialState,
      agents: { a: running("a"), b: running("b", { pendingDialog: d }) },
      agentOrder: ["a", "b"],
    };
    expect(visibleDialog(state)).toEqual({ ...d, agentId: "b" });
    expect(visibleDialog({ ...initialState, agents: { a: running("a") }, agentOrder: ["a"] })).toBeNull();
  });
  it("a pending dialog blocks canInterruptSelected just like a pending question/permission", () => {
    const local = createLocalStore().getState();
    const d = { dialogId: "d1", dialogKind: "permission_ask_user_question", payload: {} };
    const state: UiState = {
      ...initialState,
      selectedAgentId: "a",
      agents: { a: running("a", { busy: true, pendingDialog: d }) },
      agentOrder: ["a"],
    };
    expect(canInterruptSelected(state, local, 0)).toBe(false);
    expect(canInterruptSelected({ ...state, agents: { a: running("a", { busy: true }) } }, local, 0)).toBe(true);
  });
});

describe("answerDialog", () => {
  it("posts {dialogId, decision} via agent.answerDialog and clears the owning agent's pendingDialog", async () => {
    const d = { dialogId: "d1", dialogKind: "permission_ask_user_question", payload: {} };
    const store = makeStore({ agents: { a: running("a", { pendingDialog: d }) }, agentOrder: ["a"] });
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await commands.answerDialog("d1", { behavior: "completed", result: { answers: { "q?": "yes" } } });
    expect(calls).toEqual([
      { method: "agent.answerDialog", params: { dialogId: "d1", decision: { behavior: "completed", result: { answers: { "q?": "yes" } } } } },
    ]);
    expect(store.state.agents["a"]?.pendingDialog).toBeNull();
  });
  it("cancel posts {behavior:'cancelled'} with no result (esc — not 'later')", async () => {
    const d = { dialogId: "d1", dialogKind: "elicitation_dialog", payload: { message: "confirm?" } };
    const store = makeStore({ agents: { a: running("a", { pendingDialog: d }) }, agentOrder: ["a"] });
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await commands.answerDialog("d1", { behavior: "cancelled" });
    expect(calls[0]!.params["decision"]).toEqual({ behavior: "cancelled" });
    expect(store.state.agents["a"]?.pendingDialog).toBeNull();
  });
});

describe("answerPermissionPersist (ALWAYS-ALLOW-UI)", () => {
  const seed = (): UiState => ({
    ...initialState,
    pendingPermissions: [{ requestId: "rP", agentId: "a", toolName: "mcp__ekb__search", input: {}, ts: 1 }],
  });

  it("persists host.setPolicy BEFORE responding (tool scope, '*' row), then clears", async () => {
    const store = makeStore(seed());
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await commands.answerPermissionPersist("tool", true, "rP");
    // Order is the whole contract: a racing identical call must not slip through
    // between the respond and the rule landing.
    expect(calls).toEqual([
      { method: "host.setPolicy", params: { tool: "mcp__ekb__search", profile: "*", mode: "allow" } },
      { method: "agent.permissionRespond", params: { requestId: "rP", allow: true } },
    ]);
    expect(store.state.pendingPermissions).toEqual([]);
  });

  it("server scope writes the SERVER key, not the exact tool", async () => {
    const store = makeStore(seed());
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await commands.answerPermissionPersist("server", true, "rP");
    expect(calls[0]).toEqual({ method: "host.setPolicy", params: { tool: "mcp__ekb", profile: "*", mode: "allow" } });
  });

  it("targets the passed requestId, not just pendingPermissions[0]", async () => {
    const store = makeStore({
      ...initialState,
      pendingPermissions: [
        { requestId: "r0", agentId: "a", toolName: "mcp__ekb__a", input: {}, ts: 1 },
        { requestId: "rP", agentId: "a", toolName: "mcp__ekb__search", input: {}, ts: 2 },
      ],
    });
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await commands.answerPermissionPersist("tool", true, "rP");
    expect(calls[0]!.params["tool"]).toBe("mcp__ekb__search");
    expect(calls[1]).toEqual({ method: "agent.permissionRespond", params: { requestId: "rP", allow: true } });
  });
});

describe("visiblePermission / visibleQuestion / canInterruptSelected", () => {
  it("esc-'later' dismissal hides the CARD but leaves the pending state (badges untouched)", () => {
    const state: UiState = {
      ...initialState,
      pendingPermissions: [
        { requestId: "r1", agentId: "a", toolName: "Bash", input: "x", ts: 1 },
        { requestId: "r2", agentId: "a", toolName: "Write", input: "y", ts: 2 },
      ],
    };
    expect(visiblePermission(state, { dismissedPermissions: new Set() })?.requestId).toBe("r1");
    expect(visiblePermission(state, { dismissedPermissions: new Set(["r1"]) })?.requestId).toBe("r2");
    expect(state.pendingPermissions.length).toBe(2); // untouched
  });
  it("questions aggregate GLOBALLY across agents (TUI-004) with dismissal-filtering", () => {
    const q = { questionId: "q1", prompt: "?", multiSelect: false, freeform: false };
    const state: UiState = {
      ...initialState,
      agents: { a: running("a"), b: running("b", { pendingQuestion: q }) },
      agentOrder: ["a", "b"],
      selectedAgentId: "a",
    };
    expect(visibleQuestion(state, { dismissedQuestions: new Set() })?.agentId).toBe("b");
    expect(visibleQuestion(state, { dismissedQuestions: new Set(["q1"]) })).toBeNull();
  });
  it("ASK-UNREACHABLE-TARGET-LEAK: a `to`-targeted (inter-agent) question never surfaces as a human card", () => {
    const interAgent = { questionId: "q1", prompt: "?", multiSelect: false, freeform: false, to: "c" };
    const forHuman = { questionId: "q2", prompt: "??", multiSelect: false, freeform: false };
    const state: UiState = {
      ...initialState,
      agents: { a: running("a", { pendingQuestion: interAgent }), b: running("b", { pendingQuestion: forHuman }) },
      agentOrder: ["a", "b"],
    };
    // the inter-agent one on "a" is skipped; the ask_human one on "b" still surfaces
    expect(visibleQuestion(state, { dismissedQuestions: new Set() })?.agentId).toBe("b");
    // with no ask_human question pending at all, nothing surfaces even though "a" is waiting
    expect(visibleQuestion({ ...state, agents: { a: running("a", { pendingQuestion: interAgent }) }, agentOrder: ["a"] }, { dismissedQuestions: new Set() })).toBeNull();
  });
  it("canInterruptSelected is false whenever ANY higher esc tier would claim the key", () => {
    const local = createLocalStore().getState();
    const state: UiState = {
      ...initialState,
      selectedAgentId: "a",
      agents: { a: running("a", { busy: true }) },
      agentOrder: ["a"],
    };
    expect(canInterruptSelected(state, local, 0)).toBe(true);
    expect(canInterruptSelected(state, { ...local, composeText: "x" }, 0)).toBe(false);
    expect(canInterruptSelected(state, local, 1)).toBe(false);
    expect(canInterruptSelected({ ...state, agents: { a: running("a", { busy: false }) } }, local, 0)).toBe(false);
    // AGENT-INFO-PANEL: an open header inspector claims esc before the
    // destructive interrupt tier, same as toolDetail.
    expect(canInterruptSelected(state, { ...local, agentDetail: { agentId: "a" } }, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lazy main spawn + TOCTOU guard (A2 / TUI-009)
// ---------------------------------------------------------------------------
describe("surface label — the app tags agent.send with from:'app', never 'tui'", () => {
  // The daemon's deliverBatch prepends "[from <from>] " to every delivered turn,
  // so a hardcoded "tui" made agents believe the human was in the terminal (and
  // e.g. warn that excalidraw diagrams show only a placeholder — false in the app,
  // which renders them inline). Every app-side USER-message send must say "app".
  it("sendToAgent direct-send passes from:'app'", async () => {
    const store = makeStore({ agents: { a: running("a") }, agentOrder: ["a"] });
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await commands.sendToAgent("a", "hello");
    const send = calls.find((c) => c.method === "agent.send");
    expect(send).toBeDefined();
    expect(send!.params["from"]).toBe("app");
    expect(send!.params["from"]).not.toBe("tui");
  });

  it("sendToMain mid-session passes from:'app'", async () => {
    const store = makeStore({
      mainConductorId: null,
      agents: { resumed: running("resumed", { conductor: true, busy: false }) },
      agentOrder: ["resumed"],
    });
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await commands.sendToMain("hi");
    const send = calls.find((c) => c.method === "agent.send");
    expect(send).toBeDefined();
    expect(send!.params["from"]).toBe("app");
  });
});

describe("sendToMain lazy spawn", () => {
  it("spawns the conductor ONCE for two rapid submits; the second goes mid-session", async () => {
    (globalThis as Record<string, unknown>)["__CHIMERA_CWD__"] = "/tmp/w4-test";
    const store = makeStore();
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await Promise.all([commands.sendToMain("first"), commands.sendToMain("second")]);
    const spawns = calls.filter((c) => c.method === "agent.spawn");
    expect(spawns.length).toBe(1);
    const spec = spawns[0]!.params["spec"] as Record<string, unknown>;
    expect(spec["conductor"]).toBe(true);
    expect(spec["isolation"]).toBe("none");                       // CRITICAL (coverage A2)
    expect(spec["orchestration"]).toEqual({ allow: true });
    expect(spec["cwd"]).toBe("/tmp/w4-test");
    // default mode is bypass → auto + full rides the spec (A3-5)
    expect(spec["on"]).toEqual({ permissionRequest: "auto" });
    expect(spec["permissionProfile"]).toBe("full");
    expect(calls.filter((c) => c.method === "agent.send").length).toBe(1); // "second", mid-session
    expect(store.getState().mainConductorId).toBe("main-1");
    // the local echoes landed as "you" turns with busy:true
    expect(store.getState().agents["main-1"]!.transcript.filter((t) => t.role === "user").length).toBe(2);
    expect(commands.echoTimestamps("main-1").length).toBe(2);      // Date.now() stamps recorded
  });

  it("adopts a busy re-attached conductor into the outbox instead of bypassing the busy hold", async () => {
    // A conductor surfaced by restart-resume (conductor:true, running, busy)
    // before this session set mainConductorId: the adopt branch must queue it,
    // not send mid-session past the hold-while-busy guarantee.
    const store = makeStore({
      mainConductorId: null,
      agents: { resumed: running("resumed", { conductor: true, busy: true }) },
      agentOrder: ["resumed"],
    });
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await commands.sendToMain("after-resume");
    expect(store.getState().mainConductorId).toBe("resumed");     // adopted
    expect(calls.filter((c) => c.method === "agent.send").length).toBe(0); // NOT sent
    expect(calls.filter((c) => c.method === "agent.spawn").length).toBe(0); // NOT double-spawned
    expect(store.getState().outbox.map((i) => i.text)).toEqual(["after-resume"]); // queued
  });

  it("adopts an idle re-attached conductor and sends mid-session", async () => {
    const store = makeStore({
      mainConductorId: null,
      agents: { resumed: running("resumed", { conductor: true, busy: false }) },
      agentOrder: ["resumed"],
    });
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await commands.sendToMain("after-resume");
    expect(store.getState().mainConductorId).toBe("resumed");
    expect(calls.filter((c) => c.method === "agent.send").length).toBe(1); // mid-session
    expect(calls.filter((c) => c.method === "agent.spawn").length).toBe(0);
  });

  it("ask mode spawns with on.permissionRequest tui + acceptEdits", async () => {
    (globalThis as Record<string, unknown>)["__CHIMERA_CWD__"] = "/tmp/w4-test";
    const store = makeStore({ permissionMode: "ask" });
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await commands.sendToMain("hi");
    const spec = calls.find((c) => c.method === "agent.spawn")!.params["spec"] as Record<string, unknown>;
    expect(spec["on"]).toEqual({ permissionRequest: "tui" });
    expect(spec["permissionProfile"]).toBe("acceptEdits");
  });

  // -------------------------------------------------------------------------
  // ONBOARDING-GATE R3: adopt the daemon's persistent main conductor via
  // main.conductor.ensure instead of a client-side lazy spawn.
  // -------------------------------------------------------------------------
  it("adopts the daemon's persistent main conductor via main.conductor.ensure — no client spawn", async () => {
    const store = makeStore();
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      if (method === "main.conductor.ensure") return { agentId: "persistent-1", state: "running" } as T;
      return {} as T;
    };
    const commands = createAgentCommands(store, rpc);
    await commands.sendToMain("hello main");
    expect(store.getState().mainConductorId).toBe("persistent-1");
    expect(calls.filter((c) => c.method === "agent.spawn").length).toBe(0); // never a second spawn
    const sends = calls.filter((c) => c.method === "agent.send");
    expect(sends.length).toBe(1);
    expect(sends[0]!.params["agentId"]).toBe("persistent-1");
    expect(sends[0]!.params["text"]).toBe("hello main");
  });

  it("falls back to the client-side lazy spawn only when main.conductor.ensure is UNKNOWN (older daemon)", async () => {
    (globalThis as Record<string, unknown>)["__CHIMERA_CWD__"] = "/tmp/w4-test";
    const store = makeStore();
    const { rpc, calls } = makeRpc(); // default stub throws unknown-method for ensure
    const commands = createAgentCommands(store, rpc);
    await commands.sendToMain("hi");
    expect(calls.some((c) => c.method === "main.conductor.ensure")).toBe(true); // it DID try first
    expect(calls.filter((c) => c.method === "agent.spawn").length).toBe(1);     // then fell back
    expect(store.getState().mainConductorId).toBe("main-1");
  });

  it("a genuine (non-unknown-method) main.conductor.ensure error propagates instead of silently falling back", async () => {
    const store = makeStore();
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      if (method === "main.conductor.ensure") throw { code: "protocol", message: "no accounts configured" };
      return {} as T;
    };
    const commands = createAgentCommands(store, rpc);
    await commands.sendToMain("hi"); // guarded() swallows it into commandError, never throws out
    expect(store.getState().lastError).toContain("no accounts configured");
    expect(calls.filter((c) => c.method === "agent.spawn").length).toBe(0); // no fallback for a real error
  });
});

// ---------------------------------------------------------------------------
// outbox: hold-while-busy + FIFO auto-flush (A1-4 / A1-a)
// ---------------------------------------------------------------------------
describe("outbox flush watcher", () => {
  it("a second rapid send arriving before the first's ack resolves queues instead of racing it directly", async () => {
    // Regression for the P1 bug: sendToAgent's direct-send branch used to
    // await the RPC ack BEFORE echoing (which is what flips busy=true). A
    // second send fired before that ack settled still read busy=false and
    // ALSO took the direct-send branch — two concurrent agent.send calls
    // racing the daemon, with one message effectively lost. The fix echoes
    // (and thus flips busy) synchronously BEFORE the await, so the second
    // send now observes busy=true and queues.
    const store = makeStore({ agents: { m: running("m", { busy: false }) }, agentOrder: ["m"] });
    let releaseAck: () => void = () => {};
    const ackGate = new Promise<void>((r) => { releaseAck = r; });
    const sends: string[] = [];
    const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
      if (method === "agent.send") {
        sends.push((params as { text: string }).text);
        await ackGate;
        return {} as T;
      }
      return {} as T;
    };
    const commands = createAgentCommands(store, rpc);

    const p1 = commands.sendToAgent("m", "one");
    const p2 = commands.sendToAgent("m", "two"); // fired before "one"'s ack resolves

    // "one" went out directly; "two" queued instead of also racing the daemon.
    expect(sends).toEqual(["one"]);
    expect(store.getState().outbox.map((o) => o.text)).toEqual(["two"]);
    expect(store.getState().agents["m"]!.busy).toBe(true);

    releaseAck();
    await Promise.all([p1, p2]);
    await flush();

    // turn ends → the watcher flushes "two"; nothing was ever dropped.
    store.dispatch({ type: "event", event: ev(1, "m", "turn_complete") });
    await flush();
    expect(sends).toEqual(["one", "two"]);
    expect(store.getState().outbox.length).toBe(0);
  });

  it("holds messages for a busy target and flushes FIFO, one per busy→idle", async () => {
    const store = makeStore({
      mainConductorId: "m",
      selectedAgentId: "m",
      agents: { m: running("m", { conductor: true, busy: true }) },
      agentOrder: ["m"],
    });
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);

    await commands.sendToMain("one");
    await commands.sendToMain("two");
    expect(store.getState().outbox.map((o) => o.text)).toEqual(["one", "two"]); // both queued, nothing sent
    expect(calls.filter((c) => c.method === "agent.send").length).toBe(0);

    // turn ends → busy false → the watcher flushes exactly the HEAD item
    store.dispatch({ type: "event", event: ev(1, "m", "turn_complete") });
    await flush();
    expect(calls.filter((c) => c.method === "agent.send").map((c) => c.params["text"])).toEqual(["one"]);
    // the flush's own echo re-busied the target; item two still held
    expect(store.getState().outbox.map((o) => o.text)).toEqual(["two"]);
    expect(store.getState().agents["m"]!.busy).toBe(true);

    // next idle → item two flushes; bar empties (A1-a FIFO)
    store.dispatch({ type: "event", event: ev(2, "m", "turn_complete") });
    await flush();
    expect(calls.filter((c) => c.method === "agent.send").map((c) => c.params["text"])).toEqual(["one", "two"]);
    expect(store.getState().outbox.length).toBe(0);
  });

  it("flushOutbox echoes the 'you' turn BEFORE the ack resolves (A1 ordering under a delayed ack)", async () => {
    const store = makeStore({
      mainConductorId: "m",
      selectedAgentId: "m",
      agents: { m: running("m", { conductor: true, busy: true }) },
      agentOrder: ["m"],
    });
    // A send whose ack is gated — models a slow daemon whose SSE stream could
    // otherwise race ahead of the ack.
    let releaseAck: () => void = () => {};
    const ackGate = new Promise<void>((r) => { releaseAck = r; });
    const sends: string[] = [];
    const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
      if (method === "agent.send") {
        sends.push((params as { text: string }).text);
        await ackGate;
        return {} as T;
      }
      return {} as T;
    };
    const commands = createAgentCommands(store, rpc);

    await commands.sendToMain("queued-msg"); // busy → held in the outbox
    expect(store.getState().outbox.map((o) => o.text)).toEqual(["queued-msg"]);

    // Turn ends → the watcher flushes the head item. Its echo + outboxRemove run
    // SYNCHRONOUSLY inside the busy→idle dispatch, before the gated ack.
    store.dispatch({ type: "event", event: ev(1, "m", "turn_complete") });
    await flush();

    // BEFORE releasing the ack: the "you" turn already sits at the transcript
    // tail, the queued item is gone, and the target is busy again.
    const tx = store.getState().agents["m"]!.transcript;
    expect(tx[tx.length - 1]).toMatchObject({ role: "user", text: "queued-msg" });
    expect(store.getState().outbox.length).toBe(0);
    expect(store.getState().agents["m"]!.busy).toBe(true);
    expect(sends).toEqual(["queued-msg"]); // the send is in flight, awaiting the ack

    releaseAck();
    await flush();
    expect(store.getState().lastError).toBeNull();
  });

  it("flushOutbox surfaces a send failure but keeps the item dropped (optimistic reconcile)", async () => {
    const store = makeStore({
      mainConductorId: "m",
      selectedAgentId: "m",
      agents: { m: running("m", { conductor: true, busy: true }) },
      agentOrder: ["m"],
    });
    const rpc: RpcFn = async <T,>(method: string): Promise<T> => {
      if (method === "agent.send") throw new Error("network down");
      return {} as T;
    };
    const commands = createAgentCommands(store, rpc);
    await commands.sendToMain("held");
    store.dispatch({ type: "event", event: ev(1, "m", "turn_complete") });
    await flush();
    expect(store.getState().outbox.length).toBe(0);      // dropped, never retried forever
    expect(store.getState().lastError).toBe("network down");
  });

  it("popQueued pulls the LAST item back and re-queues a non-empty draft", () => {
    const store = makeStore({
      mainConductorId: "m",
      agents: { m: running("m", { conductor: true, busy: true }) },
      agentOrder: ["m"],
    });
    const { rpc } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    store.dispatch({ type: "outboxAdd", item: { id: "qa", agentId: "m", text: "held-1" } });
    store.dispatch({ type: "outboxAdd", item: { id: "qb", agentId: "m", text: "held-2" } });
    // IMAGE-EDIT-LOSES-IMAGE: popQueued now returns the whole compose STATE, not just text — a
    // queued image message has to come back with its images or editing it silently drops them.
    const restored = commands.popQueued("m", { text: "my draft" });
    expect(restored).toEqual({ text: "held-2", images: [], nextNum: 1 });
    expect(store.getState().outbox.map((o) => o.text)).toEqual(["held-1", "my draft"]);
  });

  it("brings a queued IMAGE message back with its image, not just the filename", () => {
    // Reported: editing a sent image message gave a placeholder, and re-sending delivered the word
    // "image.png". The queued `text` is the flattened form; `content` is the faithful record.
    const store = makeStore({
      mainConductorId: "m",
      agents: { m: running("m", { conductor: true, busy: true }) },
      agentOrder: ["m"],
    });
    const { rpc } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    store.dispatch({
      type: "outboxAdd",
      item: {
        id: "qi", agentId: "m", text: "look at image.png",
        images: [{ mediaType: "image/png", data: "AAAA" }],
        content: [{ type: "text", text: "look at " }, { type: "image", mediaType: "image/png", data: "AAAA" }],
      },
    });
    const restored = commands.popQueued("m", { text: "" })!;
    expect(restored.images).toEqual([{ mediaType: "image/png", data: "AAAA", num: 1, name: "image.png" }]);
    expect(restored.text).toContain("look at ");
    expect(restored.text).toMatch(/\[▣ #1 image\.png\]/);
  });

  it("re-queues the displaced draft WITH its images — the same loss in the other direction", () => {
    const store = makeStore({
      mainConductorId: "m",
      agents: { m: running("m", { conductor: true, busy: true }) },
      agentOrder: ["m"],
    });
    const { rpc } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    store.dispatch({ type: "outboxAdd", item: { id: "qa", agentId: "m", text: "held" } });
    commands.popQueued("m", {
      text: "my draft",
      images: [{ mediaType: "image/png", data: "BBBB" }],
      content: [{ type: "text", text: "my draft" }, { type: "image", mediaType: "image/png", data: "BBBB" }],
    });
    const requeued = store.getState().outbox.find((o) => o.text === "my draft")!;
    expect(requeued.images).toEqual([{ mediaType: "image/png", data: "BBBB" }]);
  });
});

// ---------------------------------------------------------------------------
// FORCE-SEND-MIDTURN (opt+enter): sendToAgent/sendToMain's `force` param
// bypasses the busy-hold outbox and delivers straight through agent.send
// even mid-turn. Measured empirically (see the merge commit) that a mid-turn
// agent.send reaches the running SDK session's input queue immediately and
// surfaces at its very next inference step. Ordering rule: force never jumps
// ahead of messages already queued for the same target — it drains the
// existing outbox first (oldest-first), then delivers itself.
// ---------------------------------------------------------------------------
describe("force-send (sendToAgent/sendToMain `force`)", () => {
  it("serializes forced bursts behind an older outbox send, including main/selected routes", async () => {
    const store = makeStore({ mainConductorId: "m", agents: { m: running("m", { busy: true }) }, agentOrder: ["m"] });
    const sent: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
      if (method === "agent.send") {
        const text = (params as { text: string }).text;
        sent.push(text);
        if (text === "old") await blocked;
      }
      return {} as T;
    };
    const commands = createAgentCommands(store, rpc);
    await commands.sendToAgent("m", "old");
    const first = commands.sendToAgent("m", "force A", undefined, false, undefined, true);
    const second = commands.sendToMain("force B", undefined, { force: true });
    const third = commands.sendToAgent("m", "force C", undefined, false, undefined, true);
    await Promise.resolve();
    expect(sent).toEqual(["old"]);
    release();
    await Promise.all([first, second, third]);
    expect(sent).toEqual(["old", "force A", "force B", "force C"]);
  });

  it("sendToAgent force=true sends immediately while busy and does NOT enqueue", async () => {
    const store = makeStore({ agents: { m: running("m", { busy: true }) }, agentOrder: ["m"] });
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await commands.sendToAgent("m", "urgent context", undefined, false, undefined, true);
    expect(calls.filter((c) => c.method === "agent.send").map((c) => c.params["text"])).toEqual(["urgent context"]);
    expect(store.getState().outbox.length).toBe(0);
    expect(calls.find(c => c.method === "agent.send")?.params["force"]).toBe(true);
    // the transcript echo is tagged forced — distinct from a flushed queue item
    const tx = store.getState().agents["m"]!.transcript;
    expect(tx[tx.length - 1]).toMatchObject({ role: "user", text: "urgent context", forced: true });
  });

  it("sendToAgent force=false (default) while busy still queues exactly as before — no regression", async () => {
    const store = makeStore({ agents: { m: running("m", { busy: true }) }, agentOrder: ["m"] });
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await commands.sendToAgent("m", "normal message");
    expect(calls.filter((c) => c.method === "agent.send").length).toBe(0);
    expect(store.getState().outbox.map((o) => o.text)).toEqual(["normal message"]);
  });

  it("force=true against an IDLE agent behaves exactly like a normal send (no forced tag, no drain)", async () => {
    const store = makeStore({ agents: { m: running("m", { busy: false }) }, agentOrder: ["m"] });
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await commands.sendToAgent("m", "hi", undefined, false, undefined, true);
    expect(calls.filter((c) => c.method === "agent.send").length).toBe(1);
    const tx = store.getState().agents["m"]!.transcript;
    expect(tx[tx.length - 1]).toMatchObject({ role: "user", text: "hi" });
    expect(tx[tx.length - 1]!.role === "user" ? tx[tx.length - 1] : {}).not.toHaveProperty("forced");
  });

  it("ordering rule: force drains the existing outbox FIRST, oldest-first, then sends the forced message last", async () => {
    const store = makeStore({ agents: { m: running("m", { busy: true }) }, agentOrder: ["m"] });
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    // two ordinary sends queue while busy
    await commands.sendToAgent("m", "one");
    await commands.sendToAgent("m", "two");
    expect(store.getState().outbox.map((o) => o.text)).toEqual(["one", "two"]);
    // now a forced send arrives
    await commands.sendToAgent("m", "urgent", undefined, false, undefined, true);
    expect(calls.filter((c) => c.method === "agent.send").map((c) => c.params["text"])).toEqual(["one", "two", "urgent"]);
    expect(store.getState().outbox.length).toBe(0);
    const tx = store.getState().agents["m"]!.transcript;
    expect(tx.filter((t) => t.role === "user").map((t) => (t.role === "user" ? t.text : ""))).toEqual(["one", "two", "urgent"]);
  });

  it("sendToMain force=true sends mid-session immediately while the conductor is busy and drains its outbox first", async () => {
    const store = makeStore({
      mainConductorId: "m",
      selectedAgentId: "m",
      agents: { m: running("m", { conductor: true, busy: true }) },
      agentOrder: ["m"],
    });
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await commands.sendToMain("queued-first"); // busy → held
    expect(store.getState().outbox.map((o) => o.text)).toEqual(["queued-first"]);
    await commands.sendToMain("forced-now", undefined, { force: true });
    expect(calls.filter((c) => c.method === "agent.send").map((c) => c.params["text"])).toEqual(["queued-first", "forced-now"]);
    expect(store.getState().outbox.length).toBe(0);
    const tx = store.getState().agents["m"]!.transcript;
    expect(tx[tx.length - 1]).toMatchObject({ role: "user", text: "forced-now", forced: true });
    expect(calls.filter(c => c.method === "agent.send").map(c => c.params["force"])).toEqual([undefined, true]);
  });

  it("sendComposed threads `force` through to sendToAgent for a resolved target", async () => {
    const store = makeStore({ agents: { m: running("m", { busy: true }) }, agentOrder: ["m"], selectedAgentId: "m" });
    const { rpc, calls } = makeRpc();
    const commands = createAgentCommands(store, rpc);
    await commands.sendComposed("selected", "push this now", undefined, undefined, true);
    expect(calls.filter((c) => c.method === "agent.send").map((c) => c.params["text"])).toEqual(["push this now"]);
    expect(store.getState().outbox.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// misc ports
// ---------------------------------------------------------------------------
describe("cycleValue", () => {
  it("cycles forward/backward with wrap and handles unknown current", () => {
    const list = ["a", "b", "c"];
    expect(cycleValue(list, "a")).toBe("b");
    expect(cycleValue(list, "c")).toBe("a");
    expect(cycleValue(list, "b", true)).toBe("a");
    expect(cycleValue(list, "zz")).toBe("a");
    expect(cycleValue(list, "zz", true)).toBe("c");
  });
});

describe("fleet bulk commands", () => {
  it("snapshots, filters and de-duplicates exact interrupt targets into one RPC", async () => {
    const store = makeStore({ agents: { a: running("a"), b: running("b"), done: { ...emptyAgent("done"), state: "done" } }, agentOrder: ["a", "b", "done"] });
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).bulkInterrupt(["a", "b", "a", "done", "missing"]);
    expect(calls).toEqual([{ method: "agent.interruptMany", params: { agentIds: ["a", "b"] } }]);
  });

  // OPERATOR-HOLD: this pinned bulkPause to agent.interruptMany — which aborted the turn and let
  // the agent carry straight on, under a name that promised a hold. It now genuinely holds:
  // the turn's own input is requeued daemon-side and the session is parked, resumable.
  it("bulk pause HOLDS the agents and drops their liveboard lanes", async () => {
    const store = makeStore({ agents: { a: running("a") }, agentOrder: ["a"], liveboardLanes: [{ agentId: "a", follow: true, unread: 0 }] });
    const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
      rpcCalls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      if (method === "agent.hold") return { held: ["a"], skipped: [] } as T;
      return (method === "agent.list" ? [] : {}) as T;
    };
    await createAgentCommands(store, rpc).bulkPause(["a"]);
    expect(store.state.liveboardLanes[0]!.follow).toBe(false);
    expect(rpcCalls[0]).toEqual({ method: "agent.hold", params: { agentIds: ["a"] } });
    expect(store.state.notice ?? "").toContain("held 1");
  });

  it("bulk release resumes only agents that are actually paused", async () => {
    const store = makeStore({
      agents: { a: running("a", { state: "paused" }), b: running("b") },
      agentOrder: ["a", "b"],
    });
    const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
      rpcCalls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      if (method === "agent.release") return { released: ["a"] } as T;
      return (method === "agent.list" ? [] : {}) as T;
    };
    await createAgentCommands(store, rpc).bulkRelease(["a", "b"]);
    // "b" is running — releasing it is meaningless, so it never reaches the daemon
    expect(rpcCalls[0]).toEqual({ method: "agent.release", params: { agentIds: ["a"] } });
  });
});

// SESSION-TIER: spawnAgent threads the session marker; closeAllSessions batch-kills only
// session-marked agents, leaving project conductors untouched.
describe("session tier: spawn threading + batch close", () => {
  it("spawnAgent sends session:true in the spec when input.session is set", async () => {
    const store = makeStore();
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).spawnAgent({ prompt: "x", cwd: "/tmp", session: true });
    const spawnCall = calls.find((c) => c.method === "agent.spawn")!;
    expect((spawnCall.params["spec"] as Record<string, unknown>)["session"]).toBe(true);
  });

  it("spawnAgent omits session entirely when unset — byte-identical to today", async () => {
    const store = makeStore();
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).spawnAgent({ prompt: "x", cwd: "/tmp" });
    const spawnCall = calls.find((c) => c.method === "agent.spawn")!;
    expect("session" in (spawnCall.params["spec"] as Record<string, unknown>)).toBe(false);
  });

  it("closeAllSessions kills only running/paused session agents, leaving conductors alone", async () => {
    const store = makeStore({
      agents: {
        conductorA: running("conductorA", { conductor: true }),
        s1: running("s1", { session: true }),
        s2: { ...running("s2", { session: true }), state: "done" },
      },
      agentOrder: ["conductorA", "s1", "s2"],
    });
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).closeAllSessions();
    expect(calls).toEqual([{ method: "agent.killMany", params: { agentIds: ["s1"] } }]);
  });

  it("closeAllSessions is a no-op RPC when no session agent is running/paused", async () => {
    const store = makeStore({ agents: { conductorA: running("conductorA", { conductor: true }) }, agentOrder: ["conductorA"] });
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).closeAllSessions();
    expect(calls).toEqual([]);
  });
});

// Ad-hoc sessions design §4: spawnAgent threads `role` as a TOP-LEVEL agent.spawn param
// (sibling to `engine`), never inside `spec` — the server resolves it against the session
// role registry.
describe("session roles: spawn threading", () => {
  it("spawnAgent sends role as a top-level param when input.role is set", async () => {
    const store = makeStore();
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).spawnAgent({ prompt: "x", cwd: "/tmp", role: "review" });
    const spawnCall = calls.find((c) => c.method === "agent.spawn")!;
    expect(spawnCall.params["role"]).toBe("review");
    expect("role" in (spawnCall.params["spec"] as Record<string, unknown>)).toBe(false);
  });

  it("spawnAgent omits role entirely when unset — byte-identical to today", async () => {
    const store = makeStore();
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).spawnAgent({ prompt: "x", cwd: "/tmp" });
    const spawnCall = calls.find((c) => c.method === "agent.spawn")!;
    expect("role" in spawnCall.params).toBe(false);
  });
});

// ROLE-PERMISSION-REQUEST-STOMPED: spawnAgent used to hardcode on.permissionRequest:"tui"
// whenever effectiveProfile couldn't be determined client-side — including the exact case a
// role-pick spawn hits (no explicit permissionProfile, since SpawnCard.tsx's
// computeRoleSpecOverrides drops it when it matches the role's own default), silently
// discarding a role's own declared on.permissionRequest (e.g. "auto"). SpawnCard.tsx now
// reads that value off the picked role and threads it through as input.permissionRequest.
describe("spawnAgent: on.permissionRequest — role-sourced value survives", () => {
  // permissionMode: "ask" — makeStore()'s bare default is "bypass" (see the sendToMain
  // "default mode is bypass" test above), which would force effectiveProfile:"full" and mask
  // exactly the no-explicit-signal gap this describe block exists to cover.
  it("input.permissionRequest (role-sourced) rides through as the effective on.permissionRequest", async () => {
    const store = makeStore({ permissionMode: "ask" });
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).spawnAgent({ prompt: "x", cwd: "/tmp", role: "aws", permissionRequest: "auto" });
    const spec = calls.find((c) => c.method === "agent.spawn")!.params["spec"] as Record<string, unknown>;
    expect(spec["on"]).toEqual({ permissionRequest: "auto" });
  });

  it("an explicit permissionProfile always wins over a role-sourced permissionRequest", async () => {
    const store = makeStore({ permissionMode: "ask" });
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).spawnAgent({
      prompt: "x", cwd: "/tmp", role: "aws", permissionRequest: "auto", permissionProfile: "acceptEdits",
    });
    const spec = calls.find((c) => c.method === "agent.spawn")!.params["spec"] as Record<string, unknown>;
    expect(spec["on"]).toEqual({ permissionRequest: "tui" });
  });

  it("no role, no explicit profile — defaults to tui, byte-identical to today", async () => {
    const store = makeStore({ permissionMode: "ask" });
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).spawnAgent({ prompt: "x", cwd: "/tmp" });
    const spec = calls.find((c) => c.method === "agent.spawn")!.params["spec"] as Record<string, unknown>;
    expect(spec["on"]).toEqual({ permissionRequest: "tui" });
  });
});

// ---------------------------------------------------------------------------
// nextToolDetail — the transcript tool-call click TOGGLE (openDetail in
// TranscriptPanel.tsx delegates here): re-clicking the already-open block
// closes it, clicking any other block always opens that one.
// ---------------------------------------------------------------------------
describe("nextToolDetail", () => {
  it("opens a block when nothing is open", () => {
    expect(nextToolDetail(null, "a1", 3)).toEqual({ agentId: "a1", blockStart: 3, call: 0 });
  });

  it("re-clicking the already-open block closes it (null)", () => {
    const cur = { agentId: "a1", blockStart: 3, call: 2 };
    expect(nextToolDetail(cur, "a1", 3)).toBeNull();
  });

  it("clicking a different block replaces the open one, resetting call to 0", () => {
    const cur = { agentId: "a1", blockStart: 3, call: 2 };
    expect(nextToolDetail(cur, "a1", 7)).toEqual({ agentId: "a1", blockStart: 7, call: 0 });
  });

  it("a block open for a DIFFERENT agent is not treated as the same block (opens fresh, doesn't close)", () => {
    const cur = { agentId: "a1", blockStart: 3, call: 2 };
    expect(nextToolDetail(cur, "a2", 3)).toEqual({ agentId: "a2", blockStart: 3, call: 0 });
  });
});

// ---------------------------------------------------------------------------
// useAgentStatus (AGENT-INFO-PANEL) — the on-demand agent.status fetch behind
// the TranscriptPanel inspector. A real render pass via react-test-renderer,
// no DOM (mirrors commands.checkpoints.test.ts's useFilesSinceMeta harness).
// ---------------------------------------------------------------------------
const flushHooks = (): Promise<void> => act(async () => {});

function renderHook<T>(hook: () => T): { result: { current: T }; rerender: () => Promise<void>; unmount: () => void } {
  const result = {} as { current: T };
  function Test(): null {
    result.current = hook();
    return null;
  }
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(Test));
  });
  return {
    result,
    rerender: () => act(async () => renderer.update(React.createElement(Test))),
    unmount: () => act(() => renderer.unmount()),
  };
}

describe("useAgentStatus", () => {
  it("fetches agent.status for the given agentId and returns the raw record", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const request = <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      return Promise.resolve({ agentId: "a1", spec: { cwd: "/repo" } } as T);
    };
    const h = renderHook(() => useAgentStatus("a1", request));
    expect(h.result.current).toEqual({ status: null, loading: true }); // synchronous first render: fetch in flight
    await flushHooks();
    expect(calls).toEqual([{ method: "agent.status", params: { agentId: "a1" } }]);
    expect(h.result.current).toEqual({ status: { agentId: "a1", spec: { cwd: "/repo" } }, loading: false });
  });

  it("a null agentId (panel closed) never calls the RPC and stays idle", async () => {
    const calls: unknown[] = [];
    const request = <T,>(): Promise<T> => {
      calls.push(1);
      return Promise.reject(new Error("should not be called"));
    };
    const h = renderHook(() => useAgentStatus(null, request));
    await flushHooks();
    expect(calls).toEqual([]);
    expect(h.result.current).toEqual({ status: null, loading: false });
  });

  it("a rejected fetch settles to status:null rather than throwing", async () => {
    const request = <T,>(): Promise<T> => Promise.reject(new Error("boom"));
    const h = renderHook(() => useAgentStatus("a1", request));
    await flushHooks();
    expect(h.result.current).toEqual({ status: null, loading: false });
  });

  it("switching agentId re-fetches and drops a stale in-flight response for the OLD id", async () => {
    const idRef = { current: "a1" };
    let resolveFirst!: (v: Record<string, unknown>) => void;
    const request = <T,>(_method: string, params?: unknown): Promise<T> => {
      const agentId = (params as { agentId: string }).agentId;
      if (agentId === "a1") return new Promise((r) => { resolveFirst = r as (v: Record<string, unknown>) => void; }) as Promise<T>;
      return Promise.resolve({ agentId: "a2" } as T);
    };
    const h = renderHook(() => useAgentStatus(idRef.current, request));
    // seed with a1, then move on to a2 before a1's fetch resolves
    await flushHooks();
    idRef.current = "a2";
    await h.rerender();
    await flushHooks();
    expect(h.result.current).toEqual({ status: { agentId: "a2" }, loading: false });
    act(() => resolveFirst({ agentId: "a1" })); // the stale a1 response must NOT clobber a2's result
    await flushHooks();
    expect(h.result.current).toEqual({ status: { agentId: "a2" }, loading: false });
  });
});

// ---------------------------------------------------------------------------
// F22 (W24) — quote-reply slot builders
// ---------------------------------------------------------------------------

describe("quoteFromMessageKey", () => {
  const transcript: AgentView["transcript"] = [
    { role: "user", text: "hi" },
    { role: "assistant", text: "  the boundary tests are missing  ", streaming: false, ts: 4242 },
    { role: "assistant", text: "", streaming: false }, // empty turn — nothing to quote
  ];

  it("builds a verbatim (trimmed) turn quote from a valid assistant message key", () => {
    const slot = quoteFromMessageKey("a1#1", "a1", transcript);
    expect(slot).toEqual({ agentId: "a1", kind: "turn", seq: 1, ts: 4242, excerpt: "the boundary tests are missing" });
  });

  it("returns null for a key belonging to a DIFFERENT agent", () => {
    expect(quoteFromMessageKey("other#1", "a1", transcript)).toBeNull();
  });

  it("returns null for a non-assistant turn", () => {
    expect(quoteFromMessageKey("a1#0", "a1", transcript)).toBeNull();
  });

  it("returns null for an empty assistant turn", () => {
    expect(quoteFromMessageKey("a1#2", "a1", transcript)).toBeNull();
  });

  it("falls back to Date.now() when the turn carries no ts", () => {
    const noTs: AgentView["transcript"] = [{ role: "assistant", text: "hello", streaming: false }];
    const before = Date.now();
    const slot = quoteFromMessageKey("a1#0", "a1", noTs);
    expect(slot?.ts).toBeGreaterThanOrEqual(before);
  });
});

describe("quoteFromAgent", () => {
  it("a RUNNING agent quotes its latest non-empty assistant turn (no RPC call)", async () => {
    const { rpc, calls } = makeRpc();
    const state: UiState = {
      ...initialState,
      agentOrder: ["a1"],
      agents: {
        a1: running("a1", {
          transcript: [
            { role: "assistant", text: "first", streaming: false, ts: 1 },
            { role: "user", text: "more please" },
            { role: "assistant", text: "  latest turn  ", streaming: false, ts: 2 },
          ],
        }),
      },
    };
    const slot = await quoteFromAgent(rpc, state, "a1");
    expect(slot).toEqual({ agentId: "a1", kind: "turn", seq: 2, ts: 2, excerpt: "latest turn" });
    expect(calls).toEqual([]); // running path never hits agent.result
  });

  it("a RUNNING agent with no assistant turns yet returns null", async () => {
    const { rpc } = makeRpc();
    const state: UiState = { ...initialState, agentOrder: ["a1"], agents: { a1: running("a1", { transcript: [{ role: "user", text: "hi" }] }) } };
    expect(await quoteFromAgent(rpc, state, "a1")).toBeNull();
  });

  it("a DONE agent quotes agent.result (existing RPC)", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params: params as Record<string, unknown> });
      return { state: "done", text: "  verbatim result  ", costUsd: 0.1 } as T;
    };
    const state: UiState = { ...initialState, agentOrder: ["a1"], agents: { a1: { ...emptyAgent("a1"), state: "done", transcript: [{ role: "assistant", text: "x", streaming: false }] } } };
    const slot = await quoteFromAgent(rpc, state, "a1");
    expect(calls).toEqual([{ method: "agent.result", params: { agentId: "a1" } }]);
    expect(slot).toEqual({ agentId: "a1", kind: "result", seq: 1, ts: expect.any(Number), excerpt: "verbatim result" });
  });

  it("a done agent with an empty agent.result text falls back to a minimal reference (never a silent no-op)", async () => {
    const rpc: RpcFn = async <T,>(): Promise<T> => ({ state: "done", text: "", costUsd: 0 } as T);
    const state: UiState = { ...initialState, agentOrder: ["a1"], agents: { a1: { ...emptyAgent("a1"), state: "done" } } };
    const slot = await quoteFromAgent(rpc, state, "a1");
    expect(slot).toEqual({ agentId: "a1", kind: "result", seq: 0, ts: expect.any(Number), excerpt: "(done — no output)" });
  });

  it("a FAILED agent with no result text quotes its failure reason (errorClass from agent.status)", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params: params as Record<string, unknown> });
      if (method === "agent.result") return { state: "failed", text: "", costUsd: 0 } as T;
      return { attempts: [{ account: "acc1", startedAt: 1, errorClass: "spawn-error" }] } as T;
    };
    const state: UiState = { ...initialState, agentOrder: ["a1"], agents: { a1: { ...emptyAgent("a1"), state: "failed" } } };
    const slot = await quoteFromAgent(rpc, state, "a1");
    expect(calls.map((c) => c.method)).toEqual(["agent.result", "agent.status"]);
    expect(slot).toEqual({ agentId: "a1", kind: "result", seq: 0, ts: expect.any(Number), excerpt: "failed: spawn-error (no output)" });
  });

  it("a FAILED agent with a classified failure quotes the shared cause label, not the raw errorClass (F08)", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params: params as Record<string, unknown> });
      if (method === "agent.result") return { state: "failed", text: "", costUsd: 0 } as T;
      // A daemon that stamped `failure` also still stamps `attempts[].errorClass` for an older
      // client — the cause must win over that fallback, not just be tried first.
      return { failure: { cause: "account-cap" }, attempts: [{ account: "acc1", startedAt: 1, errorClass: "rate-limit" }] } as T;
    };
    const state: UiState = { ...initialState, agentOrder: ["a1"], agents: { a1: { ...emptyAgent("a1"), state: "failed" } } };
    const slot = await quoteFromAgent(rpc, state, "a1");
    expect(slot).toEqual({ agentId: "a1", kind: "result", seq: 0, ts: expect.any(Number), excerpt: "failed: account capped (no output)" });
  });

  it("a FAILED agent with no errorClass on record falls back to a generic failure excerpt", async () => {
    const rpc: RpcFn = async <T,>(method: string): Promise<T> => {
      if (method === "agent.result") return { state: "failed", text: "", costUsd: 0 } as T;
      return { attempts: [] } as T;
    };
    const state: UiState = { ...initialState, agentOrder: ["a1"], agents: { a1: { ...emptyAgent("a1"), state: "failed" } } };
    const slot = await quoteFromAgent(rpc, state, "a1");
    expect(slot?.excerpt).toBe("failed (no output)");
  });

  it("a FAILED agent whose agent.status fetch itself throws still yields a generic failure excerpt", async () => {
    const rpc: RpcFn = async <T,>(method: string): Promise<T> => {
      if (method === "agent.result") return { state: "failed", text: "", costUsd: 0 } as T;
      throw new Error("boom");
    };
    const state: UiState = { ...initialState, agentOrder: ["a1"], agents: { a1: { ...emptyAgent("a1"), state: "failed" } } };
    const slot = await quoteFromAgent(rpc, state, "a1");
    expect(slot?.excerpt).toBe("failed (no output)");
  });

  it("a KILLED agent with no result text quotes a minimal state reference", async () => {
    const rpc: RpcFn = async <T,>(): Promise<T> => ({ state: "killed", text: "", costUsd: 0 } as T);
    const state: UiState = { ...initialState, agentOrder: ["a1"], agents: { a1: { ...emptyAgent("a1"), state: "killed" } } };
    const slot = await quoteFromAgent(rpc, state, "a1");
    expect(slot).toEqual({ agentId: "a1", kind: "result", seq: 0, ts: expect.any(Number), excerpt: "(killed — no output)" });
  });

  it("an unknown agentId returns null without calling the RPC", async () => {
    const { rpc, calls } = makeRpc();
    expect(await quoteFromAgent(rpc, initialState, "ghost")).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("buildQuotedPrefix", () => {
  it("wraps ui-state's encodeQuoteBlock verbatim", () => {
    const prefix = buildQuotedPrefix("eager-weasel", "14:04:02", { kind: "result", excerpt: "verbatim result" });
    expect(prefix).toBe("> verbatim result\n> — @eager-weasel · result · 14:04:02");
  });
});

// ---------------------------------------------------------------------------
// DISMISS-A-FINISHED-AGENT
// ---------------------------------------------------------------------------
// The ✕ means "make this row go away". For a live agent that is a kill; for one that already
// finished it cannot be (agent.kill on a terminal record is an honest no-op), which left a
// finished session row undismissable — the sessions bucket only hides on `killed`, a state a
// self-finished session can never reach. So ✕ on a terminal agent forgets that ONE record.
describe("killSelected / killAgent — kill when live, dismiss when finished", () => {
  const withList = (): { rpc: RpcFn; calls: Array<{ method: string; params: Record<string, unknown> }> } => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      return (method === "agent.list" ? [] : {}) as T;
    };
    return { rpc, calls };
  };

  it("kills a running agent — unchanged behaviour, no record is forgotten", async () => {
    const store = makeStore({ agents: { a: running("a") }, agentOrder: ["a"], selectedAgentId: "a" });
    const { rpc, calls } = withList();
    await createAgentCommands(store, rpc).killSelected();
    expect(calls.map((c) => c.method)).toEqual(["agent.kill", "agent.list"]);
    expect(store.state.selectedAgentId).toBeNull();
  });

  it("dismisses a DONE agent instead of issuing a kill that would do nothing", async () => {
    const store = makeStore({ agents: { a: running("a", { state: "done", session: true }) }, agentOrder: ["a"], selectedAgentId: "a" });
    const { rpc, calls } = withList();
    await createAgentCommands(store, rpc).killSelected();
    expect(calls[0]).toEqual({ method: "agent.forget", params: { agentIds: ["a"] } });
    // the roster is re-read so the row leaves the list without waiting for the next poll
    expect(calls[1]?.method).toBe("agent.list");
  });

  it("dismisses a failed or killed agent the same way — terminal is terminal", async () => {
    for (const state of ["failed", "killed"] as const) {
      const store = makeStore({ agents: { a: running("a", { state }) }, agentOrder: ["a"] });
      const { rpc, calls } = withList();
      await createAgentCommands(store, rpc).killAgent("a");
      expect(calls[0]).toEqual({ method: "agent.forget", params: { agentIds: ["a"] } });
    }
  });

  it("tells the operator to restart a daemon that predates agent.forget rather than reporting a raw protocol error", async () => {
    const store = makeStore({ agents: { a: running("a", { state: "done" }) }, agentOrder: ["a"] });
    const rpc: RpcFn = async <T,>(method: string): Promise<T> => {
      if (method === "agent.forget") throw { code: "protocol", message: 'unknown method "agent.forget"' };
      return {} as T;
    };
    await createAgentCommands(store, rpc).killAgent("a");
    expect(store.state.lastError ?? "").toContain("restart chimerad");
  });
});

// SLASH-IS-THE-SIGNAL: a typed "/x" is delivered VERBATIM. The gate used to be "only if the agent
// ADVERTISED x" — and that list is project/plugin commands only (verified live: 200+ advertised
// names, none of compact/clear/cost/model), so every provider builtin failed it and went out as an
// ordinary message, where the "" prefix masks the leading slash and the backend reads
// prose. A hardcoded builtin list replaced it briefly and is worse: it rots the moment a CLI gains
// or renames a command, invisibly. The operator's own slash is the signal.
describe("sendSlash routing", () => {
  const withAgent = (over: Partial<AgentView>) => makeStore({
    agents: { a: running("a", over) }, agentOrder: ["a"], selectedAgentId: "a",
  });
  it("sends Codex goal pause immediately while the agent is busy", async () => {
    const store = withAgent({ provider: "codex", busy: true });
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).sendSlash({ kind: "agent", agentId: "a" } as never, "goal", "pause");
    expect(calls.find(c => c.method === "agent.send")?.params).toMatchObject({ text: "/goal pause", slash: true });
    expect(store.state.outbox).toHaveLength(0);
  });

  it("sends a provider builtin verbatim even though it is never advertised", async () => {
    const store = withAgent({ provider: "claude", slashCommands: [] });
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).sendSlash({ kind: "agent", agentId: "a" } as never, "compact", "");
    const send = calls.find((c) => c.method === "agent.send")!;
    expect(send.params).toMatchObject({ text: "/compact", slash: true });
  });

  it("sends an advertised project command verbatim too, with its args", async () => {
    const store = withAgent({ provider: "claude", slashCommands: [{ name: "deploy" }] as never });
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).sendSlash({ kind: "agent", agentId: "a" } as never, "deploy", "prod");
    const send = calls.find((c) => c.method === "agent.send")!;
    expect(send.params).toMatchObject({ text: "/deploy prod", slash: true });
  });

  it("sends an unknown one verbatim as well — 'no such command' from the provider is information, arriving as prose is not", async () => {
    const store = withAgent({ provider: "claude", slashCommands: [] });
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).sendSlash({ kind: "agent", agentId: "a" } as never, "definitely-not-a-command", "");
    const send = calls.find((c) => c.method === "agent.send")!;
    expect(send.params["slash"]).toBe(true);
  });

  it("does not depend on the provider — no per-provider list to rot", async () => {
    const store = withAgent({ provider: "codex", slashCommands: [] });
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).sendSlash({ kind: "agent", agentId: "a" } as never, "compact", "");
    const send = calls.find((c) => c.method === "agent.send")!;
    expect(send.params["slash"]).toBe(true);
  });

  it("an ORDINARY composed message is still prefixed — only a slash command goes verbatim", async () => {
    const store = withAgent({ provider: "claude" });
    const { rpc, calls } = makeRpc();
    await createAgentCommands(store, rpc).sendComposed({ kind: "agent", agentId: "a" } as never, "just a message");
    const send = calls.find((c) => c.method === "agent.send")!;
    expect(send.params["slash"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F09.UI — resend the prompt an agent never picked up. INTERRUPT is deliberately not offered on a
// prompt-stalled agent: it never opened a turn, so agent.interrupt is a no-op on it.
describe("resendStalledPrompt (F09.UI)", () => {
  const stall = { deliveryId: "d1", from: "conductor", sinceTs: 1000, sinceMs: 45000, text: "review the diff" };

  it("re-delivers the captured text via agent.send, forced past the busy-hold", async () => {
    const store = makeStore({ ...initialState, agents: { a: running("a", { promptStall: stall }) }, agentOrder: ["a"] });
    const { rpc, calls } = makeRpc();
    const checkedRpc: RpcFn = async <T,>(method: string, params?: unknown) => method === "agent.status" ? { promptStall: stall } as T : rpc<T>(method, params);
    const ok = await createAgentCommands(store, checkedRpc).resendStalledPrompt("a");
    expect(ok).toBe(true);
    const send = calls.find((c) => c.method === "agent.send");
    expect(send?.params).toMatchObject({ agentId: "a", text: "review the diff" });
  });

  it.each([null, { deliveryId: "newer-message" }])("does not repeat a stale badge's prompt when current stall is %s", async (promptStall) => {
    const store = makeStore({ ...initialState, agents: { a: running("a", { promptStall: stall }) }, agentOrder: ["a"] });
    const { rpc, calls } = makeRpc();
    const checkedRpc: RpcFn = async <T,>(method: string, params?: unknown) => method === "agent.status" ? { promptStall } as T : rpc<T>(method, params);
    expect(await createAgentCommands(store, checkedRpc).resendStalledPrompt("a")).toBe(false);
    expect(calls.some(c => c.method === "agent.send")).toBe(false);
  });

  it("never synthesizes a message when the original text was not captured", async () => {
    const noText = { deliveryId: "d1", from: "conductor", sinceTs: 1000, sinceMs: 45000 };
    const store = makeStore({ ...initialState, agents: { a: running("a", { promptStall: noText }) }, agentOrder: ["a"] });
    const { rpc, calls } = makeRpc();
    expect(await createAgentCommands(store, rpc).resendStalledPrompt("a")).toBe(false);
    expect(calls.some((c) => c.method === "agent.send")).toBe(false);
  });

  it("reports rather than silently no-ops when the agent has no stall", async () => {
    const store = makeStore({ ...initialState, agents: { a: running("a") }, agentOrder: ["a"] });
    const { rpc, calls } = makeRpc();
    expect(await createAgentCommands(store, rpc).resendStalledPrompt("a")).toBe(false);
    expect(calls.some((c) => c.method === "agent.send")).toBe(false);
  });
});
