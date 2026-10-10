import { useState } from "react";
import { ScheduleFormCard } from "../../src/components/ScheduleFormCard";
import { ScheduleDetail } from "../../src/components/ScheduleDetail";
import { defaultScheduleFormValues, jobRow, scheduleFormValuesFromSpec } from "../../src/state/selectors.jobs";

const spec = { name: "echo-once", enabled: true, schedule: { at: 100049 }, tz: "UTC", target: { command: 'echo "OK"', timeoutMs: 30000, env: { MODE: "kept" } }, nextRunTs: null, lastRuns: [] };
export const scheduleCommandFixture = { saved: [] as Record<string, unknown>[], plans: [] as Record<string, unknown>[] };
export function ScheduleCommandProbe() {
  const [open, setOpen] = useState(true);
  const [create, setCreate] = useState(false);
  return <>
    <button data-new-command onClick={() => { setCreate(true); setOpen(true); }}>New command job</button>
    <ScheduleDetail row={jobRow(spec)} spec={spec} now={Date.now()} />
    {open && <ScheduleFormCard key={String(create)} mode={create ? "create" : "edit"} initial={create ? { ...defaultScheduleFormValues(), name: "new-command", targetKind: "command" } : scheduleFormValuesFromSpec(spec)} onClose={() => setOpen(false)} onSubmit={async payload => { scheduleCommandFixture.saved.push(payload); }} />}
  </>;
}
