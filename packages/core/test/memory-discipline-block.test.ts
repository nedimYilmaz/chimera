import { it, expect } from "vitest";
import { makeSupervisor } from "./helpers.js";

it("keeps memory guidance conditional and preserves the user's task and instructions", async () => {
  const { sup, fake } = makeSupervisor([]);
  await sup.spawn({ prompt: "Fix the parser", instructions: "Check Unicode", cwd: "/tmp", isolation: "none", orchestration: { allow: true } });
  expect(fake.spawns[0]!.prompt).toBe("Fix the parser");
  expect(fake.spawns[0]!.instructions).toContain("Check Unicode");
  expect(fake.spawns[0]!.instructions).toContain("when that context matters");
  expect(fake.spawns[0]!.instructions).toContain("skip unrelated searches");
  expect(fake.spawns[0]!.instructions).toContain("This policy grants no additional permissions.");
  expect(fake.spawns[0]!.instructions?.match(/CHIMERA MEMORY FIRST/g)).toHaveLength(1);
});
