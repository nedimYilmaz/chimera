import { open, readdir, realpath, stat, lstat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { ShadowActivity } from "@chimera/protocol/contract";
import { parseTranscript } from "./workflow-inspect.js";
import { readWorkflowSnapshot } from "./workflow-snapshot.js";

export type ShadowTranscriptContext = {
  taskId: string; sessionId?: string; configDir: string; cwd: string;
  toolUseId?: string; skipTranscript?: boolean;
};
const safeId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);
const MAX_BYTES = 2 * 1024 * 1024;

// A request never supplies a path. Resolve only within the account and session that
// spawned this shadow; names/types are not identities (parallel reviewers share them).
export async function locateShadowTranscript(context: ShadowTranscriptContext, innerIds: string[] = []): Promise<{ source: "workflow" | "subagent"; path: string; snapshot?: NonNullable<Awaited<ReturnType<typeof readWorkflowSnapshot>>> } | null> {
  if (context.skipTranscript || !context.sessionId || !safeId(context.sessionId) || !safeId(context.taskId)) return null;
  const projects = join(context.configDir, "projects");
  const preferred = context.cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const candidates = [preferred, ...(await readdir(projects).catch(() => [])).filter(x => x !== preferred).slice(0, 2000)];
  for (const project of candidates) {
    const root = join(projects, project, context.sessionId, "subagents");
    const sessionPath = join(projects, project, context.sessionId);
    if ((await lstat(sessionPath).catch(() => null))?.isSymbolicLink()) continue;
    const session = await containedPath(projects, sessionPath);
    if (!session) continue;
    const snapshots = await containedPath(session, join(session, "workflows"));
    if (snapshots) for (const name of (await readdir(snapshots)).filter(x => /^wf_[\w-]+\.json$/.test(x)).slice(0, 2000)) {
      const path = await containedPath(snapshots, join(snapshots, name));
      if (!path) continue;
      const snapshot = await readWorkflowSnapshot(path).catch(() => null);
      if (snapshot?.taskId !== context.taskId || !safeId(snapshot.runId)) continue;
      // A resumed task can have a completed snapshot from its previous run. Fresh
      // live agent ids must not resolve to that old run's transcript directory.
      if (innerIds.length && !snapshot.agents.some(a => innerIds.includes(a.agentId))) continue;
      // The run id and task id differ. This exact binding is what lets automatic
      // push-gate workflows be inspected before their parent receives a tool result.
      return { source: "workflow", path: join(root, "workflows", snapshot.runId), snapshot };
    }
    const realRoot = await containedPath(session, root);
    if (!realRoot) continue;
    // Live workflow_progress binds inner agent ids to this task before the completed
    // snapshot exists. Locate their one run directory within this session only.
    const workflows = await containedPath(realRoot, join(realRoot, "workflows"));
    if (workflows && innerIds.length) {
      const matches: string[] = [];
      for (const name of (await readdir(workflows)).filter(x => /^wf_[\w-]+$/.test(x)).slice(0, 2000)) {
        const dir = await containedPath(workflows, join(workflows, name));
        if (!dir) continue;
        for (const id of innerIds.filter(safeId).slice(0, 50)) {
          if (await containedPath(dir, join(dir, `agent-${id}.jsonl`))) { matches.push(dir); break; }
        }
      }
      if (matches.length === 1) return { source: "workflow", path: matches[0]! };
    }
    const workflow = await containedPath(realRoot, join(realRoot, "workflows", context.taskId));
    if (workflow && (await stat(workflow)).isDirectory()) return { source: "workflow", path: workflow };
    const direct = await containedPath(realRoot, join(realRoot, `agent-${context.taskId}.jsonl`));
    if (direct) return { source: "subagent", path: direct };
    // Older task ids can differ from the transcript's agent id. The spawning tool id
    // in the SDK sidecar is the only safe fallback; never pick "the newest reviewer".
    if (context.toolUseId) {
      for (const name of (await readdir(realRoot)).filter(x => /^agent-[\w-]+\.meta\.json$/.test(x)).slice(0, 2000)) {
        const path = await containedPath(realRoot, join(realRoot, name));
        if (!path) continue;
        try {
          const meta = JSON.parse((await readBoundedTail(path, 64 * 1024)).text);
          if (meta.toolUseId !== context.toolUseId) continue;
          const transcript = await containedPath(realRoot, join(realRoot, name.replace(/\.meta\.json$/, ".jsonl")));
          if (transcript) return { source: "subagent", path: transcript };
        } catch { /* A sidecar may still be being written. */ }
      }
    }
  }
  return null;
}

export async function containedPath(root: string, path: string): Promise<string | null> {
  try {
    const [base, file] = await Promise.all([realpath(root), realpath(path)]);
    const rel = relative(base, file);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? file : null;
  } catch { return null; }
}

export async function readBoundedTail(path: string, limit = MAX_BYTES): Promise<{ text: string; truncated: boolean; mtimeMs: number }> {
  const file = await open(path, "r");
  try {
    const s = await file.stat();
    if (!s.isFile()) throw new Error("transcript is not a regular file");
    const start = Math.max(0, s.size - limit);
    const buf = Buffer.alloc(Math.min(s.size, limit));
    const { bytesRead } = await file.read(buf, 0, buf.length, start);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, truncated: start > 0, mtimeMs: s.mtimeMs };
  } finally { await file.close(); }
}

export function transcriptActivity(text: string, truncated: boolean, mtimeMs: number): ShadowActivity {
  let lastTool: string | null = null;
  let steps: ShadowActivity["steps"] = [];
  for (const line of text.split("\n")) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(row?.message?.content)) continue;
    for (const b of row.message.content) {
      if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
      lastTool = b.name;
      // TodoWrite is a complete, explicitly reported plan. Do not derive a percent
      // from tool calls: one tool call need not correspond to one unit of work.
      if (b.name === "TodoWrite" && Array.isArray(b.input?.todos)) {
        steps = b.input.todos.flatMap((t: any) => typeof t?.content === "string" && ["pending", "in_progress", "completed"].includes(t.status)
          ? [{ title: t.content.slice(0, 2000), status: t.status }] : []).slice(0, 200);
      }
    }
  }
  return { lastTool, steps, lastActivityTs: mtimeMs, truncated };
}

export async function inspectSubagentFile(path: string, tailLines = 200) {
  const { text, truncated, mtimeMs } = await readBoundedTail(path);
  const lines = parseTranscript(text);
  return {
    transcript: lines.slice(-tailLines),
    activity: { ...transcriptActivity(text, truncated, mtimeMs), truncated: truncated || lines.length > tailLines },
  };
}
