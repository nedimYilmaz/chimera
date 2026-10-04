import { describe, expect, it } from "vitest";
import { markerRuns } from "../src/state/composerMarkers";

// COMPOSER-MARKDOWN-PREVIEW — the runs a mirror layer paints behind the textarea, so a `backtick`
// span is visibly code while you type it rather than only after you send.
//
// The invariant every case here protects: the concatenated runs must reproduce the input EXACTLY.
// The mirror has to wrap identically to the textarea, so a dropped or duplicated character does
// not merely look wrong — it shifts every highlight after it off the text it marks.

const joined = (t: string): string => markerRuns(t).map((r) => r.text).join("");
const codeParts = (t: string): string[] => markerRuns(t).filter((r) => r.code).map((r) => r.text);

describe("markerRuns", () => {
  it("marks an inline span, markers included", () => {
    // The backticks are part of the run: they are still on screen in the textarea, so the
    // highlight has to cover them or it sits one character in from the text it belongs to.
    expect(markerRuns("run `npm test` now")).toEqual([
      { text: "run ", code: false },
      { text: "`npm test`", code: true },
      { text: " now", code: false },
    ]);
  });

  it("marks a fenced block", () => {
    expect(codeParts("see:\n```sh\nls\n```\ndone")).toEqual(["```sh\nls\n```"]);
  });

  it("treats a lone backtick INSIDE a fence as content, not a new span", () => {
    // Fences win. Otherwise the backtick would close nothing and split the block in half.
    expect(codeParts("```\na ` b\n```")).toEqual(["```\na ` b\n```"]);
  });

  it("leaves an UNTERMINATED marker plain — you are mid-typing", () => {
    // Lighting up the rest of the buffer on every opening backtick flashes the whole message
    // between two keystrokes.
    expect(codeParts("open `npm te")).toEqual([]);
    expect(codeParts("```sh\nls -la")).toEqual([]);
  });

  it("does not let an inline span run across a newline", () => {
    expect(codeParts("a `b\nc` d")).toEqual([]);
  });

  it("marks several spans on one line", () => {
    expect(codeParts("`a` and `b`")).toEqual(["`a`", "`b`"]);
  });

  it("reproduces the input exactly, whatever it is", () => {
    for (const t of [
      "", "plain", "`", "``", "```", "`a`", "a`b", "```\nx\n```", "``` ```",
      "`a` `b` `c", "no markers at all\nsecond line", "\n\n", "`\n`", "````x````",
    ]) {
      expect(joined(t), JSON.stringify(t)).toBe(t);
    }
  });

  it("returns one empty run for empty input, so the caller has one code path", () => {
    expect(markerRuns("")).toEqual([{ text: "", code: false }]);
  });
});
