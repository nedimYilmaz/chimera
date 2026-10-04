import { describe, it, expect, vi } from "vitest";
import { SubRpc } from "@chimera/core/rpc/sub-rpc";
import type { SubscriptionRegistry } from "@chimera/core/subscriptions";
import type { Subscription } from "@chimera/protocol";

// SubRpc is a 3-line passthrough onto SubscriptionRegistry (sub.create/remove/list). These direct
// dispatch tests prove the wiring (which registry method each handler calls, and how it shapes the
// return) without standing up the full registry — a stub registry with spied methods suffices.
function makeRpc(overrides: Partial<Record<"create" | "remove" | "list", ReturnType<typeof vi.fn>>> = {}) {
  const create = overrides.create ?? vi.fn();
  const remove = overrides.remove ?? vi.fn();
  const list = overrides.list ?? vi.fn();
  const registry = { create, remove, list } as unknown as SubscriptionRegistry;
  const rpc = new SubRpc({ registry });
  return { rpc, create, remove, list };
}

const SUB: Subscription = { id: "s1", subscriberId: "a1", topic: "queue.drained", once: true, wake: "deliver" };

describe("SubRpc dispatch (HOOK-2, PLAN-HOOKS.md §6.1)", () => {
  it("exposes exactly the sub.create/sub.remove/sub.list handlers", () => {
    const { rpc } = makeRpc();
    expect(Object.keys(rpc.handlers).sort()).toEqual(["sub.create", "sub.list", "sub.remove"]);
  });

  it("sub.create forwards the raw payload to registry.create and returns its result verbatim", () => {
    const { rpc, create } = makeRpc({ create: vi.fn().mockReturnValue(SUB) });
    const payload = { subscriberId: "a1", topic: "queue.drained" };
    expect(rpc.handlers["sub.create"](payload as never)).toBe(SUB);
    expect(create).toHaveBeenCalledWith(payload);
  });

  it("sub.remove passes (subscriberId, id) through and wraps the boolean in { removed }", () => {
    const { rpc, remove } = makeRpc({ remove: vi.fn().mockReturnValue(true) });
    expect(rpc.handlers["sub.remove"]({ subscriberId: "a1", id: "s1" } as never)).toEqual({ removed: true });
    expect(remove).toHaveBeenCalledWith("a1", "s1");
  });

  it("sub.remove reflects a false removal (wrong owner / unknown id)", () => {
    const { rpc } = makeRpc({ remove: vi.fn().mockReturnValue(false) });
    expect(rpc.handlers["sub.remove"]({ subscriberId: "a1", id: "ghost" } as never)).toEqual({ removed: false });
  });

  it("sub.list forwards the subscriberId and returns the registry's array unchanged", () => {
    const { rpc, list } = makeRpc({ list: vi.fn().mockReturnValue([SUB]) });
    expect(rpc.handlers["sub.list"]({ subscriberId: "a1" } as never)).toEqual([SUB]);
    expect(list).toHaveBeenCalledWith("a1");
  });
});
