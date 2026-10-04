import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";
import { groupDeliverable, buildCapabilityBlock, buildMemoryDisciplineBlock } from "@chimera/core/supervisor";
import type { MailboxMessage } from "@chimera/core/mailbox";

// TOKEN-OPT: five measured wastes, each fixed without removing a capability. What these tests
// pin is the PROPERTY that made each one expensive, not the byte counts of the day.

const msg = (over: Partial<MailboxMessage> = {}): MailboxMessage =>
  ({ from: "a", kind: "note", text: "hi", id: "1", ts: 1, engineId: "local", ...over } as MailboxMessage);

// ---------------------------------------------------------------------------
// 1. shared prompt blocks must be a cross-agent CACHE PREFIX
// ---------------------------------------------------------------------------
describe("shared instruction blocks lead the prompt", () => {
  it("two agents with different instructions still share a byte-identical opening", () => {
    const shared = `${buildCapabilityBlock()}\n\n${buildMemoryDisciplineBlock()}`;
    // what launch() composes, in the order it composes it
    const compose = (own: string) => [buildCapabilityBlock(), buildMemoryDisciplineBlock(), own].join("\n\n");
    const a = compose("you are the frontend agent");
    const b = compose("you are the infrastructure agent");
    expect(a.startsWith(shared)).toBe(true);
    expect(b.startsWith(shared)).toBe(true);
    // the prefix is the whole shared block, not an accidental few characters
    let common = 0;
    while (common < a.length && a[common] === b[common]) common++;
    expect(common).toBeGreaterThanOrEqual(shared.length);
  });
});

// ---------------------------------------------------------------------------
// 2. a drained mailbox batch is ONE turn, not N
// ---------------------------------------------------------------------------
describe("mailbox batching", () => {
  it("folds consecutive plain messages into a single turn", () => {
    const groups = groupDeliverable([msg({ id: "1" }), msg({ id: "2" }), msg({ id: "3" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it("never folds a slash command — it must be the whole turn verbatim", () => {
    const groups = groupDeliverable([msg({ id: "1" }), msg({ id: "2", slash: true, text: "/compact" }), msg({ id: "3" })]);
    expect(groups.map((g) => g.length)).toEqual([1, 1, 1]);
  });

  it("never folds a message carrying blocks — concatenating text would lose their position", () => {
    const withBlocks = msg({ id: "2", content: [{ type: "text", text: "x" }] as never });
    const groups = groupDeliverable([msg({ id: "1" }), withBlocks, msg({ id: "3" }), msg({ id: "4" })]);
    expect(groups.map((g) => g.map((m) => m.id))).toEqual([["1"], ["2"], ["3", "4"]]);
  });

  it("preserves FIFO order exactly — grouping moves turn boundaries, never messages", () => {
    const batch = ["1", "2", "3", "4", "5"].map((id) => msg({ id, slash: id === "3" }));
    expect(groupDeliverable(batch).flat().map((m) => m.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("an empty batch produces no turns at all", () => {
    expect(groupDeliverable([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3 + 5. agent-facing reads are bounded
// ---------------------------------------------------------------------------
const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend([[{ awaitSend: true }]])]]);

describe("agent-facing payload caps", () => {
  it("agent_tail truncates a huge event field instead of dumping it into the caller's context", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await e.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
    e.events.append({ agentId: a.agentId, kind: "tool_result", data: { result: "x".repeat(200_000) } });

    const tail = await e.handle("agent.tail", { agentId: a.agentId, n: 20 }) as Array<{ kind: string; data: Record<string, unknown> }>;
    const hit = tail.find((ev) => ev.kind === "tool_result")!;
    const text = hit.data["result"] as string;
    expect(text.length).toBeLessThan(5_000);
    expect(text).toContain("truncated");
    // the EVENT LOG keeps the full payload — this is a projection for one tool, not retention
    expect((e.events.tail(a.agentId, 20).find((ev) => ev.kind === "tool_result")!.data["result"] as string).length).toBe(200_000);
  });

  it("agent_tail names omitted binary blocks rather than shipping their base64", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await e.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
    e.events.append({ agentId: a.agentId, kind: "status", data: { delivered: true, images: [{ data: "A".repeat(100_000) }] } });

    const tail = await e.handle("agent.tail", { agentId: a.agentId, n: 20 }) as Array<{ data: Record<string, unknown> }>;
    const hit = tail.find((ev) => typeof ev.data["images"] === "string")!;
    expect(hit.data["images"]).toContain("omitted");
    expect(String(hit.data["images"]).length).toBeLessThan(200);
  });

  it("memory_search excerpts for agents but stays whole for the app", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const long = "detail ".repeat(400);
    await e.handle("memory.add", { author: "a1", title: "big note", text: long });

    const excerpted = await e.handle("memory.search", { query: "detail", excerpt: true }) as Array<{ record: { text: string } }>;
    expect(excerpted[0]!.record.text.length).toBeLessThan(long.length);
    expect(excerpted[0]!.record.text).toContain("memory_get");

    const full = await e.handle("memory.search", { query: "detail" }) as Array<{ record: { text: string } }>;
    expect(full[0]!.record.text).toBe(long);
  });

  it("a short memory is returned untouched — an excerpt marker on a one-liner is noise", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("memory.add", { author: "a1", text: "prod is eu-west-1" });
    const hits = await e.handle("memory.search", { query: "prod", excerpt: true }) as Array<{ record: { text: string } }>;
    expect(hits[0]!.record.text).toBe("prod is eu-west-1");
  });
});

// ---------------------------------------------------------------------------
// 4. the same image is never stored twice
// ---------------------------------------------------------------------------
describe("mailbox stores one copy of a paste", () => {
  it("drops the redundant images array when content already carries the blocks", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const stored = e.mailboxes.enqueue("a1", {
      from: "op", kind: "user_message", text: "look",
      images: [{ mediaType: "image/png", data: "B".repeat(1000) }],
      content: [{ type: "image", mediaType: "image/png", data: "B".repeat(1000) }],
    } as never) as { images?: unknown; content?: unknown };
    expect(stored.images).toBeUndefined();
    expect(stored.content).toBeDefined();     // the copy the delivery path actually reads
  });

  it("keeps images when there are no content blocks — that copy IS the payload", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const stored = e.mailboxes.enqueue("a1", {
      from: "op", kind: "user_message", text: "look",
      images: [{ mediaType: "image/png", data: "B".repeat(10) }],
    } as never) as { images?: unknown[] };
    expect(stored.images).toHaveLength(1);
  });
});
