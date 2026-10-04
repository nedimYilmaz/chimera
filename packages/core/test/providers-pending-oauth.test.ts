import { describe, it, expect } from "vitest";
import { PendingOAuthStore } from "@chimera/core/providers/pending-oauth";

describe("F23-2A: PendingOAuthStore", () => {
  it("starts pending, resolves to ready, get() returns the token", () => {
    const store = new PendingOAuthStore();
    const { id } = store.create("copilot");
    expect(store.get(id)?.state).toEqual({ status: "pending" });
    store.resolve(id, { accessToken: "tok-1" });
    expect(store.get(id)?.state).toEqual({ status: "ready", token: { accessToken: "tok-1" } });
  });

  it("fail() moves a pending record to error", () => {
    const store = new PendingOAuthStore();
    const { id } = store.create("copilot");
    store.fail(id, "device code expired");
    expect(store.get(id)?.state).toEqual({ status: "error", message: "device code expired" });
  });

  it("get() on an unknown id returns undefined", () => {
    const store = new PendingOAuthStore();
    expect(store.get("nope")).toBeUndefined();
  });

  it("delete() removes the record", () => {
    const store = new PendingOAuthStore();
    const { id } = store.create("copilot");
    store.delete(id);
    expect(store.get(id)).toBeUndefined();
  });

  it("a record past its TTL is lazily swept — get() returns undefined", () => {
    let now = 1_000_000;
    const store = new PendingOAuthStore(() => now);
    const { id } = store.create("copilot", 5_000);
    expect(store.get(id)).toBeDefined();
    now += 5_001;
    expect(store.get(id)).toBeUndefined();
  });

  it("resolve()/fail() on an expired-and-swept id are no-ops (never throw)", () => {
    let now = 0;
    const store = new PendingOAuthStore(() => now);
    const { id } = store.create("copilot", 1_000);
    now = 2_000;
    expect(store.get(id)).toBeUndefined();   // sweeps it
    expect(() => store.resolve(id, { accessToken: "x" })).not.toThrow();
    expect(() => store.fail(id, "x")).not.toThrow();
  });

  it("each create() mints a distinct id", () => {
    const store = new PendingOAuthStore();
    const a = store.create("copilot").id;
    const b = store.create("copilot").id;
    expect(a).not.toBe(b);
  });
});
