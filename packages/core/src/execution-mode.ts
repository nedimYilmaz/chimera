import type { AgentSpec } from "@chimera/protocol";

/** Native Claude review and Chimera tool restrictions remain independent. Other
 * runtimes use explicit access presets as part of their mode contract. */
export function modeProfile(provider: string, mode: AgentSpec["executionMode"], current: AgentSpec["permissionProfile"]): AgentSpec["permissionProfile"] {
  if (!mode || mode === "execute" || provider === "claude") return current;
  if (mode === "plan") return "readOnly";
  return mode === "bypassPermissions" || provider === "kimi" ? "full" : "acceptEdits";
}
