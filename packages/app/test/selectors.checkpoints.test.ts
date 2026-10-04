import { describe, expect, it } from "vitest";
import type { CheckpointRecord } from "@chimera/protocol";
import { checkpointLabel, checkpointRow, latestCheckpointSeq, resolveCheckpointCwd, triggerLabel } from "../src/state/selectors.checkpoints";

const rec = (over: Partial<CheckpointRecord> = {}): CheckpointRecord => ({
  id: "3",
  ref: "refs/chimera/checkpoints/3",
  trigger: "manual",
  ts: 1_700_000_000_000,
  agentId: "a1",
  taskId: null,
  message: "chimera checkpoint: manual",
  ...over,
});

describe("checkpointRow", () => {
  it("projects the wire fields it renders, verbatim", () => {
    expect(checkpointRow(rec())).toEqual({
      id: "3",
      ref: "refs/chimera/checkpoints/3",
      trigger: "manual",
      ts: 1_700_000_000_000,
      message: "chimera checkpoint: manual",
    });
  });
});

describe("checkpointLabel", () => {
  it("prefixes the bare ref sequence number, mock style", () => {
    expect(checkpointLabel("3")).toBe("cp-3");
  });
});

describe("triggerLabel", () => {
  it("manual carries its own chord hint", () => {
    expect(triggerLabel(checkpointRow(rec({ trigger: "manual" })))).toBe("manual (mod+k)");
  });

  it("task_start is a bare label", () => {
    expect(triggerLabel(checkpointRow(rec({ trigger: "task_start", message: "chimera checkpoint: task start" })))).toBe("task start");
  });

  it("destructive_bash surfaces the guarded command from the commit message", () => {
    const row = checkpointRow(rec({
      trigger: "destructive_bash",
      message: 'chimera checkpoint: before destructive command "pnpm build"',
    }));
    expect(triggerLabel(row)).toBe("before Bash: pnpm build");
  });

  it("destructive_bash falls back gracefully with no quoted command in the message", () => {
    const row = checkpointRow(rec({ trigger: "destructive_bash", message: "chimera checkpoint: before destructive command" }));
    expect(triggerLabel(row)).toBe("before a destructive command");
  });
});

describe("latestCheckpointSeq", () => {
  it("returns 0 when no checkpoint event has landed", () => {
    expect(latestCheckpointSeq([{ seq: 1, kind: "status" }])).toBe(0);
  });

  it("finds the newest checkpoint_created/_reverted seq, ignoring unrelated kinds after it", () => {
    const events = [
      { seq: 1, kind: "checkpoint_created" },
      { seq: 2, kind: "status" },
      { seq: 3, kind: "checkpoint_reverted" },
      { seq: 4, kind: "status" },
    ] as const;
    expect(latestCheckpointSeq(events)).toBe(3);
  });
});

describe("resolveCheckpointCwd", () => {
  const projects = [{ name: "chimera", path: "/repo/chimera" }, { name: "other", path: "/repo/other" }];

  it("resolves a project.path when projectId matches a known project — worktree agents show their PROJECT's checkpoints", () => {
    expect(resolveCheckpointCwd({ projectId: "chimera", cwd: "/repo/.chimera/worktrees/abc" }, projects)).toBe("/repo/chimera");
  });

  it("falls back to the raw cwd when projectId doesn't match any known project (stale/renamed)", () => {
    expect(resolveCheckpointCwd({ projectId: "ghost", cwd: "/somewhere" }, projects)).toBe("/somewhere");
  });

  it("falls back to the raw cwd when no projectId is present (non-project agent / older daemon)", () => {
    expect(resolveCheckpointCwd({ projectId: null, cwd: "/somewhere" }, projects)).toBe("/somewhere");
    expect(resolveCheckpointCwd({ cwd: "/somewhere" }, projects)).toBe("/somewhere");
  });

  it("a null cwd with no resolvable project stays null", () => {
    expect(resolveCheckpointCwd({ projectId: null, cwd: null }, projects)).toBeNull();
  });
});
