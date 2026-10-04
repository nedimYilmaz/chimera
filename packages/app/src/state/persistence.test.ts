import { beforeEach, describe, expect, it } from "vitest";
import type { OutboxItem } from "@chimera/ui-state";
import {
  DRAFT_STORAGE_KEY,
  loadPersistedDraft,
  loadPersistedOutbox,
  OUTBOX_STORAGE_KEY,
  persistDraft,
  persistOutbox,
} from "./persistence";

// node test env has no localStorage global — stub a minimal Storage so this
// file exercises the real read/write paths, same shape as the browser API.
class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: FakeStorage }).localStorage = new FakeStorage();
});

describe("outbox persistence", () => {
  it("round-trips a queued item through persist -> restore", () => {
    const item: OutboxItem = { id: "q0", agentId: "agent-1", text: "hello" };
    persistOutbox([item]);
    expect(loadPersistedOutbox()).toEqual([item]);
  });

  it("does not restore an item that was delivered (removed before the next persist)", () => {
    const item: OutboxItem = { id: "q0", agentId: "agent-1", text: "hello" };
    persistOutbox([item]);
    persistOutbox([]); // delivery = outboxRemove, same-tick persist of the new (empty) queue
    expect(loadPersistedOutbox()).toEqual([]);
  });

  it("yields an empty queue (never throws) on corrupt stored JSON", () => {
    localStorage.setItem(OUTBOX_STORAGE_KEY, "{not json");
    expect(() => loadPersistedOutbox()).not.toThrow();
    expect(loadPersistedOutbox()).toEqual([]);
  });

  it("yields an empty queue when the stored value isn't an array", () => {
    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify({ not: "an array" }));
    expect(loadPersistedOutbox()).toEqual([]);
  });

  it("drops images from an oversized item at the boundary instead of refusing/throwing", () => {
    const huge = "x".repeat(30_000);
    const item: OutboxItem = { id: "q0", agentId: "agent-1", text: "hi", images: [{ mediaType: "image/png", data: huge }] };
    persistOutbox([item]);
    const restored = loadPersistedOutbox();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.text).toBe("hi");
    expect(restored[0]?.images).toBeUndefined();
  });

  it("drops the oldest items to fit the total size cap", () => {
    const items: OutboxItem[] = Array.from({ length: 50 }, (_, i) => ({
      id: `q${i}`,
      agentId: "agent-1",
      text: "x".repeat(10_000),
    }));
    persistOutbox(items);
    const restored = loadPersistedOutbox();
    expect(restored.length).toBeLessThan(items.length);
    // survivors are the most recent ones (oldest dropped first)
    expect(restored[restored.length - 1]?.id).toBe(`q${items.length - 1}`);
  });
});

describe("draft persistence", () => {
  it("round-trips draft text through persist -> restore", () => {
    persistDraft("work in progress");
    expect(loadPersistedDraft()).toBe("work in progress");
  });

  it("clears storage when persisting empty draft text", () => {
    persistDraft("something");
    persistDraft("");
    expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
    expect(loadPersistedDraft()).toBe("");
  });

  it("never throws and yields empty string when storage is unavailable", () => {
    // simulate private-mode / disabled storage
    (globalThis as unknown as { localStorage: unknown }).localStorage = undefined;
    expect(() => persistDraft("x")).not.toThrow();
    expect(loadPersistedDraft()).toBe("");
  });
});
