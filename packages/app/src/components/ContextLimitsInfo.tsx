import type { CodexContextLimits } from "@chimera/protocol";
import { fmtTokens } from "../state/selectors";

export function ContextLimitsInfo({ limits }: { limits?: CodexContextLimits }) {
  if (!limits) return null;
  return <span data-context-limits title={`Reported by the selected Codex CLI/account. Default window: ${limits.defaultWindow ? fmtTokens(limits.defaultWindow) : "unknown"}. Model maximum is not the active session window. Compaction is a separate setting.`}>
    Active session {limits.sessionWindow ? fmtTokens(limits.sessionWindow) : "unknown"} · requested {limits.requestedWindow ? fmtTokens(limits.requestedWindow) : "default"} · default {limits.defaultWindow ? fmtTokens(limits.defaultWindow) : "unknown"} · Codex max {limits.maxWindow ? fmtTokens(limits.maxWindow) : "unknown"} · compact target {limits.compactAt ? fmtTokens(limits.compactAt) : "auto"}
  </span>;
}
