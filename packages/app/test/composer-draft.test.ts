import { describe, it, expect } from "vitest";
import { draftFromOutbox, switchDraftTo, imageTagText, findImageTags, type ComposerLocalState, type PendingImage } from "../src/state/commands.agents";

// Two reported losses, both silent, both in the compose buffer.

const img = (n: number, name = "image.png"): PendingImage => ({ mediaType: "image/png", data: `d${n}`, num: n, name });

const state = (over: Partial<ComposerLocalState> = {}): ComposerLocalState => ({
  composeText: "", pendingImages: [], nextImageNum: 1, draftOwner: null, drafts: {},
  target: "selected", targetMenuOpen: false, spawnOpen: false, spawnPrefillRole: null,
  slashDismissed: false, slashIndex: 0, dismissedPermissions: new Set(), dismissedQuestions: new Set(),
  toolDetail: null, permissionRaw: false, agentDetail: null, quote: null,
  ...over,
} as ComposerLocalState);

// DRAFT-PER-AGENT — "I typed something and left it there; switching agents should clear it, and
// coming back should bring it back". One shared buffer carried a half-written message to whoever
// you clicked next, where sending by reflex delivered it to the wrong agent.
describe("switchDraftTo", () => {
  it("parks the current buffer and starts the next agent clean", () => {
    const patch = switchDraftTo(state({ draftOwner: "a", composeText: "half a thought" }), "b")!;
    expect(patch.composeText).toBe("");
    expect(patch.drafts).toEqual({ a: { text: "half a thought", images: [], nextNum: 1 } });
    expect(patch.draftOwner).toBe("b");
  });

  it("brings the parked buffer back when you return", () => {
    const parked = state({ draftOwner: "b", drafts: { a: { text: "half a thought", images: [img(1)], nextNum: 2 } } });
    const patch = switchDraftTo(parked, "a")!;
    expect(patch.composeText).toBe("half a thought");
    expect(patch.pendingImages).toEqual([img(1)]);
    // The tag counter comes back too: a new attachment must not collide with a tag already in
    // the restored text.
    expect(patch.nextImageNum).toBe(2);
  });

  it("does NOTHING when the owner has not changed", () => {
    // Re-entering the same agent (a re-render, a target menu open/close) must not clear what is
    // currently being typed.
    expect(switchDraftTo(state({ draftOwner: "a", composeText: "typing" }), "a")).toBeNull();
  });

  it("treats an emptied draft as DELETED, not as one to resurrect", () => {
    const patch = switchDraftTo(state({ draftOwner: "a", composeText: "", drafts: { a: { text: "old", images: [], nextNum: 1 } } }), "b")!;
    expect(patch.drafts).toEqual({});
  });

  it("parks an image-only draft — no text is not no content", () => {
    const patch = switchDraftTo(state({ draftOwner: "a", composeText: "", pendingImages: [img(1)], nextImageNum: 2 }), "b")!;
    expect(patch.drafts).toEqual({ a: { text: "", images: [img(1)], nextNum: 2 } });
  });

  it("ADOPTS the buffer on the first swap instead of clearing it", () => {
    // With no owner yet, whatever is in the buffer is the reload-restored draft
    // (OUTBOX-SURVIVES-RELOAD) or something just typed. Clearing it would make opening the app the
    // one reliable way to lose a draft.
    const patch = switchDraftTo(state({ draftOwner: null, composeText: "survived a reload" }), "a")!;
    expect(patch).toEqual({ draftOwner: "a" });
  });

  it("keeps every other agent's parked draft untouched", () => {
    const patch = switchDraftTo(state({ draftOwner: "a", composeText: "x", drafts: { c: { text: "c's", images: [], nextNum: 1 } } }), "b")!;
    expect(patch.drafts).toMatchObject({ a: { text: "x" }, c: { text: "c's" } });
  });
});

// IMAGE-EDIT-LOSES-IMAGE — "I sent a message with an image; editing it back gives a placeholder,
// and re-sending sends 'image.png' instead of the picture". The queued item's `text` is the
// FLATTENED form, where the tag has already been replaced by the filename; restoring that alone
// left the word with nothing behind it. The faithful record was in the same item's `content`.
describe("draftFromOutbox", () => {
  it("rebuilds the inline tag AND the image behind it", () => {
    const restored = draftFromOutbox({
      text: "look at image.png please",
      content: [
        { type: "text", text: "look at " },
        { type: "image", mediaType: "image/png", data: "AAAA" },
        { type: "text", text: " please" },
      ],
    }, 1);
    expect(restored.text).toBe(`look at ${imageTagText(1, "image.png")} please`);
    expect(restored.images).toEqual([{ mediaType: "image/png", data: "AAAA", num: 1, name: "image.png" }]);
    expect(restored.nextNum).toBe(2);
  });

  it("puts a tag back for EVERY image, numbered so they cannot collide", () => {
    const restored = draftFromOutbox({
      text: "a image.png b image.jpeg",
      content: [
        { type: "text", text: "a " },
        { type: "image", mediaType: "image/png", data: "P" },
        { type: "text", text: " b " },
        { type: "image", mediaType: "image/jpeg", data: "J" },
      ],
    }, 1);
    expect(findImageTags(restored.text).map((t) => t.num)).toEqual([1, 2]);
    expect(restored.images.map((i) => i.data)).toEqual(["P", "J"]);
    // The label follows the media type, so a jpeg does not come back calling itself a png.
    expect(restored.images[1]!.name).toBe("image.jpeg");
  });

  it("round-trips: every restored tag has a pending image behind it", () => {
    // The actual failure was a tag (or a bare filename) with nothing behind it — this is the
    // invariant that was broken.
    const restored = draftFromOutbox({
      text: "x", content: [{ type: "image", mediaType: "image/webp", data: "W" }],
    }, 1);
    for (const tag of findImageTags(restored.text)) {
      expect(restored.images.some((i) => i.num === tag.num), `no image behind #${tag.num}`).toBe(true);
    }
  });

  it("leaves a plain text message exactly as it was", () => {
    expect(draftFromOutbox({ text: "just words" }, 1)).toEqual({ text: "just words", images: [], nextNum: 1 });
    expect(draftFromOutbox({ text: "just words", content: [] }, 1)).toEqual({ text: "just words", images: [], nextNum: 1 });
  });
});
