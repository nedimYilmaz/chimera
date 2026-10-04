import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/evidence.js";

describe("review unified diff model", () => {
  it("parses deterministic hunks and line coordinates", () => {
    const patches = parseUnifiedDiff([
      "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@", " const a = 1", "-old()", "+newOne()", "+newTwo()",
    ].join("\n"), [{ path: "src/a.ts", status: "modified", insertions: 2, deletions: 1 }]);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.language).toBe("typescript");
    expect(patches[0]!.hunks[0]!.id).toBe("src/a.ts:1:2:1:3");
    expect(patches[0]!.hunks[0]!.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["context", 1, 1], ["deletion", 2, null], ["addition", null, 2], ["addition", null, 3],
    ]);
  });
});
