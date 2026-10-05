import { describe, expect, it } from "vitest";
import { initialState, reduce } from "@chimera/ui-state";
import type { NormalizedEvent } from "@chimera/protocol";
import { readFileSync } from "node:fs";
const fixture = JSON.parse(readFileSync(new URL("../../core/test/fixtures/codex-image-generation.json", import.meta.url), "utf8"));
const image = { mediaType: "image/png", data: fixture.result };
const event = (agentId: string, seq: number, kind: NormalizedEvent["kind"], data: Record<string, unknown>): NormalizedEvent => ({ agentId, seq, ts: seq, kind, data });
const events = [
  event("owner", 1, "tool_call", { toolId: "image", toolName: "image_generation" }),
  event("other", 2, "tool_call", { toolId: "image", toolName: "parallel" }),
  event("owner", 3, "tool_result", { toolId: "image", images: [image] }),
];
const feed = (rows: NormalizedEvent[]) => rows.reduce((s, e) => reduce(s, { type: "event", event: e }), initialState);

describe("tool image transcript projection", () => {
  it("keeps images on the correlated owning agent, with duplicate replay idempotent", () => {
    const state = feed(events);
    expect(state.agents.owner!.transcript).toEqual([expect.objectContaining({ role: "tool", status: "done", images: [image] })]);
    expect(state.agents.other!.transcript[0]).toMatchObject({ status: "called" });
    expect(state.agents.other!.transcript[0]).not.toHaveProperty("images");
    expect(reduce(state, { type: "event", event: events[2]! }).agents.owner!.transcript).toEqual(state.agents.owner!.transcript);
  });
  it("backfills persisted image output without clobbering live state", () => {
    const live = feed(events);
    const history = reduce(initialState, { type: "backfillHistory", agentId: "owner", events });
    expect(history.agents.owner!.transcript).toEqual(live.agents.owner!.transcript);
    expect(history.agents.other).toBeUndefined();
    expect(reduce(history, { type: "backfillHistory", agentId: "owner", events }).agents.owner!.transcript).toEqual(history.agents.owner!.transcript);
  });
  it("isolates anonymous image results from unrelated pending tools while retaining legacy text semantics", () => {
    const state = feed([events[0]!, event("owner", 2, "tool_result", { toolName: "anonymous_image", images: [image] })]);
    expect(state.agents.owner!.transcript).toEqual([
      expect.objectContaining({ toolId: "image", status: "called" }),
      expect.objectContaining({ toolName: "anonymous_image", status: "done", images: [image] }),
    ]);
    expect(state.agents.owner!.tools[0]!.status).toBe("called");
    const text = feed([events[0]!, event("owner", 2, "tool_result", { result: "legacy text" })]);
    expect(text.agents.owner!.transcript[0]).toMatchObject({ toolId: "image", status: "done", result: "legacy text" });
  });
  it("retains an orphan image result without resolving another running tool", () => {
    const state = feed([events[0]!, event("owner", 2, "tool_result", { toolId: "orphan", toolName: "image", images: [image] })]);
    expect(state.agents.owner!.transcript).toEqual([
      expect.objectContaining({ toolId: "image", status: "called" }),
      expect.objectContaining({ toolId: "orphan", status: "done", images: [image] }),
    ]);
  });
  it("refuses malformed and oversized persisted image attachments", () => {
    for (const images of [[{ ...image, mediaType: "image/svg+xml" }], [{ ...image, data: "bad" }], Array(5).fill(image), [{ ...image, data: "A".repeat(8 * 1024 * 1024) }]]) {
      const state = feed([events[0]!, event("owner", 2, "tool_result", { toolId: "image", images })]);
      expect(state.agents.owner!.transcript[0]).not.toHaveProperty("images");
      expect(state.agents.owner!.transcript[0]).toHaveProperty("imageOutputWarnings", ["invalid-or-unsupported"]);
    }
  });
});
