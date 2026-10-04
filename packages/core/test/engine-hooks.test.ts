import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);

describe("Engine hooks.* (PLAN-HOOKS.md §3, HOOK-4)", () => {
  it("ships an empty hooks array in a fresh config (additive, no default rules)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const cfg = await e.handle("config.get", {}) as { hooks: unknown[] };
    expect(cfg.hooks).toEqual([]);
  });

  it("config.patch({hooks}) live-updates the rule set (hot-reload, mirrors notify's D7 diff-apply)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const patched = await e.handle("config.patch", {
      patch: { hooks: [{ name: "r1", on: "queue.drained", actions: [{ type: "channel", channel: "toast" }] }] },
    }) as { changed: string[] };
    expect(patched.changed).toContain("hooks");
    const cfg = await e.handle("config.get", {}) as { hooks: Array<{ name: string }> };
    expect(cfg.hooks.map((r) => r.name)).toEqual(["r1"]);
  });

  it("agent.settled -> notify @conductor lands mail on the conductor fake's own transcript", async () => {
    const CONDUCTOR_SCRIPT: FakeStep[] = [{ awaitSend: true }];
    const CHILD_SCRIPT: FakeStep[] = [{ end: { resultText: "child done" } }];
    const fake = new FakeAgentBackend([CONDUCTOR_SCRIPT, CHILD_SCRIPT]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });

    await e.handle("config.patch", {
      patch: { hooks: [{
        name: "settle-notify", on: "agent.settled",
        actions: [{ type: "notify", to: "@conductor", text: "child {{agentId}} settled: {{data.state}}" }],
      }] },
    });

    const conductor = await e.handle("agent.spawn", { spec: { prompt: "lead", cwd: "/tmp", account: "main", isolation: "none" } }) as { agentId: string };
    await new Promise((r) => setTimeout(r, 10));   // let the conductor's fake backend reach awaitSend
    const child = await e.handle("agent.spawn", {
      spec: { prompt: "work", cwd: "/tmp", account: "main", isolation: "none" },
      treeId: conductor.agentId, depth: 1,
    }) as { agentId: string };

    await new Promise((r) => setTimeout(r, 20));   // let the child settle and the hook fire

    const fired = e.events.tail(null, 200).filter((ev) => ev.kind === "hook_fired");
    expect(fired.some((ev) => (ev.data as Record<string, unknown>)["rule"] === "settle-notify")).toBe(true);

    const echoed = e.events.tail(conductor.agentId, 50)
      .some((ev) => ev.kind === "message_complete" && String((ev.data as Record<string, unknown>)["text"]).includes(`child ${child.agentId} settled: done`));
    expect(echoed).toBe(true);
  });

  it("an invalid hooks patch is rejected and the old config is kept (config_error posture)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("config.patch", { patch: { hooks: [{ name: "bad", on: "not-a-real-topic", actions: [] }] } }))
      .rejects.toBeTruthy();
    const cfg = await e.handle("config.get", {}) as { hooks: unknown[] };
    expect(cfg.hooks).toEqual([]);
  });
});
