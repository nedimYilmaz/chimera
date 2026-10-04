// VOICE S4 (docs/superpowers/specs/2026-07-24-voice-agents-design.md §5/§10): accumulates
// streamed message_delta text and flushes it in TTS-friendly chunks instead of word-by-word.
// A boundary (. ! ? followed by whitespace, or a bare newline) only cuts once CONFIRMED by a
// trailing character — a lone boundary char at the end of the buffer might just be mid-delta
// (e.g. "3.14" or "Mr." split across deltas), so push() waits for more text before cutting there.
// flush() is the caller's job at message_complete/turn_complete to emit whatever's left.
export class SentenceChunker {
  private buffer = "";

  push(delta: string): string[] {
    this.buffer += delta;
    const chunks: string[] = [];
    for (;;) {
      const cut = this.nextBoundary();
      if (cut === -1) break;
      const chunk = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (chunk) chunks.push(chunk);
    }
    return chunks;
  }

  flush(): string | undefined {
    const remaining = this.buffer.trim();
    this.buffer = "";
    return remaining.length > 0 ? remaining : undefined;
  }

  private nextBoundary(): number {
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch === "\n") return i + 1;
      if (ch === "." || ch === "!" || ch === "?") {
        const next = this.buffer[i + 1];
        if (next === undefined) return -1;   // not yet confirmed — wait for more text
        if (/\s/.test(next)) return i + 1;
      }
    }
    return -1;
  }
}
