import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// FEATURE MAIN-CONDUCTOR-PERSISTENT: the ONE persisted pointer to the daemon-owned MAIN
// conductor's agentId — a single global seat, unlike ProjectStore's per-project
// conductorId. Same discipline as ProjectStore/TeamManager (parse-on-load, fail-fast on
// corruption, write-to-temp-then-rename), just for a single scalar value instead of a
// keyed collection. Persisted at $CHIMERA_HOME/main-conductor.json so it survives a
// daemon restart independently of state.json (which only snapshots the supervisor's
// live agent roster, not this kind of durable cross-boot pointer).
export class MainConductorStore {
  private conductorId: string | null = null;
  private file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "main-conductor.json");
    if (existsSync(this.file)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(this.file, "utf8"));
      } catch (err) {
        throw new Error(
          `corrupt coordination state in ${this.file}: ${(err as Error).message} — fix or remove the file and restart chimerad`,
        );
      }
      const conductorId = (parsed as { conductorId?: unknown } | null)?.conductorId;
      this.conductorId = typeof conductorId === "string" ? conductorId : null;
    }
  }

  get(): string | null {
    return this.conductorId;
  }

  // Idempotent — setting the same value is a no-op (no wasted write), mirroring
  // ProjectStore.setConductorId's dedupe.
  set(conductorId: string | null): void {
    if (this.conductorId === conductorId) return;
    this.conductorId = conductorId;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ conductorId }, null, 2));
    renameSync(tmp, this.file);
  }
}
