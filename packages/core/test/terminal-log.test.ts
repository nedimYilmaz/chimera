import { describe, expect, it } from "vitest";
import { TerminalLog, stripTerminalText } from "@chimera/core/terminal-log";

// TERMINAL-READBACK — the operator opens a terminal under an agent and runs things in it. That
// output was visible to them and invisible to the agent, so "why did that fail?" could only be
// answered by pasting the screen back in.
//
// The PTY belongs to the desktop app, so this is the sink the app tees into. Two things matter and
// neither is "does it store text": it must be BOUNDED (the input is a byte stream a shell produces
// faster than anything here consumes it) and it must be SCOPED (one agent's terminal is not
// another's).
//
// Control bytes are written as escapes, never literally: a test file carrying raw ESC is one a
// grep, a diff or a review renders as invisible damage.
const ESC = "\u001b";
const BEL = "\u0007";

describe("TerminalLog", () => {
  it("keeps what a terminal printed, per agent", () => {
    const log = new TerminalLog();
    log.append("a", "t1", "hello ", "build");
    log.append("a", "t1", "world");
    const [rec] = log.read("a");
    expect(rec?.text).toBe("hello world");
    expect(rec?.title).toBe("build");
    expect(rec?.truncated).toBe(false);
  });

  it("never returns another agent's terminal", () => {
    const log = new TerminalLog();
    log.append("a", "t1", "mine");
    log.append("b", "t1", "theirs");
    expect(log.read("a").map((r) => r.text)).toEqual(["mine"]);
    expect(log.read("nobody")).toEqual([]);
  });

  it("can be asked for one terminal out of several", () => {
    const log = new TerminalLog();
    log.append("a", "t1", "one");
    log.append("a", "t2", "two");
    expect(log.read("a", { termId: "t2" }).map((r) => r.text)).toEqual(["two"]);
    expect(log.read("a", { termId: "absent" })).toEqual([]);
    expect(log.read("a")).toHaveLength(2);
  });

  it("keeps the TAIL when a terminal outruns its cap, and says so", () => {
    // The bound is the point: a build log or a runaway loop must cost a fixed amount of memory.
    // Unbounded here would be an out-of-memory bug reachable from a shell prompt.
    const log = new TerminalLog();
    log.append("a", "t1", "x".repeat(300 * 1024) + "END");
    const [rec] = log.read("a", { limit: 200_000 });
    expect(rec!.text.length).toBeLessThanOrEqual(256 * 1024);
    expect(rec!.text.endsWith("END")).toBe(true);
    expect(rec!.truncated).toBe(true);
  });

  it("reports truncation when the READ clipped it, not only when the store did", () => {
    // Both bounds mean the same thing to the reader — this is not the start of the output — so a
    // clipped read must not report untruncated just because the store still had it all.
    const log = new TerminalLog();
    log.append("a", "t1", "abcdefghij");
    expect(log.read("a", { limit: 200 })[0]!.truncated).toBe(false);
    const [clipped] = log.read("a", { limit: 4 });
    expect(clipped!.text).toBe("ghij");
    expect(clipped!.truncated).toBe(true);
  });

  it("caps how many terminals one agent can hold, dropping the least recently written", () => {
    const log = new TerminalLog();
    for (let i = 0; i < 20; i++) log.append("a", `t${i}`, `out${i}`);
    const ids = log.read("a").map((r) => r.termId);
    expect(ids).toHaveLength(16);
    expect(ids).not.toContain("t0");
    expect(ids).toContain("t19");
  });

  it("never blanks an established title with a later chunk that has none", () => {
    const log = new TerminalLog();
    log.append("a", "t1", "one", "npm build");
    log.append("a", "t1", "two");
    expect(log.read("a")[0]!.title).toBe("npm build");
  });

  it("ignores an empty chunk instead of materialising an empty terminal", () => {
    const log = new TerminalLog();
    log.append("a", "t1", "");
    expect(log.read("a")).toEqual([]);
  });

  it("forgets an agent's terminals with the agent", () => {
    const log = new TerminalLog();
    log.append("a", "t1", "x");
    log.append("b", "t1", "y");
    expect(log.forgetAgent(["a", "never-existed"])).toBe(1);
    expect(log.read("a")).toEqual([]);
    expect(log.read("b")).toHaveLength(1);
  });
});

describe("stripTerminalText", () => {
  it("removes colour and cursor sequences, keeping the text", () => {
    expect(stripTerminalText(`${ESC}[31mFAILED${ESC}[0m`)).toBe("FAILED");
    expect(stripTerminalText(`${ESC}[2K${ESC}[1Gdone`)).toBe("done");
  });

  it("removes an OSC window-title sequence", () => {
    expect(stripTerminalText(`${ESC}]0;my title${BEL}ls`)).toBe("ls");
  });

  it("resolves a progress bar to its final state instead of every frame", () => {
    // A bare CR rewrites the current line, which is how every spinner works. Kept raw, one
    // progress bar becomes thousands of near-identical lines and buries what came after it.
    expect(stripTerminalText("10%\r50%\r100% done\n")).toBe("100% done\n");
  });

  it("treats CRLF as a line break, not a rewrite", () => {
    expect(stripTerminalText("one\r\ntwo\r\n")).toBe("one\ntwo\n");
  });

  it("keeps tabs and newlines — they are the shape of the output", () => {
    expect(stripTerminalText("a\tb\nc")).toBe("a\tb\nc");
  });

  it("drops stray control bytes that would render as nothing", () => {
    expect(stripTerminalText("a\u0000b\u0008c")).toBe("abc");
  });

  it("leaves ordinary text exactly alone", () => {
    const plain = "npm ERR! code ELIFECYCLE\n  at /repo/x.ts:12\n";
    expect(stripTerminalText(plain)).toBe(plain);
  });
});
