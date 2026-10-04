import { Codex } from "@openai/codex-sdk";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch { return false; }
}

// The SDK has no public binary resolver. Keep its optional private-field probe
// isolated so a future SDK change still falls back to installed CLI discovery.
export function resolveCodexSdkCliPath(): string | null {
  try {
    const sdk = new Codex() as unknown as { exec?: { executablePath?: unknown } };
    const path = sdk.exec?.executablePath;
    return typeof path === "string" && executable(path) ? path : null;
  } catch { return null; }
}

export function resolveCodexBinary(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string {
  const override = env.CHIMERA_CODEX_CLI_PATH;
  // launchd pins the install-time CLI path. Switching from npm/nvm to the
  // standalone installer removes that file while leaving the service env stale.
  // Preserve valid overrides (and command names), but recover from missing paths.
  if (override && (!/[\\/]/.test(override) || executable(override))) return override;
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  const directories = [
    dirname(execPath),
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    // GUI services usually omit the standalone installer's directory from PATH.
    join(env.HOME || env.USERPROFILE || homedir(), ".local", "bin"),
  ];
  for (const directory of directories) {
    const candidate = join(directory, name);
    if (executable(candidate)) return candidate;
  }
  return resolveCodexSdkCliPath() ?? "codex";
}
