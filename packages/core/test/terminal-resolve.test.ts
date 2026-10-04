import { describe, expect, it } from "vitest";
import { TerminalLog } from "@chimera/core/terminal-log";

// TERMINAL-WRITE — an agent typing into the terminal the operator opened under it.
//
// Everything here is about WHICH terminal. That is the only part with a wrong answer available:
// writing the right command into the wrong shell is worse than not writing it, and the caller
// cannot tell the difference afterwards. So the resolution rules are pinned, including the ones
// that refuse.

const log = (): TerminalLog => new TerminalLog();

describe("resolving which terminal an agent means", () => {
  it("returns null when the agent has none", () => {
    expect(log().resolve("a")).toBeNull();
    expect(log().resolve("a", "anything")).toBeNull();
  });

  it("uses the tab the operator is looking at when none is named", () => {
    // "the terminal" means the one on screen. The daemon has no window, so the app reports it.
    const l = log();
    l.append("a", "t1", "one");
    l.append("a", "t2", "two");
    l.setActive("a", "t1");
    expect(l.resolve("a")).toBe("t1");
  });

  it("falls back to the most recently written when focus has not been reported", () => {
    // Right after a restart the app has not said anything yet, but the agent still means "the
    // terminal" — the newest one is the closest honest answer.
    const l = log();
    l.append("a", "old", "x");
    l.append("a", "new", "y");
    expect(l.resolve("a")).toBe("new");
  });

  it("takes a tab NAME, which is what a model can actually hold on to", () => {
    const l = log();
    l.append("a", "term-abc123", "x", "build");
    l.append("a", "term-def456", "y", "logs");
    l.setActive("a", "term-abc123");
    expect(l.resolve("a", "logs")).toBe("term-def456");
  });

  it("takes a raw term id too", () => {
    const l = log();
    l.append("a", "term-abc123", "x", "build");
    expect(l.resolve("a", "term-abc123")).toBe("term-abc123");
  });

  it("REFUSES a name it does not have instead of falling back to the active tab", () => {
    // The dangerous case. The caller named a specific terminal; silently redirecting the write to
    // a different one is how a command lands in the wrong shell, and nothing downstream could tell.
    const l = log();
    l.append("a", "t1", "x", "build");
    l.setActive("a", "t1");
    expect(l.resolve("a", "deploy")).toBeNull();
  });

  it("never crosses agents — not by name and not by id", () => {
    // Reading another agent's terminal would be reading the operator's other window. Writing to one
    // would be typing into a live shell someone else is using.
    const l = log();
    l.append("mine", "t1", "x", "build");
    l.append("theirs", "t2", "y", "build");
    l.setActive("theirs", "t2");
    expect(l.resolve("mine", "t2")).toBeNull();
    expect(l.resolve("mine", "build")).toBe("t1");
    expect(l.resolve("stranger")).toBeNull();
  });

  it("ignores a focus pointing at a terminal that is gone", () => {
    // Focus is a hint from another process and can outlive what it points at; it must not turn
    // into a null target when the agent does have a usable terminal.
    const l = log();
    l.append("a", "t1", "x");
    l.setActive("a", "vanished");
    expect(l.resolve("a")).toBe("t1");
  });

  it("follows a RENAME — the name on screen is the one that resolves", () => {
    // The bug this fixes: the title reached the daemon only as a field on terminal.append, carried
    // from the value captured when the session was created. Renaming a tab therefore never reached
    // the daemon, and an agent told "run it in Deneme-123" could not find it while still being
    // shown the old generated name.
    const l = log();
    l.append("a", "t1", "x", "PROJ-5678-2");
    l.setTitle("a", "t1", "Deneme-123");
    expect(l.resolve("a", "Deneme-123")).toBe("t1");
    expect(l.resolve("a", "PROJ-5678-2")).toBeNull();
    expect(l.read("a")[0]!.title).toBe("Deneme-123");
  });

  it("makes a tab that has printed NOTHING addressable by name", () => {
    // The operator opens a tab, names it, and tells an agent to run something there before
    // anything has been written to it. Without a record the write would be refused for a tab that
    // plainly exists on screen.
    const l = log();
    l.setTitle("a", "fresh", "scratch");
    expect(l.resolve("a", "scratch")).toBe("fresh");
    expect(l.resolve("a")).toBe("fresh");
  });

  it("forgets focus with the agent", () => {
    const l = log();
    l.append("a", "t1", "x");
    l.setActive("a", "t1");
    l.forgetAgent(["a"]);
    expect(l.resolve("a")).toBeNull();
  });
});
