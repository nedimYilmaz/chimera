import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// FILEBROWSER-T8 gate: the Files section (FileTree) is wired into
// ProjectsScreen's DetailBody between the checkpoints section and the
// PanelFooter — a structural check that (1) the files section renders once a
// project is selected, (2) the sessions body (.sessBody) stays the ONLY
// flex:1 grower (files/checkpoints are flex-shrink:0 siblings), same
// Collapse-fill layout contract the checkpoints section already holds.

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const PROJECT = { name: "demo", path: "/tmp/demo", origin: null, teams: [], queue: null, sessions: 0, archived: false };

// PROJECT-DELETE-UI: toggled per-test so the SAME rpcImpl can drive both the
// success path and the {code:"conflict"} refusal without a second mock.
let deleteConflict = false;
let projectArchived = false;
let checkpointsSupported = false;
let worktreeSetup: { command: string; timeoutSec: number; enabled: boolean } | null = null;

const rpcImpl = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  if (method === "project.list") return [{ ...PROJECT, archived: projectArchived }];
  if (method === "project.status") {
    return {
      spec: { name: "demo", path: "/tmp/demo", archived: projectArchived, teams: ["dev"], worktreeSetup },
      sessions: [],
      teams: [{ name: "dev", running: 0 }],
    };
  }
  if (method === "project.setSetupHook") {
    worktreeSetup = (params as { hook: typeof worktreeSetup }).hook;
    return {};
  }
  if (method === "checkpoint.status") return checkpointsSupported ? { supported: true, count: 0, latest: null } : { supported: false };
  if (method === "checkpoint.list") return [];
  if (method === "checkpoint.create") return {};
  if (method === "project.unarchive") { projectArchived = false; return { ...PROJECT, archived: false }; }
  if (method === "team.list") return [{ name: "dev", roles: { worker: { provider: "claude" } } }];
  if (method === "agent.spawn") return { agentId: "spawned-worker" };
  if (method === "project.delete") {
    if (deleteConflict) throw Object.assign(new Error('project "demo" has 1 live session(s) under /tmp/demo — kill or finish them before deleting'), { code: "conflict" });
    return { deleted: true };
  }
  if (method === "fs.list") {
    const p = (params as { path: string }).path;
    if (p === "") return { path: "", entries: [{ name: "README.md", kind: "file", sizeBytes: 10, gitStatus: null }], truncated: false };
    return { path: p, entries: [], truncated: false };
  }
  return [];
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  readArtifactSnapshot: vi.fn(async () => ""),
  openArtifactSnapshot: vi.fn(async () => {}),
  openArtifactUrl: vi.fn(async () => {}),
  setDockBadge: vi.fn(async () => {}),
  exportCsv: vi.fn(async () => ""),
  checkpointFilesSince: vi.fn(async () => 0),
}));

import { ProjectsScreen, hookCommandProblem } from "../src/screens/ProjectsScreen";
import { projectsLocal } from "../src/state/commands.projects";
import { runAction } from "../src/keymap";
import { appStore } from "../src/state/store";
import styles from "../src/screens/ProjectsScreen.module.css";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

// A never-unmounted renderer from a prior test stays subscribed and keeps
// re-registering keymap handlers — same zombie-render hazard FileTree.test.tsx
// guards against. Track the one live renderer per test and always unmount it.
let mounted: ReturnType<typeof create> | null = null;

beforeEach(() => {
  rpcImpl.mockClear();
  projectsLocal.reset();
  deleteConflict = false;
  projectArchived = false;
  checkpointsSupported = false;
  worktreeSetup = null;
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("ProjectsScreen — Files section wiring (FILEBROWSER-T8)", () => {
  it("renders the files section under a selected project's detail pane, sessions body remains the sole grower", async () => {
    act(() => {
      mounted = create(React.createElement(ProjectsScreen));
    });
    await flush();
    await flush();

    const root = mounted!.root;

    // the files section is present, mounted as a sibling of the sessions
    // body and checkpoints — not nested inside either.
    const filesSections = root.findAll((n) => n.props["className"] === styles.filesSection);
    expect(filesSections).toHaveLength(1);

    const filesBodies = root.findAll((n) => n.props["className"] === styles.filesBody);
    expect(filesBodies).toHaveLength(1);

    // the file tree itself rendered inside — the lazily-fetched root listing.
    const fileRows = root.findAll((n) => "data-project-file-row" in n.props);
    expect(fileRows.map((r) => r.props["data-project-file-row"])).toEqual(["README.md"]);

    // the sessions body is the only flex:1 grower — files/checkpoints stay
    // flex-shrink:0 per ProjectsScreen.module.css (asserted via class identity,
    // not the raw CSS, since jsdom/react-test-renderer never applies stylesheets).
    const sessBodies = root.findAll((n) => n.props["className"] === styles.sessBody);
    expect(sessBodies).toHaveLength(1);
  });
});

describe("PROJECT-DELETE-UI — delete confirm flow", () => {
  it("mod+shift+x (projects.delete) opens the confirm card for the selected project", async () => {
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();

    act(() => runAction("projects.delete", appStore));

    const root = mounted!.root;
    // react-test-renderer exposes both the ChipButton component and its native button
    // with forwarded props. Count the accessible control, not both React tree layers.
    expect(root.findAll((n) => n.type === "button" && n.props["data-confirm"] !== undefined)).toHaveLength(1);
    expect(projectsLocal.getState().confirmDelete).toBe("demo");
  });

  it("the detail header's delete chip opens the SAME confirm gate", async () => {
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();

    const root = mounted!.root;
    const chip = root.find((n) => "data-delete-project" in n.props);
    act(() => chip.props.onClick());

    expect(projectsLocal.getState().confirmDelete).toBe("demo");
  });

  it("confirms WITHOUT deleteFiles by default — project.delete carries no deleteFiles key", async () => {
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();
    act(() => runAction("projects.delete", appStore));

    const root = mounted!.root;
    act(() => root.find((n) => n.props["data-confirm"] !== undefined).props.onClick());
    await flush();

    const call = rpcImpl.mock.calls.find(([m]) => m === "project.delete");
    expect(call?.[1]).toEqual({ name: "demo" });
    // success closes the gate and refetches the list
    expect(projectsLocal.getState().confirmDelete).toBeNull();
  });

  it("toggling 'also delete files on disk' shows the warning and rides deleteFiles:true", async () => {
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();
    act(() => runAction("projects.delete", appStore));

    const root = mounted!.root;
    act(() => root.find((n) => "data-delete-files-toggle" in n.props).props.onClick());
    expect(root.findAll((n) => "data-delete-files-warning" in n.props)).toHaveLength(1);

    act(() => root.find((n) => n.props["data-confirm"] !== undefined).props.onClick());
    await flush();

    const call = rpcImpl.mock.calls.find(([m]) => m === "project.delete");
    expect(call?.[1]).toEqual({ name: "demo", deleteFiles: true });
  });

  it("on {code:'conflict'} the daemon's message renders INLINE and the gate stays open (no retry)", async () => {
    deleteConflict = true;
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();
    act(() => runAction("projects.delete", appStore));

    const root = mounted!.root;
    act(() => root.find((n) => n.props["data-confirm"] !== undefined).props.onClick());
    await flush();

    expect(projectsLocal.getState().confirmDelete).toBe("demo");   // gate stays open
    const errorNodes = root.findAll((n) => "data-delete-error" in n.props);
    expect(errorNodes).toHaveLength(1);
    expect(String(errorNodes[0]!.props["children"])).toMatch(/live session/);
    expect(rpcImpl.mock.calls.filter(([m]) => m === "project.delete")).toHaveLength(1);   // no retry
  });
});

describe("ProjectsScreen mouse action affordances", () => {
  it("archive chip dispatches projects.archive and opens the existing confirm gate", async () => {
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();

    const chip = mounted!.root.findByProps({ "data-project-action": "projects.archive" });
    act(() => chip.props.onClick());

    expect(projectsLocal.getState().confirmArchive).toBe("demo");
  });

  it("clicking a team chip dispatches projects.run for that team", async () => {
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();

    const chip = mounted!.root.findByProps({ "data-team-chip": "dev" });
    act(() => chip.props.onClick());
    await flush();

    expect(rpcImpl.mock.calls).toContainEqual([
      "agent.spawn",
      {
        spec: {
          provider: "claude",
          prompt: "[project demo] worker: work in /tmp/demo — review the repo state and take up your role's next task.",
          cwd: "/tmp/demo",
          isolation: "none",
        },
        membership: { team: "dev", role: "worker" },
      },
    ]);
  });

  it("an archived project exposes project_unarchive and invokes the palette-only action", async () => {
    projectArchived = true;
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();

    const chip = mounted!.root.findByProps({ "data-project-action": "project_unarchive" });
    act(() => chip.props.onClick());
    await flush();

    expect(rpcImpl).toHaveBeenCalledWith("project.unarchive", { name: "demo" });
  });

  it("supported repos expose checkpoint now before the first checkpoint exists", async () => {
    checkpointsSupported = true;
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();

    expect(projectsLocal.getState().detail?.checkpoints).toEqual([]);
    const chip = mounted!.root.findByProps({ "data-project-action": "checkpoint_create" });
    act(() => chip.props.onClick());
    await flush();

    expect(rpcImpl).toHaveBeenCalledWith("checkpoint.create", { cwd: "/tmp/demo", trigger: "manual" });
  });
});

describe("F26: worktree setup hook row", () => {
  it("renders 'unset' when no hook is configured, clicking opens the inline editor", async () => {
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();

    const toggle = mounted!.root.findByProps({ "data-worktree-setup-hook": "unset" });
    expect(String(toggle.props["children"])).toContain("no worktree setup hook");

    act(() => toggle.props.onClick());
    const input = mounted!.root.findByProps({ "data-worktree-setup-hook-input": true });
    expect(input).toBeDefined();
  });

  it("submitting a command in the inline editor sets the hook enabled", async () => {
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();

    act(() => mounted!.root.findByProps({ "data-worktree-setup-hook": "unset" }).props.onClick());
    const input = mounted!.root.findByProps({ "data-worktree-setup-hook-input": true });
    act(() => input.props.onKeyDown({ key: "Enter", currentTarget: { value: "npm i" } }));
    await flush();

    expect(rpcImpl).toHaveBeenCalledWith("project.setSetupHook", {
      project: "demo",
      // A hook created from the app must inherit the SCHEMA default (300s), not a tighter
      // app-local literal — see the WHY on hookTimeoutSec in ProjectsScreen.tsx.
      hook: { command: "npm i", timeoutSec: 300, enabled: true },
    });
  });

  it("renders 'on' state with the command visible once a hook is configured", async () => {
    worktreeSetup = { command: "node scripts/setup.mjs", timeoutSec: 120, enabled: true };
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();

    const toggle = mounted!.root.findByProps({ "data-worktree-setup-hook": "on" });
    expect(String(toggle.props["children"])).toContain("worktree setup hook");
    const commandSpan = mounted!.root.findByProps({ "data-worktree-setup-hook-command": true });
    expect(String(commandSpan.props["children"])).toBe("node scripts/setup.mjs");
  });

  it("clicking the 'on' toggle disables (not clears) the hook", async () => {
    worktreeSetup = { command: "npm i", timeoutSec: 120, enabled: true };
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();

    act(() => mounted!.root.findByProps({ "data-worktree-setup-hook": "on" }).props.onClick());
    await flush();

    expect(rpcImpl).toHaveBeenCalledWith("project.setSetupHook", {
      project: "demo",
      hook: { command: "npm i", timeoutSec: 120, enabled: false },
    });
  });

  it("submitting an empty command clears the hook", async () => {
    worktreeSetup = { command: "npm i", timeoutSec: 120, enabled: true };
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();

    act(() => mounted!.root.findByProps({ "data-worktree-setup-hook-command": true }).props.onClick());
    const input = mounted!.root.findByProps({ "data-worktree-setup-hook-input": true });
    act(() => input.props.onKeyDown({ key: "Enter", currentTarget: { value: "  " } }));
    await flush();

    expect(rpcImpl).toHaveBeenCalledWith("project.setSetupHook", { project: "demo", hook: null });
  });
});

describe("F26.UI: worktree setup hook row — validation, pause safety, single-shot edits", () => {
  const setupCalls = () => rpcImpl.mock.calls.filter(([m]) => m === "project.setSetupHook");

  it("editing the command of a PAUSED hook keeps it paused (QA gap 3)", async () => {
    worktreeSetup = { command: "npm i", timeoutSec: 300, enabled: false };
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();

    expect(mounted!.root.findByProps({ "data-worktree-setup-hook-paused": true })).toBeDefined();
    act(() => mounted!.root.findByProps({ "data-worktree-setup-hook-command": true }).props.onClick());
    const input = mounted!.root.findByProps({ "data-worktree-setup-hook-input": true });
    act(() => input.props.onKeyDown({ key: "Enter", currentTarget: { value: "npm ci" } }));
    await flush();

    expect(rpcImpl).toHaveBeenCalledWith("project.setSetupHook", {
      project: "demo",
      hook: { command: "npm ci", timeoutSec: 300, enabled: false },
    });
  });

  it("Escape cancels even if the engine then fires blur, and Enter+blur writes exactly once (QA gap 4)", async () => {
    worktreeSetup = { command: "npm i", timeoutSec: 300, enabled: true };
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();

    act(() => mounted!.root.findByProps({ "data-worktree-setup-hook-command": true }).props.onClick());
    const escInput = mounted!.root.findByProps({ "data-worktree-setup-hook-input": true });
    // Grab the handlers BEFORE Escape unmounts the input — that unmount is exactly the moment a
    // real browser can still dispatch blur at the detaching node, which is the bug under test.
    const escKeyDown = escInput.props.onKeyDown;
    const escBlur = escInput.props.onBlur;
    act(() => escKeyDown({ key: "Escape", currentTarget: { value: "rm -rf /" } }));
    act(() => escBlur({ currentTarget: { value: "rm -rf /" } }));
    await flush();
    expect(setupCalls()).toHaveLength(0);

    act(() => mounted!.root.findByProps({ "data-worktree-setup-hook-command": true }).props.onClick());
    const okInput = mounted!.root.findByProps({ "data-worktree-setup-hook-input": true });
    const okKeyDown = okInput.props.onKeyDown;
    const okBlur = okInput.props.onBlur;
    act(() => okKeyDown({ key: "Enter", currentTarget: { value: "npm ci" } }));
    act(() => okBlur({ currentTarget: { value: "npm ci" } }));
    await flush();
    expect(setupCalls()).toHaveLength(1);
  });

  it("rejects a shell-metachar command in place: no RPC, editor stays open, reason rendered", async () => {
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();

    act(() => mounted!.root.findByProps({ "data-worktree-setup-hook": "unset" }).props.onClick());
    const input = mounted!.root.findByProps({ "data-worktree-setup-hook-input": true });
    act(() => input.props.onKeyDown({ key: "Enter", currentTarget: { value: "npm i && npm test" } }));
    await flush();

    expect(setupCalls()).toHaveLength(0);
    expect(mounted!.root.findByProps({ "data-worktree-setup-hook-input": true })).toBeDefined();
    const err = mounted!.root.findByProps({ "data-worktree-setup-hook-error": true });
    expect(String(err.props["children"])).toContain("no shell here");
  });

  it("the timeout chip edits timeoutSec and refuses a value outside the schema's 1–900", async () => {
    worktreeSetup = { command: "npm i", timeoutSec: 300, enabled: true };
    act(() => { mounted = create(React.createElement(ProjectsScreen)); });
    await flush();
    await flush();

    const chip = mounted!.root.findByProps({ "data-worktree-setup-hook-timeout": true });
    expect(chip.props["children"].join("")).toBe("300s timeout");
    act(() => chip.props.onClick());
    const input = mounted!.root.findByProps({ "data-worktree-setup-hook-timeout-input": true });
    act(() => input.props.onKeyDown({ key: "Enter", currentTarget: { value: "901" } }));
    await flush();
    expect(setupCalls()).toHaveLength(0);
    expect(String(mounted!.root.findByProps({ "data-worktree-setup-hook-error": true }).props["children"])).toContain("1–900");

    act(() => mounted!.root.findByProps({ "data-worktree-setup-hook-timeout-input": true }).props.onKeyDown({ key: "Enter", currentTarget: { value: "60" } }));
    await flush();
    expect(rpcImpl).toHaveBeenCalledWith("project.setSetupHook", {
      project: "demo",
      hook: { command: "npm i", timeoutSec: 60, enabled: true },
    });
  });

  it("hookCommandProblem accepts a quoted argument but rejects redirects and over-long commands", () => {
    expect(hookCommandProblem('node scripts/setup.mjs --tag "my tag"')).toBeNull();
    expect(hookCommandProblem("npm i > log.txt")).toContain("no shell here");
    expect(hookCommandProblem(`node ${"x".repeat(2000)}`)).toContain("too long");
  });
});
