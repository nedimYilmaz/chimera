import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type DoctorCheck = { id: string; status: "ok" | "warn" | "error"; message: string };
export type DoctorReport = { version: 1; platform: string; arch: string; checks: DoctorCheck[]; ok: boolean };

/** No daemon, network requests, provider logins, or configuration contents in the report.
 * Messages are a fixed vocabulary: even a malicious binary/config cannot leak secrets
 * into an issue attachment through its stdout, stderr, exception or version string. */
export function collectDoctor(home: string, options: {
  platform?: string; arch?: string; nodeVersion?: string;
  commandAvailable?: (command: string) => boolean;
} = {}): DoctorReport {
  const platform = options.platform ?? process.platform;
  const available = options.commandAvailable ?? ((command: string) => {
    const result = spawnSync(command, ["--version"], { timeout: 3000, stdio: "ignore", windowsHide: true });
    return !result.error && result.status === 0;
  });
  const checks: DoctorCheck[] = [];
  const add = (id: string, status: DoctorCheck["status"], message: string) => checks.push({ id, status, message });
  const major = Number((options.nodeVersion ?? process.versions.node).split(".")[0]);
  add("node", major >= 24 ? "ok" : "error", major >= 24 ? "Node runtime meets the minimum (24)." : "Install Node.js 24 or newer.");
  add("git", available("git") ? "ok" : "error", "Git is required for repository/worktree operations.");
  add("pnpm", available("pnpm") ? "ok" : "warn", "pnpm is needed for source installs, not packaged binaries.");
  add("platform", ["darwin", "linux", "win32"].includes(platform) ? "ok" : "warn", "Check the release support matrix before installing platform-specific packages.");
  const config = join(home, "config.json");
  if (!existsSync(config)) add("config", "warn", "No configuration yet; complete account setup before spawning agents.");
  else {
    try {
      if (statSync(config).size > 4 * 1024 * 1024) throw new Error("size");
      const value: unknown = JSON.parse(readFileSync(config, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
      add("config", "ok", "Configuration is readable JSON (provider credentials are not tested).");
      if (platform !== "win32") add("config-permissions", (statSync(config).mode & 0o077) === 0 ? "ok" : "warn", "Configuration should only be readable by its owner (mode 600).");
    } catch { add("config", "error", "Configuration is unreadable, oversized, or invalid JSON; repair it before starting the daemon."); }
  }
  if (existsSync(home) && platform !== "win32") {
    try { add("home-permissions", (statSync(home).mode & 0o077) === 0 ? "ok" : "warn", "The state directory should be private to its owner (mode 700)."); }
    catch { add("home-permissions", "error", "Cannot inspect the state directory permissions."); }
  }
  return { version: 1, platform, arch: options.arch ?? process.arch, checks, ok: !checks.some(c => c.status === "error") };
}

/** Deliberately whitelist rather than export the report's arbitrary future fields. */
export function supportReport(report: DoctorReport): Record<string, unknown> {
  return {
    format: "chimera-support-v1", platform: report.platform, arch: report.arch,
    ok: report.ok, checks: report.checks.map(({ id, status, message }) => ({ id, status, message })),
    privacy: "No prompts, transcripts, paths, environment values, account names or credentials included.",
  };
}
