import { JobSpecSchema } from "@chimera/protocol";
import { computeSchedulePreview, type ScheduleFormValues, type JobRunView } from "./selectors.jobs";

/** Strip runtime ledger fields, but preserve every spec option, including options
 * that the compact form does not expose. Copies never execute merely by importing. */
export function portableSchedule(raw: Record<string, unknown>): Record<string, unknown> {
  const parsed = JobSpecSchema.strip().parse(raw);
  // A temporary hold belongs to the original job, not a portable definition.
  const { snoozedUntil: _snooze, ...definition } = parsed;
  return { ...definition, enabled: false };
}
export function exportSchedule(raw: Record<string, unknown>): string {
  return JSON.stringify({ format: "chimera-schedule-v1", spec: portableSchedule(raw) }, null, 2);
}
export function importSchedule(text: string): Record<string, unknown> {
  if (text.length > 256_000) throw new Error("Schedule import exceeds 256 KB.");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a schedule object.");
  const envelope = value as Record<string, unknown>;
  if (envelope.format !== "chimera-schedule-v1" || !envelope.spec || typeof envelope.spec !== "object" || Array.isArray(envelope.spec)) throw new Error("Expected chimera-schedule-v1 format.");
  return portableSchedule(envelope.spec as Record<string, unknown>);
}
export function upcomingScheduleRuns(values: ScheduleFormValues, now: number, count = 5): number[] {
  const times: number[] = [];
  let cursor = now;
  for (let i = 0; i < Math.min(10, Math.max(0, count)); i++) {
    const preview = computeSchedulePreview(values, cursor);
    if (preview.error || preview.nextRunTs === null || preview.nextRunTs <= cursor) break;
    times.push(preview.nextRunTs);
    cursor = preview.nextRunTs;
    if (values.scheduleKind === "at") break;
  }
  return times;
}
export function filterScheduleRuns(runs: JobRunView[], outcome: string, query: string): JobRunView[] {
  const needle = query.trim().toLocaleLowerCase();
  return runs.filter(run => (outcome === "all" || run.result === outcome)
    && (!needle || [run.agentId, run.taskId, run.error, run.reason, run.trigger].some(value => value?.toLocaleLowerCase().includes(needle))));
}
