// F09.UI — the ONE vocabulary both cockpits use for a delivered-but-unacknowledged prompt.
// The badge, the tooltip and the two transcript lines are derived here so the app row, the TUI
// row and the transcript can never describe the same stall three different ways (QA U2: the TUI
// badge had dropped `from`, the single most useful disambiguator when a conductor fans out).
import type { AgentView } from "./types.js";

export type PromptStall = NonNullable<AgentView["promptStall"]>;

/** Coarse, operator-facing duration ("45s", "4m", "1h 5m"). Deliberately not seconds-precise past
 *  a minute: this number exists to answer "is this stuck?", and a ticking `4m 13s` reads as
 *  precision the underlying 45s detection threshold does not have. */
export function fmtStallAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest > 0 ? `${h}h ${rest}m` : `${h}h`;
}

/** Live elapsed since the message was delivered, or null when the stall is a `partial` (a
 *  boolean-only agent.list snapshot on a fresh client, which carries no timestamp). QA U1: the
 *  badge used to paint promptStall.sinceMs — a one-shot snapshot — so a ten-minute stall read
 *  "45s" forever. A number that looks live and is not is worse than no number at all. */
export function promptStallAgeMs(stall: PromptStall, now: number): number | null {
  if (stall.partial || !stall.sinceTs) return null;
  return Math.max(0, now - stall.sinceTs);
}

/** Row badge. "start unconfirmed" (never "unacked"/"not acknowledged") because missing start evidence does not prove
 *  that the provider lost the message; startup or native compaction may be silent. */
export function promptStallBadge(stall: PromptStall, now: number): string {
  const age = promptStallAgeMs(stall, now);
  return age === null ? "⚠ start unconfirmed" : `⚠ start unconfirmed ${fmtStallAge(age)}`;
}

/** The long form: app tooltip + the TUI footer hint. Names the sender and the one control. */
export function promptStallDetail(stall: PromptStall, now: number): string {
  const age = promptStallAgeMs(stall, now);
  const who = stall.from ? ` from ${stall.from}` : "";
  const when = age === null ? "" : ` ${fmtStallAge(age)} ago`;
  return `prompt${who} delivered${when} — no turn-start confirmation yet. Startup or context compaction may still be running; resending can repeat the message.`;
}

/** The transcript line pushed when core reports the stall (reducer, agent_prompt_stalled). */
export function promptStallOpenLine(from: string, sinceMs: number): string {
  const who = from ? ` from ${from}` : "";
  return `prompt start unconfirmed: delivered${who} ${fmtStallAge(sinceMs)} ago, no turn-start confirmation yet`;
}

/** The transcript line pushed when the stall clears — the daemon-side event that would otherwise
 *  be invisible (the badge simply vanished, leaving no record that it ever resolved). */
export function promptStallClearLine(from: string, ackMs: number | null): string {
  const who = from ? ` from ${from}` : "";
  // A partial (fresh-client) stall carries no sinceTs, so there is no honest duration to quote —
  // say the prompt was picked up rather than print an epoch-sized "480000h".
  if (ackMs === null) return `prompt picked up: the agent started a turn on the message${who}`;
  return `prompt picked up: the agent started a turn ${fmtStallAge(ackMs)} after the message${who} was delivered`;
}
