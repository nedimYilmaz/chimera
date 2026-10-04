import { homedir } from "node:os";
import { join } from "node:path";

export function chimeraHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHIMERA_HOME || join(homedir(), ".chimera");
}

/** Windows IPC endpoints are named pipes, not filesystem socket files.
 * FNV-1a is only a stable short namespace, never an authentication mechanism.
 * Keep the algorithm in sync with the desktop Rust bridge. */
export function daemonEndpoint(home: string, platform: string = process.platform): string {
  if (platform !== "win32") return join(home, "daemon.sock");
  const normalized = home.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(normalized, "utf8")) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `\\\\.\\pipe\\chimera-${hash.toString(16).padStart(16, "0")}`;
}
