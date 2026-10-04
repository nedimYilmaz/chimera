import { describe, expect, it } from "vitest";
import {
  initialState,
  reduce,
  type Action,
  type EditTaskTarget,
  type UiState,
  type WorkflowGraphDocument,
} from "@chimera/ui-state";

const DOC: WorkflowGraphDocument = {
  name: "overlay-test",
  onFail: "halt",
  retryLimit: 0,
  params: [],
  nodeOrder: ["one"],
  nodesById: {
    one: { id: "one", step: { id: "one", title: "One", gate: { kind: "none" } } },
  },
  edgesById: {},
};

const EDIT_TARGET: EditTaskTarget = {
  taskId: "task-1",
  queue: "queue-1",
  prompt: "edit me",
  role: "worker",
  priority: "5",
};

const feed = (state: UiState, actions: Action[]): UiState => actions.reduce(reduce, state);

type Overlay = {
  name: string;
  open(state: UiState): UiState;
  isOpen(state: UiState): boolean;
};

const booleanOverlay = (
  name: string,
  type: "versionsOpen" | "taskDetailOpen" | "accountsOpen" | "helpOpen" | "a2aHistoryOpen" | "paletteOpen" | "mcpPaletteOpen" | "resultOpen",
  read: (state: UiState) => boolean,
): Overlay => ({
  name,
  open: (state) => reduce(state, { type, open: true }),
  isOpen: read,
});

const modeOverlay = (mode: Exclude<UiState["mode"], "normal">): Overlay => ({
  name: `mode:${mode}`,
  open: (state) => {
    if (mode === "pushForm") {
      state = reduce(state, { type: "pushQueue", queue: "queue-1" });
    } else if (mode === "editForm") {
      state = reduce(state, { type: "editTask", target: EDIT_TARGET });
    } else if (mode === "confirm") {
      state = reduce(state, { type: "confirm", confirm: { kind: "stopDaemon" } });
    }
    return reduce(state, { type: "setMode", mode });
  },
  isOpen: (state) => state.mode === mode,
});

const overlays: Overlay[] = [
  {
    name: "workflowStudio.open",
    open: (state) => reduce(state, { type: "workflowStudioOpen", mode: "author", document: DOC, queue: "queue-1" }),
    isOpen: (state) => state.workflowStudio.open,
  },
  {
    name: "reviewRoom.openTaskId",
    open: (state) => reduce(state, { type: "reviewRoomOpen", taskId: "task-1" }),
    isOpen: (state) => state.reviewRoom.openTaskId !== null,
  },
  booleanOverlay("versionsOpen", "versionsOpen", (state) => state.versionsOpen),
  booleanOverlay("taskDetailOpen", "taskDetailOpen", (state) => state.taskDetailOpen),
  booleanOverlay("accountsOpen", "accountsOpen", (state) => state.accountsOpen),
  booleanOverlay("helpOpen", "helpOpen", (state) => state.helpOpen),
  booleanOverlay("a2aHistoryOpen", "a2aHistoryOpen", (state) => state.a2aHistoryOpen),
  booleanOverlay("paletteOpen", "paletteOpen", (state) => state.paletteOpen),
  booleanOverlay("mcpPaletteOpen", "mcpPaletteOpen", (state) => state.mcpPaletteOpen),
  booleanOverlay("resultOpen", "resultOpen", (state) => state.resultOpen),
  modeOverlay("spawn"),
  modeOverlay("teamForm"),
  modeOverlay("queueForm"),
  modeOverlay("pushForm"),
  modeOverlay("confirm"),
  modeOverlay("memoryForm"),
  modeOverlay("editForm"),
];

function expectAllClosed(state: UiState): void {
  expect(
    {
      workflowStudio: state.workflowStudio.open,
      reviewRoom: state.reviewRoom.openTaskId,
      versionsOpen: state.versionsOpen,
      taskDetailOpen: state.taskDetailOpen,
      accountsOpen: state.accountsOpen,
      helpOpen: state.helpOpen,
      a2aHistoryOpen: state.a2aHistoryOpen,
      paletteOpen: state.paletteOpen,
      paletteQuery: state.paletteQuery,
      mcpPaletteOpen: state.mcpPaletteOpen,
      resultOpen: state.resultOpen,
      mode: state.mode,
      pushQueue: state.pushQueue,
      editTask: state.editTask,
      confirm: state.confirm,
    },
    "every transient overlay and its coupled state should be reset",
  ).toEqual({
    workflowStudio: false,
    reviewRoom: null,
    versionsOpen: false,
    taskDetailOpen: false,
    accountsOpen: false,
    helpOpen: false,
    a2aHistoryOpen: false,
    paletteOpen: false,
    paletteQuery: "",
    mcpPaletteOpen: false,
    resultOpen: false,
    mode: "normal",
    pushQueue: null,
    editTask: null,
    confirm: null,
  });
}

const navigationActions: Array<{ name: string; action: Action }> = [
  { name: "selectTab", action: { type: "selectTab", tab: "teams" } },
  { name: "tabNext", action: { type: "tabNext" } },
  { name: "tabPrev", action: { type: "tabPrev" } },
  // `navigate` is the current deep-link/focus-target action: it changes the
  // active tab while also parking the target for App-side resolution.
  { name: "navigate/focusTarget", action: { type: "navigate", target: { kind: "settings", section: "mcp" } } },
];

describe("transient overlay lifecycle", () => {
  for (const overlay of overlays) {
    for (const navigation of navigationActions) {
      it(`${navigation.name} dismisses ${overlay.name}`, () => {
        let state = overlay.open(initialState);
        expect(overlay.isOpen(state)).toBe(true);
        if (overlay.name === "paletteOpen") {
          state = reduce(state, { type: "paletteQuery", query: "spawn" });
        }
        expectAllClosed(reduce(state, navigation.action));
      });
    }
  }

  it("opening any reducer-owned overlay dismisses the previously-open overlay", () => {
    for (const first of overlays) {
      for (const second of overlays) {
        if (first === second) continue;
        const state = second.open(first.open(initialState));
        expect(first.isOpen(state), `${first.name} should close when ${second.name} opens`).toBe(false);
        expect(second.isOpen(state), `${second.name} should be open`).toBe(true);
      }
    }
  });

  it("preserves the tab's persistent navigation, cursor, and fetched-list state", () => {
    const persistent: UiState = {
      ...initialState,
      teamCursor: 2,
      queueCursor: 3,
      taskCursor: 4,
      selectedAgentId: "agent-1",
      teamDetail: { spec: { name: "team-1" }, running: 0, agents: [] },
      queueDetail: { spec: { name: "queue-1" }, counts: {}, tasks: [] },
      accountList: [{ name: "main" }],
      memoryCursor: 5,
    };
    const closed = reduce(
      reduce(persistent, { type: "paletteOpen", open: true }),
      { type: "selectTab", tab: "projects" },
    );
    expect(closed).toMatchObject({
      teamCursor: 2,
      queueCursor: 3,
      taskCursor: 4,
      selectedAgentId: "agent-1",
      teamDetail: persistent.teamDetail,
      queueDetail: persistent.queueDetail,
      accountList: persistent.accountList,
      memoryCursor: 5,
    });
  });

  it("preserves the target coupled to the newly-opened push, edit, and confirm forms", () => {
    const push = feed(initialState, [
      { type: "accountsOpen", open: true },
      { type: "pushQueue", queue: "queue-1" },
      { type: "setMode", mode: "pushForm" },
    ]);
    expect(push).toMatchObject({ mode: "pushForm", pushQueue: "queue-1", accountsOpen: false });

    const edit = feed(initialState, [
      { type: "helpOpen", open: true },
      { type: "editTask", target: EDIT_TARGET },
      { type: "setMode", mode: "editForm" },
    ]);
    expect(edit).toMatchObject({ mode: "editForm", editTask: EDIT_TARGET, helpOpen: false });

    const confirm = feed(initialState, [
      { type: "paletteOpen", open: true },
      { type: "confirm", confirm: { kind: "stopDaemon" } },
      { type: "setMode", mode: "confirm" },
    ]);
    expect(confirm).toMatchObject({ mode: "confirm", confirm: { kind: "stopDaemon" }, paletteOpen: false });
  });
});
