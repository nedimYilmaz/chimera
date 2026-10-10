/** Native Claude settings and Chimera's injected MCP grant are independent. */
export function nativeMcpPatch(enabled: boolean): { strictMcpConfig: boolean; loadSettings?: boolean } {
  return enabled ? { strictMcpConfig: false, loadSettings: true } : { strictMcpConfig: true };
}

export function nativeMcpSelection(spec: Record<string, unknown>): "on" | "off" | "" {
  const options = spec.providerOptions as Record<string, unknown> | undefined;
  const strict = options?.strictMcpConfig ?? spec.strictMcpConfig;
  if (strict === true) return "off";
  const sources = (spec.inherit as { settingSources?: string[] } | undefined)?.settingSources;
  if (strict === false && (spec.loadSettings === true
    || spec.loadSettings !== false && sources?.includes("user") && sources.includes("project"))) return "on";
  // An unset strict flag follows daemon policy, which the saved spec does not contain.
  return "";
}
