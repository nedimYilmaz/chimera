import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { AgentResourceSample } from "@chimera/protocol";

export type ProcessExec = (file: string, args: string[]) => Promise<string>;
export const processExec: ProcessExec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: "utf8", timeout: 1500, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
export type ProcessRow = { pid: number; ppid: number; rssBytes: number; elapsedSec: number; cpuSec: number; identity: string; name: string };

export function durationSec(value: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

export function parseProcesses(raw: string): { rows: ProcessRow[]; truncated: boolean } {
  const rows: ProcessRow[] = [];
  let truncated = false;
  for (const line of raw.split("\n")) {
    // lstart is an OS start identity, not argv. It prevents CPU deltas crossing PID reuse.
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const elapsedSec = durationSec(m[4]!); const cpuSec = durationSec(m[5]!);
    if (elapsedSec === null || cpuSec === null || Number(m[1]) < 1) continue;
    if (rows.length >= 20000) { truncated = true; break; }
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssBytes: Number(m[3]) * 1024, elapsedSec, cpuSec, identity: m[6]!.replace(/\s+/g, " "), name: basename(m[7]!).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 128) });
  }
  return { rows, truncated };
}

export function unavailableSample(agentId: string, sampledAt: number, reason: AgentResourceSample["reason"]): AgentResourceSample {
  return { agentId, sampledAt, state: "unavailable", reason, rootPid: null, procs: [], totals: { cpuPct: null, rssBytes: null, procCount: 0 }, truncated: false };
}

export class ProcessTreeSampler {
  private previous = new Map<string, { at: number; rows: Map<number, ProcessRow>; rootIdentity: string; rootPid: number }>();
  // CPU baselines may disappear; an ownership pin cannot silently rebind a reused PID.
  private owners = new Map<string, { pid: number; identity: string; runKey?: string }>();
  constructor(private readonly exec: ProcessExec = processExec, private readonly now = Date.now, private readonly platform: NodeJS.Platform = process.platform) {}
  forget(agentId: string): void { this.previous.delete(agentId); this.owners.delete(agentId); }
  retainOwners(active: ReadonlySet<string>): void {
    for (const id of this.owners.keys()) if (!active.has(id)) this.forget(id);
  }
  async sample(agentId: string, rootPid: number | null, otherRoots: ReadonlySet<number> = new Set(), terminal = false, runKey?: string): Promise<AgentResourceSample> {
    const at = this.now();
    if (this.platform !== "darwin" && this.platform !== "linux") return unavailableSample(agentId, at, "platform");
    const pinned = this.owners.get(agentId);
    if (pinned && pinned.runKey !== runKey) this.forget(agentId);
    if (rootPid === null) { this.previous.delete(agentId); return unavailableSample(agentId, at, "no_process"); }
    let table: ReturnType<typeof parseProcesses>;
    try { table = parseProcesses(await this.exec("ps", ["-axo", "pid=,ppid=,rss=,etime=,time=,lstart=,comm="])); }
    catch (error) { return unavailableSample(agentId, at, (error as { code?: string }).code === "EACCES" || (error as { code?: string }).code === "EPERM" ? "permission" : "sampling"); }
    const root = table.rows.find(p => p.pid === rootPid);
    if (!root) { this.previous.delete(agentId); return unavailableSample(agentId, at, "no_process"); }
    const owner = this.owners.get(agentId);
    if (owner && owner.pid === rootPid && owner.identity !== root.identity) {
      return unavailableSample(agentId, at, "identity");
    }
    // Refuse unknown attribution at the bound; evicting a live pin would manufacture ownership.
    if (!owner && this.owners.size >= 2000) return unavailableSample(agentId, at, "identity");
    this.owners.set(agentId, { pid: rootPid, identity: root.identity, runKey });
    const previous = this.previous.get(agentId);
    const children = new Map<number, ProcessRow[]>();
    for (const row of table.rows) { const list = children.get(row.ppid) ?? []; list.push(row); children.set(row.ppid, list); }
    const visited = new Set<number>(); const procs: AgentResourceSample["procs"] = []; const baseline = new Map<number, ProcessRow>();
    const queue: { row: ProcessRow; depth: number }[] = [{ row: root, depth: 0 }];
    let truncated = table.truncated;
    for (let index = 0; index < queue.length; index++) {
      const { row, depth } = queue[index]!;
      if (visited.has(row.pid) || (row.pid !== rootPid && otherRoots.has(row.pid))) continue;
      if (procs.length >= 2000) { truncated = true; break; }
      visited.add(row.pid); baseline.set(row.pid, row);
      const old = previous?.rootPid === rootPid ? previous.rows.get(row.pid) : undefined;
      const dt = previous ? (at - previous.at) / 1000 : 0;
      const cpuPct = old && dt > 0 && old.identity === row.identity && row.cpuSec >= old.cpuSec ? (row.cpuSec - old.cpuSec) / dt * 100 : null;
      procs.push({ pid: row.pid, ppid: row.ppid, name: row.name, role: row.pid === rootPid ? terminal ? "terminal" : "agent" : "tool", cpuPct, rssBytes: row.rssBytes, elapsedSec: row.elapsedSec });
      const descendants = children.get(row.pid) ?? [];
      if (depth >= 8) { if (descendants.length) truncated = true; }
      else for (const child of descendants) queue.push({ row: child, depth: depth + 1 });
    }
    this.previous.delete(agentId); // insertion order bounds CPU baselines across a large ended fleet
    this.previous.set(agentId, { at, rows: baseline, rootPid, rootIdentity: root.identity });
    if (this.previous.size > 256) this.previous.delete(this.previous.keys().next().value!);
    return { agentId, sampledAt: at, state: "ok", rootPid, procs, totals: { cpuPct: procs.every(p => p.cpuPct !== null) ? procs.reduce((n, p) => n + p.cpuPct!, 0) : null, rssBytes: procs.reduce((n, p) => n + p.rssBytes!, 0), procCount: procs.length }, truncated };
  }
}
