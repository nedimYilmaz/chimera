import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Image } from "@chimera/core/backend";
import { MailboxStore } from "@chimera/core/mailbox";
import { makeSupervisor } from "./helpers.js";

// IMAGE.PASTE (TUI #7): AgentSupervisor.send(agentId, text, from, images?) threads
// an additive `images` array into the mailbox message, and deliverBatch forwards it
// through to handle.send(text, images) unchanged. All token-free (FakeAgentBackend).

const PNG: Image = { mediaType: "image/png", data: "aGVsbG8=" };

function mailboxRaw(dir: string, agentId: string): string {
  return readFileSync(join(dir, "mailboxes", encodeURIComponent(agentId) + ".jsonl"), "utf8");
}

describe("AgentSupervisor.send: images (IMAGE.PASTE)", () => {
  it("passes images through mailbox -> deliverBatch -> handle.send, in the batch's original order", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });

    const seen: Array<{ text: string; images?: Image[] }> = [];
    const handles = (sup as unknown as { handles: Map<string, { send(t: string, images?: Image[]): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    handles.set(rec.agentId, { ...real, send: async (t, images) => { seen.push({ text: t, images }); await real.send(t, images); } });

    await sup.send(rec.agentId, "look at this", "tester", [PNG]);
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toEqual([{ text: "[from tester] look at this", images: [PNG] }]);
    void dir;
  });

  it("omits `images` entirely from handle.send() when not provided (backward compat)", async () => {
    const { sup } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });

    const seen: Array<{ text: string; images?: Image[] }> = [];
    const handles = (sup as unknown as { handles: Map<string, { send(t: string, images?: Image[]): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    handles.set(rec.agentId, { ...real, send: async (t, images) => { seen.push({ text: t, images }); await real.send(t, images); } });

    await sup.send(rec.agentId, "no pics");
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toEqual([{ text: "[from caller] no pics", images: undefined }]);
  });

  it("multiple images in one send() are forwarded to handle.send() in the SAME order", async () => {
    const { sup } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    const imgs: Image[] = [PNG, { mediaType: "image/jpeg", data: "AAA" }, { mediaType: "image/gif", data: "BBB" }];

    const seen: Array<Image[] | undefined> = [];
    const handles = (sup as unknown as { handles: Map<string, { send(t: string, images?: Image[]): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    handles.set(rec.agentId, { ...real, send: async (t, images) => { seen.push(images); await real.send(t, images); } });

    await sup.send(rec.agentId, "three pics", "tester", imgs);
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toEqual([imgs]);
  });

  it("omits the `images` key entirely from the persisted mailbox record when no images are passed", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.send(rec.agentId, "hi", "tester");
    expect(mailboxRaw(dir, rec.agentId)).not.toContain("images");
  });

  it("omits the `images` key when an explicit empty array is passed (normalized like absent)", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.send(rec.agentId, "hi", "tester", []);
    expect(mailboxRaw(dir, rec.agentId)).not.toContain("images");
  });

  it("persists a non-empty images array verbatim, base64 inline", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.send(rec.agentId, "hi", "tester", [PNG]);
    const parsed = JSON.parse(mailboxRaw(dir, rec.agentId).trim());
    expect(parsed.images).toEqual([PNG]);
  });

  it("re-enqueues a failed image-carrying message with its `images` field intact (no silent image loss on retry)", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });

    const handles = (sup as unknown as { handles: Map<string, { send(t: string, images?: Image[]): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    handles.set(rec.agentId, { ...real, send: async () => { throw new Error("boom"); } });

    await sup.send(rec.agentId, "hello", "tester", [PNG]);
    await new Promise((r) => setTimeout(r, 0));

    const pending = new MailboxStore(dir).pending(rec.agentId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ from: "tester", kind: "user_message", text: "hello", images: [PNG] });
  });

  it("mid-batch failure re-enqueues the failed image message + tail, each with its own images field intact", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });

    // Mirrors the plain-text "true mid-batch failure" test in supervisor-mailbox.test.ts:
    // the replacement handle does NOT forward to the real fake handle (which would let its
    // single-awaitSend script run to completion after message #1 and trigger a SECOND,
    // unrelated deliverPending() via turn_complete) -- it purely records locally.
    let calls = 0;
    const sent: Array<{ text: string; images?: Image[] }> = [];
    const handles = (sup as unknown as { handles: Map<string, { send(t: string, images?: Image[]): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    handles.set(rec.agentId, {
      ...real,
      send: async (t: string, images?: Image[]) => { calls++; if (calls === 2) throw new Error("boom"); sent.push({ text: t, images }); },
    });

    const mb = new MailboxStore(dir);
    mb.enqueue(rec.agentId, { from: "a", kind: "user_message", text: "one" });
    mb.enqueue(rec.agentId, { from: "b", kind: "user_message", text: "two", images: [PNG] });
    mb.enqueue(rec.agentId, { from: "c", kind: "user_message", text: "three" });

    (sup as unknown as { deliverPending(id: string): void }).deliverPending(rec.agentId);
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toBe(2);
    expect(sent).toEqual([{ text: "[from a] one", images: undefined }]);
    const pending = new MailboxStore(dir).pending(rec.agentId);
    expect(pending.map((m) => m.text)).toEqual(["two", "three"]);
    expect(pending[0]).toMatchObject({ from: "b", text: "two", images: [PNG] });   // the failed image message keeps its image
    expect(pending[1]!.images).toBeUndefined();
  });
});
