export type CodexCommand = { name: "compact" } | { name: "goal"; action: "get" | "clear" | "set"; objective?: string; status?: "active" | "paused" };

// Slash commands belong to the CLI UI, not turn/start's text input.
export function parseCodexCommand(text: string): CodexCommand {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1], args = match?.[2]?.trim() ?? "";
  if (name === "compact") {
    if (args) throw new Error("Codex /compact does not accept instructions through app-server");
    return { name: "compact" };
  }
  if (name !== "goal") throw new Error(`/${name ?? ""} is not supported by Chimera's Codex command bridge. Use /goal or /compact; use agent settings for model/effort and the native CLI for terminal-only commands. Nothing was sent as a prompt.`);
  if (!args) return { name: "goal", action: "get" };
  if (args === "clear") return { name: "goal", action: "clear" };
  if (args === "pause" || args === "resume") return { name: "goal", action: "set", status: args === "pause" ? "paused" : "active" };
  if (args === "edit") throw new Error("Use /goal edit <objective> to edit the goal in Chimera");
  const objective = args.startsWith("edit ") ? args.slice(5).trim() : args;
  if (!objective || objective.length > 4000) throw new Error("Codex goal objectives must contain 1–4000 characters");
  return { name: "goal", action: "set", objective, status: "active" };
}
