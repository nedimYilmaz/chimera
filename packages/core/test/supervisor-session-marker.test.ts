import { describe, expect, it } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor } from "./helpers.js";

describe("session marker", () => {
  it("rides the registered-agent status event", async () => {
    const scenario: FakeStep[] = [{ end: { resultText: "done" } }];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", session: true });
    const tail = events.tail(rec.agentId, 10);
    const registered = tail.find((e) => e.kind === "status" && e.data["registered"] === true);
    expect(registered?.data["session"]).toBe(true);
  });

  it("omits the field for a plain (non-session) spawn — byte-identical to today", async () => {
    const scenario: FakeStep[] = [{ end: { resultText: "done" } }];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp" });
    const tail = events.tail(rec.agentId, 10);
    const registered = tail.find((e) => e.kind === "status" && e.data["registered"] === true);
    expect(registered?.data["session"]).toBeUndefined();
  });

  it("rides agent_started too", async () => {
    const scenario: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "done" } }];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", session: true });
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 10);
    const started = tail.find((e) => e.kind === "agent_started");
    expect(started?.data["session"]).toBe(true);
  });
});

describe("renameAgent", () => {
  it("updates displayLabel and re-emits it", async () => {
    const scenario: FakeStep[] = [{ end: { resultText: "done" } }];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", session: true });
    await sup.waitFor(rec.agentId, 1000);
    await sup.renameAgent(rec.agentId, "gitops PR 246 — helm values drift");
    expect(sup.status(rec.agentId)?.displayLabel).toBe("gitops PR 246 — helm values drift");
    const tail = events.tail(rec.agentId, 20);
    expect(tail.some((e) => e.data["displayLabel"] === "gitops PR 246 — helm values drift")).toBe(true);
  });

  // REBIND task, decision #2: rename_self is one-shot — never overwrites an operator's
  // explicit spawn-time name, never moves twice.
  it("never overwrites a displayLabel the operator set explicitly at spawn — a no-op, not a throw", async () => {
    const scenario: FakeStep[] = [{ end: { resultText: "done" } }];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", session: true, displayLabel: "operator's own name" });
    await sup.waitFor(rec.agentId, 1000);
    const before = events.tail(rec.agentId, 50).length;

    await sup.renameAgent(rec.agentId, "agent's guess at a name");

    expect(sup.status(rec.agentId)?.displayLabel).toBe("operator's own name");
    expect(events.tail(rec.agentId, 50).length).toBe(before);   // no spurious status event either
  });

  it("never renames twice — a second rename_self call is a silent no-op", async () => {
    const scenario: FakeStep[] = [{ end: { resultText: "done" } }];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", session: true });
    await sup.waitFor(rec.agentId, 1000);

    await sup.renameAgent(rec.agentId, "first real name");
    const before = events.tail(rec.agentId, 50).length;
    await sup.renameAgent(rec.agentId, "second attempted name");

    expect(sup.status(rec.agentId)?.displayLabel).toBe("first real name");
    expect(events.tail(rec.agentId, 50).length).toBe(before);
  });
});
