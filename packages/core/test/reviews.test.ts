import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, ReviewResolveForbiddenError, ReviewStore, UnknownReviewFindingError } from "../src/index.js";
describe("ReviewStore", () => {
  it("persists threaded findings and decisions", () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-reviews-")); const events = new EventLog(home);
    const store = new ReviewStore(home, events, () => 10);
    const parent = store.addFinding({ taskId: "t1", path: "a.ts", hunkId: "h1", parentId: null, authorAgentId: "a1", severity: "blocking", body: "fix" });
    store.addFinding({ taskId: "t1", path: "a.ts", hunkId: "h1", parentId: parent.id, authorAgentId: "a2", severity: "note", body: "reply" });
    store.decide("t1", { status: "changes_requested", actorAgentId: "critic", summary: "blocked" });
    const restored = new ReviewStore(home, events).get("t1");
    expect(restored.findings[1]?.parentId).toBe(parent.id); expect(restored.decision?.status).toBe("changes_requested"); expect(restored.revision).toBe(3);
  });

  describe("resolveFinding authority", () => {
    function makeStore() {
      const home = mkdtempSync(join(tmpdir(), "chimera-reviews-authority-")); const events = new EventLog(home);
      return new ReviewStore(home, events, () => 10);
    }

    it("a blocking finding rejects a resolve from an agent that did not file it", () => {
      const store = makeStore();
      const finding = store.addFinding({ taskId: "t1", path: "a.ts", hunkId: null, parentId: null, authorAgentId: "a1", severity: "blocking", body: "fix" });
      expect(() => store.resolveFinding("t1", finding.id, "a2")).toThrow(ReviewResolveForbiddenError);
      try { store.resolveFinding("t1", finding.id, "a2"); } catch (err) { expect((err as { code: string }).code).toBe("protocol"); }
      const session = store.get("t1");
      expect(session.findings[0]?.status).toBe("open");
      expect(session.revision).toBe(1);
    });

    it("the author of a blocking finding may resolve it", () => {
      const store = makeStore();
      const finding = store.addFinding({ taskId: "t1", path: "a.ts", hunkId: null, parentId: null, authorAgentId: "a1", severity: "blocking", body: "fix" });
      const resolved = store.resolveFinding("t1", finding.id, "a1");
      expect(resolved.status).toBe("resolved");
    });

    it("the operator (no actorAgentId) may resolve another agent's blocking finding", () => {
      const store = makeStore();
      const finding = store.addFinding({ taskId: "t1", path: "a.ts", hunkId: null, parentId: null, authorAgentId: "a1", severity: "blocking", body: "fix" });
      const resolved = store.resolveFinding("t1", finding.id, null);
      expect(resolved.status).toBe("resolved");
    });

    it("note and warning findings are resolvable by any agent", () => {
      for (const severity of ["note", "warning"] as const) {
        const store = makeStore();
        const finding = store.addFinding({ taskId: "t1", path: "a.ts", hunkId: null, parentId: null, authorAgentId: "a1", severity, body: "fyi" });
        const resolved = store.resolveFinding("t1", finding.id, "someone-else");
        expect(resolved.status).toBe("resolved");
      }
    });

    it("an unknown findingId still throws UnknownReviewFindingError, before the authority check", () => {
      const store = makeStore();
      expect(() => store.resolveFinding("t1", "missing", "someone")).toThrow(UnknownReviewFindingError);
    });

    it("stamps resolvedBy with the resolving agent, and null for the operator", () => {
      const store = makeStore();
      const finding = store.addFinding({ taskId: "t1", path: "a.ts", hunkId: null, parentId: null, authorAgentId: "a1", severity: "note", body: "fyi" });
      expect(finding.resolvedBy).toBeNull();
      const resolved = store.resolveFinding("t1", finding.id, "a2");
      expect(resolved.resolvedBy).toBe("a2");

      const opFinding = store.addFinding({ taskId: "t1", path: "a.ts", hunkId: null, parentId: null, authorAgentId: "a1", severity: "note", body: "fyi2" });
      const opResolved = store.resolveFinding("t1", opFinding.id, null);
      expect(opResolved.resolvedBy).toBeNull();
    });
  });
});
