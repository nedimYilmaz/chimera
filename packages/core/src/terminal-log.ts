// TERMINAL-READBACK — what an agent's terminals have printed, so the agent can read them.
//
// The PTY belongs to the DESKTOP APP (src-tauri/pty.rs); the daemon never sees it. So this is a
// sink the app tees into, and the only place an agent-facing read can be served from.
//
// IN MEMORY, deliberately. A terminal does not outlive the app that owns its PTY, so persisting
// its output would leave a file describing a session nobody can attach to — while the question
// this answers ("what did that command print?") is about a session you still have.
//
// Bounded twice over, because a terminal is the one input here with no natural size: a build log
// or a runaway loop produces megabytes a second, and an unbounded buffer would be an
// out-of-memory bug reachable from a shell prompt.

/** Per terminal. ~256 KB is a long build log, and a bounded cost per open terminal. */
const MAX_CHARS_PER_TERM = 256 * 1024;
/** Per agent, so one agent with many tabs is not unbounded in aggregate. */
const MAX_TERMS_PER_AGENT = 16;
const DEFAULT_READ_LIMIT = 20_000;

export type TerminalRecord = {
  termId: string;
  title: string | null;
  text: string;
  /** True once anything has been dropped off the FRONT — the reader is looking at a tail. */
  truncated: boolean;
  startedAt: number;
  lastAt: number;
};

export type TerminalReadOptions = { termId?: string | undefined; limit?: number | undefined };

export class TerminalLog {
  private byAgent = new Map<string, Map<string, TerminalRecord>>();
  // TERMINAL-WRITE: which tab the operator is looking at, per agent. The daemon cannot know this —
  // it is a fact about the app's UI — so the app reports it, and it is kept here because this is
  // already the daemon's model of an agent's terminals. Without it "write to the terminal" would
  // have to mean "guess", and guessing wrong types a command into the wrong shell.
  private activeByAgent = new Map<string, string>();

  constructor(private now: () => number = Date.now) {}

  append(agentId: string, termId: string, text: string, title?: string): void {
    if (!text) return;
    let terms = this.byAgent.get(agentId);
    if (!terms) { terms = new Map(); this.byAgent.set(agentId, terms); }
    let rec = terms.get(termId);
    if (!rec) {
      // Evict the least recently WRITTEN terminal rather than refusing the new one: the tab just
      // opened is the one about to be asked about.
      if (terms.size >= MAX_TERMS_PER_AGENT) {
        let oldest: TerminalRecord | undefined;
        for (const r of terms.values()) if (!oldest || r.lastAt < oldest.lastAt) oldest = r;
        if (oldest) terms.delete(oldest.termId);
      }
      const at = this.now();
      rec = { termId, title: title ?? null, text: "", truncated: false, startedAt: at, lastAt: at };
      terms.set(termId, rec);
    }
    // A title rides along with output and a later chunk may omit it — never blank an established one.
    if (title) rec.title = title;
    rec.text += text;
    if (rec.text.length > MAX_CHARS_PER_TERM) {
      rec.text = rec.text.slice(rec.text.length - MAX_CHARS_PER_TERM);
      rec.truncated = true;
    }
    rec.lastAt = this.now();
  }

  /** The tail of one terminal, or of every terminal this agent has, oldest terminal first. */
  read(agentId: string, opts: TerminalReadOptions = {}): TerminalRecord[] {
    const terms = this.byAgent.get(agentId);
    if (!terms) return [];
    const limit = opts.limit ?? DEFAULT_READ_LIMIT;
    const picked = opts.termId
      ? [terms.get(opts.termId)].filter((r): r is TerminalRecord => !!r)
      : [...terms.values()];
    return picked
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((r) => {
        const clipped = r.text.length > limit;
        return {
          ...r,
          text: clipped ? r.text.slice(r.text.length - limit) : r.text,
          // Either bound having bitten means the same thing to the reader: this is not the start.
          truncated: r.truncated || clipped,
        };
      });
  }

  setActive(agentId: string, termId: string): void {
    this.activeByAgent.set(agentId, termId);
  }

  /** Name a tab, CREATING the record if it has printed nothing yet.
   *
   *  A silent tab still has to be addressable: the operator opens one, names it, and tells an
   *  agent to run something there before anything has been written to it. Without this, resolve()
   *  would not find it and the write would be refused for a tab that plainly exists. */
  setTitle(agentId: string, termId: string, title: string): void {
    let terms = this.byAgent.get(agentId);
    if (!terms) { terms = new Map(); this.byAgent.set(agentId, terms); }
    const rec = terms.get(termId);
    if (rec) { rec.title = title; return; }
    const at = this.now();
    terms.set(termId, { termId, title, text: "", truncated: false, startedAt: at, lastAt: at });
  }

  /** Resolve what an agent means by a terminal.
   *
   *  `ref` matches a term id or a tab NAME — names are what a model can actually hold on to, and
   *  terminal_read hands both back. Without a ref this is the tab the operator is looking at,
   *  falling back to the most recently written one (the app has not reported focus yet, but the
   *  agent still means "the terminal"). Null when the agent has none. */
  resolve(agentId: string, ref?: string): string | null {
    const terms = this.byAgent.get(agentId);
    if (!terms || terms.size === 0) return null;
    if (ref) {
      if (terms.has(ref)) return ref;
      for (const r of terms.values()) if (r.title === ref) return r.termId;
      // A ref that matches nothing is NOT quietly redirected to the active tab: the caller named a
      // specific terminal, and writing into a different one is worse than not writing.
      return null;
    }
    const active = this.activeByAgent.get(agentId);
    if (active && terms.has(active)) return active;
    let newest: TerminalRecord | undefined;
    // `>=`, not `>`: two terminals written in the same millisecond tie, and Map iteration is
    // insertion order — so a strict `>` would hand back the OLDEST of the tied ones, which is the
    // opposite of what "most recent" means. Reachable in practice: a fresh tab's first output
    // often lands in the same tick as the previous tab's.
    for (const r of terms.values()) if (!newest || r.lastAt >= newest.lastAt) newest = r;
    return newest?.termId ?? null;
  }

  /** AGENT-FORGET: cleaning up an agent drops its terminal output along with everything else. */
  forgetAgent(agentIds: readonly string[]): number {
    let removed = 0;
    for (const id of agentIds) {
      this.activeByAgent.delete(id);
      if (this.byAgent.delete(id)) removed++;
    }
    return removed;
  }
}

// Built from escape sequences rather than written as regex literals: the patterns match CONTROL
// bytes, and a source file containing them raw is one a grep, a diff or a review renders as
// invisible damage.
const OSC = new RegExp("\\u001b\\][^\\u0007]*(?:\\u0007|\\u001b\\\\)?", "g");
const CSI = new RegExp("\\u001b\\[[0-?]*[ -\\/]*[@-~]", "g");
const ESC_PAIR = new RegExp("\\u001b[@-Z\\\\\\-_]", "g");
// Everything else non-printing, KEEPING the three that carry meaning as text: TAB, LF, CR.
const CTRL = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]", "g");

/** Strip what a RENDERER would have consumed, leaving what was on the screen.
 *
 *  The consumer is a model reading output, so escape sequences are noise that also costs tokens.
 *  Carriage returns are resolved the way a terminal resolves them — a bare CR rewrites the current
 *  line, which is how every progress bar works. Keeping the raw form would turn one spinner into
 *  thousands of near-identical lines and bury whatever came after it. */
export function stripTerminalText(raw: string): string {
  const flat = raw
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(ESC_PAIR, "")
    .replace(CTRL, "")
    // A CR that is part of CRLF is line structure, not a rewrite.
    .replace(/\r\n/g, "\n");
  return flat
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      // Last write wins per column, which is what the screen would be showing.
      let out = "";
      for (const part of line.split("\r")) out = part.length >= out.length ? part : part + out.slice(part.length);
      return out;
    })
    .join("\n");
}
