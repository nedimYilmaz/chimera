import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

it("provides low-specificity dark native control and autofill fallbacks", () => {
  const css = readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8");
  expect(css).toContain("color-scheme: dark");
  expect(css).toContain(":where(button, input, select, textarea)");
  expect(css).toContain(":where(select option, select optgroup)");
  expect(css).toContain("input:-webkit-autofill");
  expect(css).toContain(":focus-visible");
});
