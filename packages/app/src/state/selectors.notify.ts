// W20 (F18 notifications, coverage B22/C16) — PURE selectors/formatters for
// the notification rules card. No React, no store, no rpc imports — same
// discipline as selectors.host.ts/selectors.settings.ts.
import type { NotifyRule } from "@chimera/protocol";

// ---------------------------------------------------------------------------
// rules table rows (mock showNotifRules: rule · channel · throttle · ●/○)
// ---------------------------------------------------------------------------

export type NotifyRuleRow = {
  name: string;
  kindLabel: string;
  filterLabel: string | null;
  channel: NotifyRule["channel"];
  channelLabel: string;
  throttleLabel: string;
  enabled: boolean;
};

/** The mock's lowercase-with-spaces event label for the rule's `on.kind` —
 * falls back to the bare kind (underscores → spaces) for a kind this list
 * doesn't special-case (on.kind is a free string, NotifyRuleSchema by design). */
export function kindLabel(kind: string): string {
  switch (kind) {
    case "permission_request": return "permission pending";
    case "agent_question": return "question pending";
    case "job_run_finished": return "job failed";
    case "budget_warning": return "budget ≥80%";
    case "peer_partitioned": return "peer partitioned";
    default: return kind.replace(/_/g, " ");
  }
}

const CHANNEL_LABELS: Record<NotifyRule["channel"], string> = {
  os: "os notification",
  toast: "toast",
  a2a: "a2a → main",
  webhook: "webhook",
};

/** "60s" → "1/min", "3600s" → "1/hr", else "Ns" (mock: 1/min · 1/hr · instant). */
export function fmtThrottle(sec: number): string {
  if (sec <= 0) return "instant";
  if (sec === 60) return "1/min";
  if (sec === 3600) return "1/hr";
  if (sec % 60 === 0) return `1/${sec / 60}min`;
  return `${sec}s`;
}

/** A rule's filter as a terse "k=v, k2=v2" hint (null when there is none). */
export function filterLabel(filter: Record<string, unknown> | undefined): string | null {
  if (!filter) return null;
  const parts = Object.entries(filter).map(([k, v]) => `${k}=${String(v)}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

export function buildNotifyRows(rules: readonly NotifyRule[]): NotifyRuleRow[] {
  return rules.map((r) => ({
    name: r.name,
    kindLabel: kindLabel(r.on.kind),
    filterLabel: filterLabel(r.on.filter),
    channel: r.channel,
    channelLabel: r.channel === "webhook" && r.webhookUrl ? `webhook ${webhookHost(r.webhookUrl)}` : CHANNEL_LABELS[r.channel],
    throttleLabel: fmtThrottle(r.throttleSec),
    enabled: r.enabled,
  }));
}

function webhookHost(url: string): string {
  try {
    return `#${new URL(url).host}`;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// deep link routing (spec: "clicking a notification focuses the exact surface
// — the ⚠ card, the job row, the peers table…"). Pure — the caller (bridge)
// dispatches the store actions; this only decides WHERE.
// ---------------------------------------------------------------------------

export type NotifyDeepLink =
  | { tab: "agents"; agentId: string }
  | { tab: "queues"; jobName: string }
  | { tab: "settings"; section: "network" }
  | null;

/** `job:<name>` (JobScheduler's event agentId, jobs.ts) → the bare job name. */
export function jobNameFromAgentId(agentId: string): string | null {
  return agentId.startsWith("job:") ? agentId.slice("job:".length) : null;
}

/** Maps a notify payload's {kind, agentId} (the SAMPLE event's own fields —
 * core's NotifyEvaluator.deliver) to the surface a click should land on. */
export function deepLinkFor(kind: string, agentId: string): NotifyDeepLink {
  switch (kind) {
    case "permission_request":
    case "agent_question":
    case "budget_warning":
      return { tab: "agents", agentId };
    case "job_run_finished": {
      const jobName = jobNameFromAgentId(agentId);
      return jobName ? { tab: "queues", jobName } : null;
    }
    case "peer_partitioned":
      return { tab: "settings", section: "network" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// dock badge (spec: "badge = pending permissions + questions")
// ---------------------------------------------------------------------------

export function pendingBadgeCount(state: {
  pendingPermissions: readonly { requestId: string }[];
  agentOrder: readonly string[];
  agents: Readonly<Record<string, { pendingQuestion?: unknown } | undefined>>;
}): number {
  let questions = 0;
  for (const id of state.agentOrder) if (state.agents[id]?.pendingQuestion) questions++;
  return state.pendingPermissions.length + questions;
}
