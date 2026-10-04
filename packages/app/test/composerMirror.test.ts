import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// COMPOSER-MARKDOWN-PREVIEW — the mirror layer wraps identically to the textarea ONLY because the
// two share their text metrics. Nothing at runtime enforces that: someone changing the composer's
// font size would silently leave the highlights sitting off the characters they mark, and it would
// show up as a rendering glitch rather than as a broken rule.
//
// So the agreement is asserted against the real stylesheet, the way the schedules column budget is.
// A browser is not needed to check that two rule blocks declare the same values — which is exactly
// the part that drifts.

const CSS = readFileSync(fileURLToPath(new URL("../src/components/Composer.module.css", import.meta.url)), "utf8");

/** The declarations of one top-level rule block, as `prop: value` pairs. */
function declarations(selector: string): Map<string, string> {
  const at = CSS.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  const body = CSS.slice(at + selector.length + 2, CSS.indexOf("}", at));
  const out = new Map<string, string>();
  for (const line of body.split("\n")) {
    const m = /^\s*([a-z-]+)\s*:\s*([^;]+);/.exec(line);
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

// Anything that changes where a glyph lands. Colour, background and position are free to differ —
// that difference is the whole point of the layer.
const METRICS = ["font-family", "font-size", "line-height", "padding"];

describe("the composer mirror keeps the textarea's metrics", () => {
  const input = declarations(".input");
  const mirror = declarations(".inputMirror");

  it.each(METRICS)("declares the same %s as the textarea", (prop) => {
    expect(mirror.get(prop), `${prop} must match .input`).toBe(input.get(prop));
  });

  it("declares every metric explicitly rather than inheriting one of them", () => {
    // An inherited value looks equal until something upstream changes for one layer and not the
    // other. Both blocks state all of them.
    for (const prop of METRICS) {
      expect(input.get(prop), `.input is missing ${prop}`).toBeDefined();
      expect(mirror.get(prop), `.inputMirror is missing ${prop}`).toBeDefined();
    }
  });

  it("wraps the way a textarea does, which is not the CSS default", () => {
    expect(mirror.get("white-space")).toBe("pre-wrap");
    expect(mirror.get("overflow-wrap")).toBe("break-word");
  });

  it("never takes the pointer or the caret away from the textarea", () => {
    expect(mirror.get("pointer-events")).toBe("none");
    expect(mirror.get("color")).toBe("transparent");
  });
});
