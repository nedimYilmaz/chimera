import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// AGENT-GROUPS Phase 1: Nedim's "no backend effect" requirement, made executable — groups are
// a purely visual/list-placement concept (core/src/groups.ts's header,
// no scheduling change). This asserts the claim structurally: nothing under backends/,
// scheduler.ts, broker.ts, or jobs.ts ever reads AgentSpec.groups/AgentRecord.groups. A future
// change that makes groups load-bearing for execution/scheduling fails THIS test immediately,
// rather than surfacing as a silent behavior change an operator has to notice on their own.
//
// Matches `.groups` as a property access (word-boundaried) rather than the bare word "groups" —
// the bare word already appears harmlessly in this tree today ("process groups" in claude.ts,
// "groups `items` into chunks" in scheduler.ts) and a substring match would false-positive on
// those forever.
const GROUPS_ACCESS = /\.groups\b/;

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...listFilesRecursive(p));
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("AGENT-GROUPS: no backend effect", () => {
  const root = join(__dirname, "..", "src");
  const targets: Array<{ label: string; files: string[] }> = [
    { label: "backends/", files: listFilesRecursive(join(root, "backends")) },
    { label: "scheduler.ts", files: [join(root, "scheduler.ts")] },
    { label: "broker.ts", files: [join(root, "broker.ts")] },
    { label: "jobs.ts", files: [join(root, "jobs.ts")] },
  ];

  for (const { label, files } of targets) {
    it(`no file under ${label} reads AgentSpec.groups / AgentRecord.groups`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        if (GROUPS_ACCESS.test(text)) offenders.push(file);
      }
      expect(offenders).toEqual([]);
    });
  }
});
