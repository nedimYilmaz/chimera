// Synthetic browser-only data for scripts/test-ui-browser.mjs. Nothing in this
// fixture reaches a daemon, provider, account, microphone or filesystem path.

export const agentId = "ui-qa-agent";

export const agentRecords = [
  {
    agentId,
    state: "done",
    accountName: "synthetic-codex",
    provider: "codex",
    permissionProfile: "readOnly",
    costUsd: 0.0123,
    createdAt: 100,
    spec: { displayLabel: "UI QA Agent" },
  },
];

export const teams = [
  {
    name: "quality",
    purpose: "Synthetic UI regression fixture",
    maxConcurrent: 2,
    queue: "quality-queue",
    roles: { tester: { role: "tester", overrides: { cwd: "/fixture" } } },
  },
];

export const queues = [
  { name: "quality-queue", retryLimit: 2, paused: false, createdAt: 100 },
  { name: "empty-queue", retryLimit: 1, paused: false, createdAt: 200 },
];

export const queueDetails = {
  "quality-queue": {
    spec: queues[0],
    counts: { pending: 1, blocked: 0, in_progress: 0, done: 0, failed: 0 },
    tasks: [
      {
        taskId: "ui-task-1",
        queue: "quality-queue",
        state: "pending",
        role: "tester",
        priority: 1,
        prompt: "Exercise the isolated browser fixture",
        attempts: 0,
        agentId: null,
        pushedAt: 100,
      },
    ],
  },
  "empty-queue": {
    spec: queues[1],
    counts: { pending: 0, blocked: 0, in_progress: 0, done: 0, failed: 0 },
    tasks: [],
  },
};

export const teamDetail = {
  spec: teams[0],
  running: 0,
  agents: [],
  totalRuns: 0,
};

export const roles = [
  { name: "tester", cwd: "/fixture", permissionProfile: "readOnly", model: "gpt-5.6-sol" },
];

export const voiceMessages = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    role: "assistant",
    text: "Synthetic voice history",
    final: true,
    ts: 1_700_000_000_000,
  },
];

let scheduleRejectors = [];

export function rejectSchedules() {
  const rejectors = scheduleRejectors;
  scheduleRejectors = [];
  for (const reject of rejectors) reject(new Error("synthetic schedule failure"));
}

export function rpcFixture(method, params = {}) {
  switch (method) {
    case "daemon.status":
      return {
        protocolVersion: 1,
        agents: { running: 0, paused: 0, done: 1, failed: 0, killed: 0 },
        accounts: [{ name: "synthetic-codex", provider: "codex" }],
        peers: [],
      };
    case "agent.list": return agentRecords;
    case "agent.tail": return [];
    case "agent.status": return { ...agentRecords[0], spec: { prompt: "Synthetic browser task" } };
    case "team.list": return teams;
    case "team.status": return teamDetail;
    case "queue.list": return queues;
    case "queue.status": return queueDetails[params.queue] ?? queueDetails["quality-queue"];
    case "role.list": return roles;
    case "job.list":
      return new Promise((_, reject) => { scheduleRejectors.push(reject); });
    case "voice.native.history": return { messages: voiceMessages };
    case "voice.native.requests":
    case "workflow.list":
    case "artifact.list":
    case "group.list":
    case "project.list":
    case "accounts.list":
    case "providers.list":
    case "peer.status":
    case "sli.rollup":
      return [];
    default: return [];
  }
}
