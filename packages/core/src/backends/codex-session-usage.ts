import { glob, open } from "node:fs/promises";
import { join } from "node:path";

export type CodexUsage = {
  input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number;
  output_tokens: number; reasoning_output_tokens: number;
};
export const emptyCodexUsage = (): CodexUsage => ({ input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
export function codexUsage(value: unknown): CodexUsage | null {
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).input_tokens !== "number") return null;
  const result = emptyCodexUsage();
  for (const key of Object.keys(result) as Array<keyof CodexUsage>) {
    const n = Number((value as Record<string, unknown>)[key] ?? 0);
    result[key] = Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  return result;
}
export function codexUsageDelta(total: CodexUsage, baseline: CodexUsage): CodexUsage {
  const result = emptyCodexUsage();
  for (const key of Object.keys(result) as Array<keyof CodexUsage>) result[key] = total[key] >= baseline[key] ? total[key] - baseline[key] : total[key];
  return result;
}

// Exec's JSON stream reports session totals, not the latest model request. Its
// local rollout is the source of last_token_usage. Read only this UUID's file,
// incrementally and with bounded buffers; missing/new storage formats stay unknown.
export class CodexSessionUsage {
  private path: string | undefined;
  private offset = 0;
  private remainder = "";
  private nextLookup = 0;
  private snapshot: { context: CodexUsage | null; total: CodexUsage | null; window?: number } = { context: null, total: null };
  constructor(private home: string, private id: string, private since = Date.now()) {}

  async read(forceLookup = false): Promise<typeof this.snapshot & { compactions: number }> {
    let compactions = 0;
    try {
      if (!this.path && (forceLookup || Date.now() >= this.nextLookup) && /^[0-9a-f-]{36}$/i.test(this.id)) {
        this.nextLookup = Date.now() + 1_000;
        for await (const path of glob(join(this.home, "sessions", "*", "*", "*", `*${this.id}.jsonl`))) { this.path = path; break; }
      }
      if (!this.path) return { ...this.snapshot, compactions };
      const file = await open(this.path, "r");
      try {
        const { size } = await file.stat();
        if (size < this.offset) { this.offset = 0; this.remainder = ""; this.snapshot = { context: null, total: null }; }
        const start = Math.max(this.offset, size - 1024 * 1024);
        const skipped = start > this.offset;
        const buffer = Buffer.alloc(size - start);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
        this.offset = start + bytesRead;
        const lines = ((skipped ? "" : this.remainder) + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
        this.remainder = lines.pop() ?? "";
        if (skipped) lines.shift();
        for (const line of lines) {
          // Never retain or emit transcript text from the rollout.
          if (!line.includes('"token_count"') && !line.includes('"compacted"')) continue;
          try {
            const row = JSON.parse(line);
            if (row.type === "compacted") {
              this.snapshot.context = null;
              if (Date.parse(row.timestamp) >= this.since) compactions++;
            }
            if (row.type !== "event_msg" || row.payload?.type !== "token_count" || !row.payload.info) continue;
            const info = row.payload.info;
            this.snapshot = { context: codexUsage(info.last_token_usage), total: codexUsage(info.total_token_usage),
              ...(Number.isFinite(info.model_context_window) && info.model_context_window > 0 ? { window: info.model_context_window } : {}) };
          } catch { /* A partial or future record is not a token measurement. */ }
        }
      } finally { await file.close(); }
    } catch { /* Telemetry must never prevent the agent from doing its work. */ }
    return { ...this.snapshot, compactions };
  }
}
