import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContentBlock } from "@chimera/protocol";
import { MailboxStore } from "@chimera/core/mailbox";
import { makeSupervisor } from "./helpers.js";

// D9 (F13 composer wire): AgentSupervisor.send(agentId, text, from, images?, slash?, content?)
// threads an additive `content` blocks array into the mailbox message; deliverBatch forwards it
// through to handle.send(text, images, content) -- with the "[from …] " attribution folded into
// the FIRST block so every other block (in particular a mid-sentence image) keeps its exact
// position -- and mirrors it onto the persisted "delivered" event so replay reproduces the same
// block order. All token-free (FakeAgentBackend).

const CONTENT: ContentBlock[] = [
  { type: "text", text: "look at " },
  { type: "image", mediaType: "image/png", data: "AAA" },
  { type: "text", text: " and " },
  { type: "image", mediaType: "image/jpeg", data: "BBB" },
];

function mailboxRaw(dir: string, agentId: string): string {
  return readFileSync(join(dir, "mailboxes", encodeURIComponent(agentId) + ".jsonl"), "utf8");
}

describe("AgentSupervisor.send: content[] blocks (D9)", () => {
  it("folds the '[from …] ' attribution into the FIRST content block, leaving every other block's position untouched", async () => {
    const { sup } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });

    const seen: Array<{ text: string; content?: ContentBlock[] }> = [];
    const handles = (sup as unknown as { handles: Map<string, { send(t: string, images?: unknown, content?: ContentBlock[]): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    handles.set(rec.agentId, { ...real, send: async (t, images, content) => { seen.push({ text: t, content }); await real.send(t, images, content); } });

    await sup.send(rec.agentId, "look at [img] and [img]", "tester", undefined, false, CONTENT);
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toEqual([{
      text: "[from tester] look at [img] and [img]",
      content: [
        { type: "text", text: "[from tester] look at " },
        { type: "image", mediaType: "image/png", data: "AAA" },
        { type: "text", text: " and " },
        { type: "image", mediaType: "image/jpeg", data: "BBB" },
      ],
    }]);
  });

  it("a slash-command send forwards content[] VERBATIM (no attribution prefix)", async () => {
    const { sup } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });

    const seen: Array<ContentBlock[] | undefined> = [];
    const handles = (sup as unknown as { handles: Map<string, { send(t: string, images?: unknown, content?: ContentBlock[]): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    handles.set(rec.agentId, { ...real, send: async (t, images, content) => { seen.push(content); await real.send(t, images, content); } });

    await sup.send(rec.agentId, "/cmd", "tui", undefined, true, CONTENT);
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toEqual([CONTENT]);
  });

  it("omits the `content` key entirely from the persisted mailbox record when not provided (backward compat)", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.send(rec.agentId, "hi", "tester");
    expect(mailboxRaw(dir, rec.agentId)).not.toContain("content");
  });

  it("persists a non-empty content array verbatim, in order", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.send(rec.agentId, "hi", "tester", undefined, false, CONTENT);
    const parsed = JSON.parse(mailboxRaw(dir, rec.agentId).trim());
    expect(parsed.content).toEqual(CONTENT);
  });

  it("mirrors `content` onto the persisted 'delivered' event, in the same order as the original send (replay parity)", async () => {
    const { sup, events } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });

    const seen: Array<Record<string, unknown>> = [];
    events.subscribe((e) => { if (e.kind === "status" && e.data["delivered"] === true) seen.push(e.data); });

    await sup.send(rec.agentId, "look at [img] and [img]", "tester", undefined, false, CONTENT);
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toHaveLength(1);
    // the mirrored event carries the ORIGINAL (unprefixed) content — the attribution
    // prefix is folded in only on the live handle.send() path, not the persisted record.
    expect(seen[0]!["content"]).toEqual(CONTENT);
  });

  it("re-enqueues a failed content-carrying message with its `content` field intact (no silent block loss on retry)", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });

    const handles = (sup as unknown as { handles: Map<string, { send(): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    handles.set(rec.agentId, { ...real, send: async () => { throw new Error("boom"); } });

    await sup.send(rec.agentId, "hello", "tester", undefined, false, CONTENT);
    await new Promise((r) => setTimeout(r, 0));

    const pending = new MailboxStore(dir).pending(rec.agentId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ from: "tester", kind: "user_message", text: "hello", content: CONTENT });
  });
});
