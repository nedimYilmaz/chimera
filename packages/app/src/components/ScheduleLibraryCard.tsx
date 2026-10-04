import { useState } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { exportSchedule, importSchedule } from "../state/schedule-library";

export function ScheduleLibraryCard({ source, onSubmit, onClose }: {
  source?: Record<string, unknown>;
  onSubmit: (spec: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState(() => source ? exportSchedule({ ...source, name: `${String(source.name)}-copy` }) : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    try {
      const spec = importSchedule(text);
      setBusy(true);
      await onSubmit(spec);
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return <OverlayCard width={680} align="center" onClose={() => { if (!busy) onClose(); }}>
    <OverlayCardHeader title={source ? "clone schedule" : "import schedule"} hint="Review the name, target and prompt. The copy is always created disabled." />
    <p>Imported commands and prompts are untrusted. Review them before enabling the job. Agent IDs and paths may need changing on another machine.</p>
    <textarea aria-label="schedule JSON" value={text} onChange={e => setText(e.target.value)} disabled={busy} rows={18} style={{ width: "100%" }} />
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? "creating…" : "create disabled copy"}</button>
    <button type="button" disabled={busy} onClick={onClose}>cancel</button>
  </OverlayCard>;
}
