import { describe, expect, it } from "vitest";
import type { InboxItem } from "@chimera/ui-state";
import {
  inboxRowAgentLabel,
  inboxRowDetail,
  inboxRowGlyph,
  inboxRowTitle,
  inboxSections,
  URGENCY_SECTION_TITLE,
} from "../src/state/selectors.inbox";

const permissionItem: InboxItem = {
  id: "permission:r1", kind: "permission", urgency: "blocking", ts: 1,
  agentId: "a1", permission: { requestId: "r1", agentId: "a1", toolName: "Bash", input: { cmd: "ls" }, ts: 1 },
};
const questionItem: InboxItem = {
  id: "question:q1", kind: "question", urgency: "blocking", ts: 2,
  agentId: "a2", question: { questionId: "q1", prompt: "pick a color", multiSelect: false, freeform: false, ts: 2, agentId: "a2" },
};
const approvalItem: InboxItem = {
  id: "approval:q2", kind: "approval", urgency: "blocking", ts: 3,
  agentId: "a3", question: {
    questionId: "q2", prompt: "ship it?", multiSelect: false, freeform: false, ts: 3, gate: "approval", agentId: "a3",
    options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
  },
};
const failedItem: InboxItem = {
  id: "task_failed:t1", kind: "task_failed", urgency: "waiting", ts: 4,
  task: { taskId: "t1", queue: "work", state: "failed", agentId: null, attempts: 1, priority: 0, error: "boom", subject: "fix flaky test", updatedAt: 4 },
};
const blockedItem: InboxItem = {
  id: "task_blocked:t2", kind: "task_blocked", urgency: "fyi", ts: 5,
  task: { taskId: "t2", queue: "work", state: "blocked", agentId: null, attempts: 0, priority: 0, subject: "ship release", updatedAt: 5 },
};

describe("inboxRowTitle", () => {
  it("titles each kind distinctly", () => {
    expect(inboxRowTitle(permissionItem)).toBe("Permission: Bash");
    expect(inboxRowTitle(questionItem)).toBe("pick a color");
    expect(inboxRowTitle(approvalItem)).toBe("Approval: ship it?");
    expect(inboxRowTitle(failedItem)).toBe("Task failed: fix flaky test");
    expect(inboxRowTitle(blockedItem)).toBe("Task blocked: ship release");
  });
});

describe("inboxRowDetail", () => {
  it("shows the tool input for a permission, the failure reason for a failed task, a queue hint for a blocked task", () => {
    expect(inboxRowDetail(permissionItem)).toBe('{"cmd":"ls"}');
    expect(inboxRowDetail(failedItem)).toBe("boom");
    expect(inboxRowDetail(blockedItem)).toContain("work");
  });
  it("omits a redundant detail line for question/approval (the prompt IS the title)", () => {
    expect(inboxRowDetail(questionItem)).toBeNull();
    expect(inboxRowDetail(approvalItem)).toBeNull();
  });
});

describe("inboxRowGlyph", () => {
  it("gives permission/task_failed distinct danger-leaning tones from a plain question", () => {
    expect(inboxRowGlyph(permissionItem).tone).toBe("warn");
    expect(inboxRowGlyph(failedItem).tone).toBe("danger");
    expect(inboxRowGlyph(blockedItem).tone).toBe("muted");
  });
});

describe("inboxRowAgentLabel", () => {
  it("falls back to a short id when the agent isn't (yet) projected into state.agents", () => {
    expect(inboxRowAgentLabel({ agents: {} }, "abcdefgh12345")).toBe("abcdefgh");
  });
  it("returns null for a null/undefined agentId (an unpicked task)", () => {
    expect(inboxRowAgentLabel({ agents: {} }, null)).toBeNull();
    expect(inboxRowAgentLabel({ agents: {} }, undefined)).toBeNull();
  });
});

describe("inboxSections", () => {
  it("groups by urgency tier in blocking/waiting/fyi order, omitting empty tiers", () => {
    const sections = inboxSections([permissionItem, questionItem, failedItem]);
    expect(sections.map((s) => s.urgency)).toEqual(["blocking", "waiting"]);
    expect(sections[0]!.title).toBe(URGENCY_SECTION_TITLE.blocking);
    expect(sections[0]!.items).toEqual([permissionItem, questionItem]);
    expect(sections[1]!.items).toEqual([failedItem]);
  });
  it("returns no sections for an empty item list", () => {
    expect(inboxSections([])).toEqual([]);
  });
});
