// SHADOW-WORKFLOW-VISIBILITY: on-demand parsing of a workflow's on-disk transcript directory.
//
// A Workflow tool run writes, under <transcriptDir>:
//   - journal.jsonl        — one {type:"started"|"result", key, agentId, result?} record per
//                            inner agent (the cache/resume ledger; verified as the ONLY schema
//                            across every workflow dir on disk — no label/phase/prompt fields).
//   - agent-<id>.jsonl     — that inner agent's full SDK transcript (user/assistant/tool records
//                            with message.content + ISO timestamp).
//   - agent-<id>.meta.json — {agentType, spawnDepth?, model?}.
//
// Everything here is line-tolerant: a truncated trailing line (a workflow still writing) or any
// non-JSON line is skipped, never thrown. The roster path deliberately avoids reading each inner
// agent's (often multi-hundred-KB) transcript in full — it reads only a bounded prefix for the
// label and stats the file for the last-activity time — because the UI polls this while a shadow
// row is selected. The full transcript is read only for the single drilled-into inner agent.

import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Parse the "Transcript dir:" / "Run ID:" lines a Workflow tool_result prints, so the supervisor
// can stash the on-disk location on the workflow's shadow record. Tolerant of surrounding text and
// either ordering; a leading ~ is expanded to the daemon user's home.
export function parseWorkflowTranscriptRef(text: string): { dir?: string; runId?: string } {
  // Capture the dir to END-OF-LINE (not `\S+`), so a transcript path under a home directory
  // containing a space (e.g. "/Users/John Doe/...") isn't truncated to a non-existent path. The
  // run id has no spaces, so `\S+` is correct there.
  const dir = /Transcript dir:[ \t]*(.+?)[ \t]*$/im.exec(text)?.[1];
  const runId = /Run ID:\s*(\S+)/i.exec(text)?.[1];
  return { ...(dir ? { dir: expandHome(dir) } : {}), ...(runId ? { runId } : {}) };
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

type JournalEntry = { state: "running" | "done"; resultPreview: string | null };

// Fold journal.jsonl into per-inner-agent state. A "result" record marks the agent "done" and
// captures a flattened preview of its return value (first result wins).
export function parseJournal(text: string): Map<string, JournalEntry> {
  const out = new Map<string, JournalEntry>();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
    const agentId = typeof o["agentId"] === "string" ? o["agentId"] : undefined;
    if (!agentId) continue;
    const prev = out.get(agentId) ?? { state: "running" as const, resultPreview: null };
    if (o["type"] === "result") {
      prev.state = "done";
      if (prev.resultPreview === null) prev.resultPreview = previewOf(o["result"]);
    }
    out.set(agentId, prev);
  }
  return out;
}

export function parseMeta(text: string): { agentType: string | null; spawnDepth: number | null; model: string | null } {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    return {
      agentType: typeof o["agentType"] === "string" ? o["agentType"] : null,
      spawnDepth: typeof o["spawnDepth"] === "number" ? o["spawnDepth"] : null,
      model: typeof o["model"] === "string" ? o["model"] : null,
    };
  } catch { return { agentType: null, spawnDepth: null, model: null }; }
}

export type ParsedTranscriptLine = { role: "user" | "assistant" | "tool" | "system"; text: string; ts: number | null };

// Flatten an inner agent's agent-<id>.jsonl into display lines. Each SDK record's message.content
// (a string or a block array) becomes: text blocks -> the line text; a tool_use block -> "⚙ <name>";
// a tool_result block -> "↳ <preview>". Line-tolerant (a partial trailing line is skipped).
export function parseTranscript(text: string): ParsedTranscriptLine[] {
  const out: ParsedTranscriptLine[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
    const ts = tsOf(o["timestamp"]);
    const msg = o["message"];
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const role: ParsedTranscriptLine["role"] = m["role"] === "assistant" ? "assistant" : m["role"] === "user" ? "user" : "system";
    const content = m["content"];
    if (typeof content === "string") {
      const s = content.trim();
      if (s) out.push({ role, text: s, ts });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      const blk = b as Record<string, unknown>;
      if (blk["type"] === "text" && typeof blk["text"] === "string") {
        const s = blk["text"].trim();
        if (s) out.push({ role, text: s, ts });
      } else if (blk["type"] === "tool_use" && typeof blk["name"] === "string") {
        out.push({ role: "tool", text: `⚙ ${blk["name"]}`, ts });
      } else if (blk["type"] === "tool_result") {
        const rt = toolResultPreview(blk["content"]);
        if (rt) out.push({ role: "tool", text: rt, ts });
      }
    }
  }
  return out;
}

// The first user line IS the inner agent's prompt (no discrete label is written on disk), so it
// doubles as the roster label. Flattened + truncated to one short line.
export function firstPromptLabel(lines: ParsedTranscriptLine[], max = 120): string | null {
  const first = lines.find((l) => l.role === "user");
  if (!first) return null;
  const flat = first.text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export type ParsedInnerAgent = {
  agentId: string; agentType: string | null; label: string | null;
  state: "running" | "done"; resultPreview: string | null;
  lastActivityTs: number | null; spawnDepth: number | null; model: string | null;
};

export type InspectResult = {
  agents: ParsedInnerAgent[];
  transcript: ParsedTranscriptLine[] | null;
};

// Read + assemble the whole inspect view for one workflow dir. Throws only if the dir itself is
// unreadable (readdir) — the caller degrades that to available:false; every per-file read inside
// is individually tolerant.
export async function inspectWorkflowDir(
  dir: string,
  opts: { innerAgentId?: string; tailLines?: number } = {},
): Promise<InspectResult> {
  const entries = await readdir(dir);
  const journalText = await readFileSafe(join(dir, "journal.jsonl"));
  const journal = journalText !== null ? parseJournal(journalText) : new Map<string, JournalEntry>();

  // Roster = union of meta-file ids (authoritative — every spawned inner agent has one) and any
  // journal id (belt-and-suspenders for a race where the meta file lags the journal record).
  const ids = new Set<string>();
  for (const f of entries) {
    if (f.startsWith("agent-") && f.endsWith(".meta.json")) ids.add(f.slice("agent-".length, -".meta.json".length));
  }
  for (const id of journal.keys()) ids.add(id);

  const agents: ParsedInnerAgent[] = [];
  for (const id of ids) {
    const meta = parseMeta((await readFileSafe(join(dir, `agent-${id}.meta.json`))) ?? "");
    // Bounded prefix read (not the whole transcript) — enough to capture the first user prompt.
    const prefix = await readFilePrefix(join(dir, `agent-${id}.jsonl`), 64 * 1024);
    const label = prefix !== null ? firstPromptLabel(parseTranscript(prefix)) : null;
    const j = journal.get(id);
    agents.push({
      agentId: id,
      agentType: meta.agentType,
      label,
      state: j?.state ?? "running",
      resultPreview: j?.resultPreview ?? null,
      lastActivityTs: await mtimeOf(join(dir, `agent-${id}.jsonl`)),
      spawnDepth: meta.spawnDepth,
      model: meta.model,
    });
  }
  // Newest activity first — a running agent that just moved is what an operator wants at the top.
  agents.sort((a, b) => (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0));

  let transcript: ParsedTranscriptLine[] | null = null;
  if (opts.innerAgentId) {
    // Only serve a transcript for an inner agent that actually appears in this run's roster.
    // Besides being correct (you can only drill into a real inner agent), gating on the
    // discovered `ids` set means the request-supplied `innerAgentId` never reaches the path join
    // unvalidated — a defense-in-depth guard against a `../`-style traversal even though this RPC
    // is local-only and off both the peer and agent-MCP surfaces.
    if (ids.has(opts.innerAgentId)) {
      const text = await readFileSafe(join(dir, `agent-${opts.innerAgentId}.jsonl`));
      const n = opts.tailLines ?? 200;
      transcript = text !== null ? parseTranscript(text).slice(-n) : [];
    } else {
      transcript = [];
    }
  }
  return { agents, transcript };
}

function previewOf(result: unknown, max = 500): string | null {
  if (result === undefined || result === null) return null;
  let s: string | null;
  if (typeof result === "string") s = result;
  else { try { s = JSON.stringify(result); } catch { s = null; } }
  if (s === null) return null;
  const flat = s.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function toolResultPreview(content: unknown, max = 200): string | null {
  let s: string | null = null;
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) {
    s = content
      .map((b) => (b && typeof b === "object" && (b as Record<string, unknown>)["type"] === "text" ? String((b as Record<string, unknown>)["text"] ?? "") : ""))
      .filter(Boolean)
      .join(" ");
  }
  if (!s) return null;
  const flat = s.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return `↳ ${flat.length > max ? `${flat.slice(0, max)}…` : flat}`;
}

function tsOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Date.parse(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

async function readFileSafe(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch { return null; }
}

async function readFilePrefix(path: string, maxBytes: number): Promise<string | null> {
  try {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  } catch { return null; }
}

async function mtimeOf(path: string): Promise<number | null> {
  try { return (await stat(path)).mtimeMs; } catch { return null; }
}
