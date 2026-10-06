import { it, expect } from "vitest";
import { makeSupervisor } from "./helpers.js";

it("does not attach a memory discipline or memory startup ritual to tasks", async () => {
  const { sup, fake } = makeSupervisor([]);
  await sup.spawn({ prompt: "Fix the parser", instructions: "Check Unicode", cwd: "/tmp", isolation: "none", orchestration: { allow: true } });
  expect(fake.spawns[0]!.prompt).toBe("Fix the parser");
  expect(fake.spawns[0]!.instructions).toContain("Check Unicode");
  expect(fake.spawns[0]!.instructions).not.toMatch(/MEMORY|memory_search|chronicle_search/);
});
