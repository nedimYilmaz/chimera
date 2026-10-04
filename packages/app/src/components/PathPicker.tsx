import { forwardRef, useState } from "react";
import styles from "./PathPicker.module.css";

// CWD-PICKER: a text <input> plus an OS-native "browse…" button, dropped in
// wherever a form previously took a raw path (ScheduleFormCard/SpawnCard/
// TeamFormCard's cwd field, ImportCard's source field). Renders as a
// fragment (input + button as siblings, no wrapping box) so it slots
// straight into a caller's existing bordered field wrapper in place of a
// bare <input> — same ref/onFocus/className contract, so the field-walk
// convention those forms share (inputRefs.current[key] = el, onFocus sets
// the active field) keeps working unmodified.
//
// tauri.conf.json sets withGlobalTauri:false, so @tauri-apps/api's own
// isTauri() (which reads globalThis.isTauri, a flag only THAT option
// injects) always reads false here even inside the real desktop shell. The
// low-level __TAURI_INTERNALS__ IPC bridge is injected regardless of that
// setting, so checking for it directly is the reliable synchronous signal.
// The DEV/test harness (rpc/bridge.ts's window.__CHIMERA_MOCK__ seam, or
// vitest's bare node env with no `window` at all) never sets it, so the
// browse button naturally disappears there — no separate fallback branch
// needed.
const isTauriRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const PathPicker = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (value: string) => void;
    mode?: "directory" | "file";
    placeholder?: string;
    dataAttr?: string;
    className?: string;
    disabled?: boolean;
    onFocus?: () => void;
  }
>(function PathPicker(
  { value, onChange, mode = "directory", placeholder, dataAttr, className, disabled, onFocus },
  ref,
) {
  const [busy, setBusy] = useState(false);

  const browse = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        directory: mode === "directory",
        multiple: false,
        defaultPath: value.trim() || undefined,
      });
      if (typeof picked === "string") onChange(picked);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={ref}
        className={className ?? styles.input}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        spellCheck={false}
        data-path-picker={dataAttr}
      />
      {isTauriRuntime ? (
        <button
          type="button"
          className={styles.browse}
          onClick={() => void browse()}
          disabled={disabled || busy}
          data-path-picker-browse={dataAttr}
        >
          browse…
        </button>
      ) : null}
    </>
  );
});
