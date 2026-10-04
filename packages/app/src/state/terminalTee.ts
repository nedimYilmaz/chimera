import { rpcCall } from "../rpc/bridge";

// TERMINAL-READBACK (app half) — tee what the terminal prints to the daemon, so the agent the
// terminal was opened under can read it back (mcp: terminal_read).
//
// The PTY is owned by this app, not the daemon, so without this the agent has no path to it at
// all: the operator runs a build in a tab under an agent and then has to paste the failure back
// in by hand.
//
// BATCHED, because the thing being teed is a byte stream. Catting a large file arrives as hundreds
// of chunks in a few frames, and one RPC per chunk would put the daemon socket under load
// proportional to how fast a shell can print. Flushed on an interval, or early once enough has
// piled up that waiting only grows the payload.
const FLUSH_MS = 500;
const FLUSH_CHARS = 16 * 1024;
// A hard ceiling per terminal between flushes. Something pathological (a spin loop, a binary
// printed to the screen) must cost a bounded amount of memory here, not an unbounded one.
const MAX_PENDING_CHARS = 256 * 1024;

// Chunks, not one growing string. This sits on the RENDER hot path — a full-screen TUI repaints
// the whole grid many times a second — and `text += chunk` reallocates and copies the whole
// buffer every time, so the cost grows with how much has already arrived. Pushing and joining
// once at flush keeps it proportional to the new bytes.
type Pending = { agentId: string; termId: string; title: string; chunks: string[]; chars: number };

const pending = new Map<string, Pending>();
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  timer = null;
  const batch = [...pending.values()];
  pending.clear();
  for (const p of batch) {
    if (!p.chars) continue;
    // Fire and forget. A tee that surfaced errors would turn a daemon hiccup into a
    // broken-looking terminal, and the session does not depend on this succeeding.
    void rpcCall("terminal.append", {
      agentId: p.agentId,
      termId: p.termId,
      ...(p.title ? { title: p.title } : {}),
      text: p.chunks.join(""),
    }).catch(() => { /* readback is best-effort */ });
  }
}

/** Record a chunk of terminal output for `agentId`'s terminal `termId`.
 *
 *  `raw` is the decoded PTY text, escape sequences and all. The DAEMON strips them: this package
 *  does not depend on @chimera/core (the app's layering is protocol/ui-state/client only), and the
 *  stripping belongs with the thing that owns the stored text anyway. */
export function teeTerminalOutput(agentId: string | null | undefined, termId: string, title: string, raw: string): void {
  // A tab with no agent (see TerminalState's doc comment) belongs to nobody, so there is nobody it
  // could ever be read back by.
  if (!agentId) return;
  if (!raw) return;
  const text = raw;
  const key = `${agentId} ${termId}`;
  const cur = pending.get(key) ?? { agentId, termId, title, chunks: [], chars: 0 };
  if (title) cur.title = title;
  cur.chunks.push(text);
  cur.chars += text.length;
  // Drop from the FRONT past the cap: what the agent wants is the tail, and a runaway writer must
  // not be able to grow this without bound between flushes.
  while (cur.chars > MAX_PENDING_CHARS && cur.chunks.length > 1) {
    cur.chars -= cur.chunks.shift()!.length;
  }
  pending.set(key, cur);
  if (cur.chars >= FLUSH_CHARS) {
    if (timer) clearTimeout(timer);
    flush();
    return;
  }
  if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

/** Send whatever is buffered now — the view is going away and the tail is the interesting part. */
export function flushTerminalTee(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  flush();
}
