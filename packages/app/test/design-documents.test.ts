import { describe, expect, it } from "vitest";
import { designDocuments, isDesignArtifact } from "../src/design/documents";
import type { ArtifactRow } from "../src/state/selectors.artifacts";
const row = (id: string, path: string | null, createdAt: number, label = "Dashboard"): ArtifactRow => ({ id, path, createdAt, label, kind: "file", agentId: "agent", taskId: null, sizeBytes: 10, url: null });
describe("design artifact revisions", () => {
  it("groups immutable snapshots by source path, newest first", () => {
    const docs = designDocuments([row("v1", "/a/home.html", 1), row("v3", "/a/home.html", 3), row("v2", "/a/home.html", 2)]);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.revisions.map((r) => r.id)).toEqual(["v3", "v2", "v1"]);
  });
  it("keeps duplicate labels in different paths separate", () => {
    expect(designDocuments([row("a", "/a/home.html", 1), row("b", "/b/home.html", 2)])).toHaveLength(2);
  });
  it("does not merge missing-path optimistic snapshots by label", () => {
    expect(designDocuments([row("a", null, 1, "home.html"), row("b", null, 2, "home.html")])).toHaveLength(2);
  });
  it("ignores remote links and non-html files even with an HTML-looking label", () => {
    expect(isDesignArtifact({ ...row("a", null, 1, "home.html"), kind: "link" })).toBe(false);
    expect(isDesignArtifact(row("a", "/a/data.json", 1, "home.html"))).toBe(false);
    expect(isDesignArtifact(row("a", "/a/HOME.HTM", 1))).toBe(true);
  });
  it("deduplicates records and uses the newest label", () => {
    const a = row("a", "/a/home.html", 1, "Before");
    const docs = designDocuments([a, a, row("b", "/a/home.html", 2, "After")]);
    expect(docs[0]!.revisions).toHaveLength(2);
    expect(docs[0]!.label).toBe("After");
  });
  it("has deterministic ordering for snapshots with the same timestamp", () => {
    const a = row("a", "/a/home.html", 1); const b = row("b", "/a/home.html", 1);
    expect(designDocuments([a,b])).toEqual(designDocuments([b,a]));
  });
});
