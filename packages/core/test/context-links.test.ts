import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextLinkStore, type ContextAgent } from "../src/context-links.js";

let home: string, now: number, agents: Map<string, ContextAgent>, source: string, artifactOwner: string, artifactPresent: boolean, audits: unknown[];
const agent = (id: string, overrides = {}): ContextAgent => ({ agentId: id, treeId: "tree", projectId: "project", principal: "local", accountName: "account", membership: { team: "team" }, ...overrides });
const operator = { operator: true } as const;
const caller = { agentId: "a" }, consumer = { agentId: "b" };
function store() { return new ContextLinkStore(home, { agent: id => { const a = agents.get(id); if (!a) throw new Error("removed"); return a; }, summary: () => source, artifact: () => { if (!artifactPresent) throw new Error("removed"); return { agentId: artifactOwner, label: "Artifact", sizeBytes: Buffer.byteLength(source), kind: "file", url: null }; }, artifactText: () => source, redact: (_, s) => s.replaceAll("injected-credential", "[REDACTED]"), audit: a => audits.push(a), now: () => now }); }
const summary = { from: { kind: "agent-summary" as const, ref: "a" }, toAgentId: "b" };
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "context-links-")); now = 100; agents = new Map(["a", "b", "c"].map(id => [id, agent(id)])); source = "bounded summary"; artifactOwner = "a"; artifactPresent = true; audits = []; });
afterEach(() => rmSync(home, { recursive: true, force: true }));
describe("explicit context snapshots", () => {
  it("persists immutable snapshots, metadata lists never contain bodies; revoke deletes disk bytes immediately", () => {
    let s = store(); const link = s.create(summary, caller); source = "edited later";
    expect(link.snapshot.text).toBeUndefined(); expect(s.list({}, consumer).links[0]?.snapshot.text).toBeUndefined();
    s = store(); expect(s.get(link.id, consumer).snapshot.text).toBe("bounded summary");
    s.revoke(link.id, caller); expect(() => s.get(link.id, consumer)).toThrowError(expect.objectContaining({ code: "revoked" }));
    expect(readFileSync(join(home, "context-links.json"), "utf8")).not.toContain("bounded summary");
    expect(JSON.stringify(audits)).not.toContain("bounded summary");
  });
  it("permits only named consumer, creator and operator; consumer cannot revoke", () => {
    const s = store(), link = s.create(summary, caller);
    expect(s.get(link.id, caller).untrusted).toBe(true); expect(s.get(link.id, operator).snapshot.text).toBe(source);
    expect(() => s.get(link.id, { agentId: "c" })).toThrowError(expect.objectContaining({ code: "forbidden" }));
    expect(s.list({}, { agentId: "c" }).links).toEqual([]);
    expect(() => s.revoke(link.id, consumer)).toThrowError(expect.objectContaining({ code: "forbidden" }));
  });
  it.each([{ projectId: "other" }, { accountName: "other" }, { principal: "peer" }, { treeId: "other", membership: { team: "other" } }])("denies changed live boundaries on create and every read: %o", change => {
    const s = store(), link = s.create(summary, caller); agents.set("b", agent("b", change));
    expect(() => s.create(summary, caller)).toThrowError(expect.objectContaining({ code: "forbidden" }));
    expect(() => s.get(link.id, consumer)).toThrowError(expect.objectContaining({ code: "forbidden" }));
    expect(s.list({}, caller).links).toEqual([]);
  });
  it("allows same team across trees or same tree without team, while forbidding other agents' sources and notes", () => {
    const s = store(); agents.set("b", agent("b", { treeId: "another" })); s.create(summary, caller);
    agents.set("b", agent("b", { membership: undefined })); s.create(summary, caller);
    expect(() => s.create({ ...summary, from: { kind: "agent-summary", ref: "c" } }, caller)).toThrowError(expect.objectContaining({ code: "forbidden" }));
    expect(() => s.create({ ...summary, from: { kind: "note-snapshot", ref: "a" }, text: "private" }, caller)).toThrowError(expect.objectContaining({ code: "forbidden" }));
    artifactOwner = "c"; expect(() => s.create({ ...summary, from: { kind: "artifact", ref: "artifact" } }, caller)).toThrowError(expect.objectContaining({ code: "forbidden" }));
  });
  it("scrubs secret shapes and injected credentials from agent snapshots and titles", () => {
    source = "sk-secret123 injected-credential"; const s = store(); const link = s.create({ ...summary, title: source }, caller);
    const text = s.get(link.id, consumer); expect(text.snapshot.text).toBe("[REDACTED] [REDACTED]"); expect(text.snapshot.title).toBe(text.snapshot.text);
  });
  it("requires explicit operator secret confirmation; ordinary note content is never implicitly read", () => {
    const s = store(), input = { ...summary, from: { kind: "note-snapshot" as const, ref: "a" }, text: "sk-private123" };
    expect(() => s.create(input, operator)).toThrowError(expect.objectContaining({ code: "secret_confirmation_required" }));
    const link = s.create({ ...input, confirmSecrets: true }, operator); expect(s.get(link.id, consumer).snapshot.text).toBe(input.text);
    expect(s.get(link.id, consumer).untrusted).toBe(false);
  });
  it("expiry deletes content; source removal and GC never fall back to a local agent", () => {
    const s = store(), expired = s.create({ ...summary, expiresAt: 101 }, caller); now = 102;
    expect(() => s.get(expired.id, consumer)).toThrowError(expect.objectContaining({ code: "expired" }));
    const artifact = s.create({ ...summary, from: { kind: "artifact", ref: "artifact" } }, caller); artifactPresent = false;
    expect(() => s.get(artifact.id, consumer)).toThrowError(expect.objectContaining({ code: "source_removed" }));
    expect(s.list({}, consumer).links.find(l => l.id === artifact.id)?.status).toBe("source-removed");
    expect(() => s.create({ ...summary, from: { kind: "agent-summary", ref: "remote:a" } }, operator)).toThrowError(expect.objectContaining({ code: "forbidden" }));
    agents.delete("b"); expect(s.list({}, caller).links).toEqual([]);
  });
  it("bounds UTF8 and artifact reads, forbids caller-supplied summaries and indefinite agent grants", () => {
    const s = store(); source = "🙂".repeat(8193);
    expect(() => s.create(summary, caller)).toThrowError(expect.objectContaining({ code: "too_large" }));
    expect(() => s.create({ ...summary, from: { kind: "artifact", ref: "artifact" } }, caller)).toThrowError(expect.objectContaining({ code: "too_large" }));
    source = "summary"; expect(() => s.create({ ...summary, text: "forged" }, caller)).toThrowError(expect.objectContaining({ code: "protocol" }));
    expect(() => s.create({ ...summary, expiresAt: null }, caller)).toThrowError(expect.objectContaining({ code: "forbidden" }));
  });
  it("unknown storage versions are read-only and never overwritten", () => {
    const path = join(home, "context-links.json"); writeFileSync(path, '{"v":2,"links":[]}'); const s = store();
    expect(() => s.create(summary, caller)).toThrowError(expect.objectContaining({ code: "unsupported" })); expect(readFileSync(path, "utf8")).toBe('{"v":2,"links":[]}');
  });
});
it("enforces aggregate and count storage caps independently", () => {
  source = "x".repeat(32768); const first = store().create(summary, caller);
  const file = join(home, "context-links.json");
  const row = JSON.parse(readFileSync(file, "utf8")).links[0];
  const rows = Array.from({ length: 128 }, (_, i) => ({ ...row, link: { ...row.link, id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` } }));
  writeFileSync(file, JSON.stringify({ v: 1, links: rows }));
  expect(() => store().create(summary, caller)).toThrowError(expect.objectContaining({ code: "capacity" }));
  source = "small";
  const small = { ...row, link: { ...row.link, snapshot: { ...first.snapshot, bytes: 5, text: "small" } } };
  writeFileSync(file, JSON.stringify({ v: 1, links: Array.from({ length: 500 }, (_, i) => ({ ...small, link: { ...small.link, id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` } })) }));
  expect(() => store().create(summary, caller)).toThrowError(expect.objectContaining({ code: "capacity" }));
});
it("changing source ownership denies old grants and clearing a summary on compaction never replaces the snapshot", () => {
  const s = store(); const link = s.create(summary, caller); source = "";
  expect(s.get(link.id, consumer).snapshot.text).toBe("bounded summary");
  source = "artifact"; const artifact = s.create({ ...summary, from: { kind: "artifact", ref: "artifact" } }, caller); artifactOwner = "c";
  expect(() => s.get(artifact.id, consumer)).toThrowError(expect.objectContaining({ code: "forbidden" }));
});
it("lists operator-shared artifacts as outgoing from their stable source agent, even after source removal", () => {
  const s = store(); const link = s.create({ ...summary, toAgentId: "c", from: { kind: "artifact", ref: "artifact" } }, operator);
  expect(s.list({ fromAgentId: "a" }, operator).links.map(l => l.id)).toEqual([link.id]);
  artifactPresent = false; expect(s.list({ fromAgentId: "a" }, operator).links[0]?.status).toBe("source-removed");
});

it.each([{ projectId: null }, { projectId: "" }, { projectId: " " }, { principal: "" }, { accountName: " " }, { treeId: "", membership: { team: "" } }, { treeId: " ", membership: { team: " " } }])("shared missing scope fails closed on create/list/read: %o", change => {
  const s = store(), link = s.create(summary, caller);
  agents.set("a", agent("a", change)); agents.set("b", agent("b", change));
  expect(() => s.create(summary, caller)).toThrowError(expect.objectContaining({ code: "forbidden" }));
  expect(() => s.get(link.id, consumer)).toThrowError(expect.objectContaining({ code: "forbidden" }));
  expect(s.list({}, consumer).links).toEqual([]);
});
