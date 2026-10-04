// Only choose models advertised by this account. The Codex list already follows
// CLI priority; prefer its frontier family and Claude's newest advertised Opus.
export function preferredProviderModel(provider: string, models: readonly string[], fallback: string): string {
  const flagship = models.filter((model) => provider === "claude"
    ? /^claude-opus-/.test(model)
    : provider === "codex" && /-astra(?:$|-)/.test(model));
  return flagship.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
    ?? models[0] ?? fallback;
}
