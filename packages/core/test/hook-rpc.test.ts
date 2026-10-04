import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { HookRule } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

// HOOK-CRUD-RPC: hook rules live in ChimeraConfig.hooks (the config.d overlay) and, until this
// family existed, the ONLY way to touch them was config.get -> mutate the whole array ->
// config.patch. That is three round trips for the caller, which means two agents adding a rule
// concurrently silently clobber each other (the second one's patch replaces the array the first
// one just grew — JSON-merge-patch has no array merge). These RPCs do the same read-modify-write
// INSIDE one synchronous engine turn, so the interleaving is structurally impossible, and give
// the MCP surface a real hook_create/hook_list/... instead of "hand-assemble a config patch".

const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]);

const RULE = (name: string): Record<string, unknown> => ({
  name, on: "queue.drained", actions: [{ type: "channel", channel: "toast" }],
});

// A content-topic (matchField "text") rule needs `contains` to pass HookRuleSchema.
const CONTENT_RULE = (name: string): Record<string, unknown> => ({
  name, on: "agent.output", filter: { contains: "xyz" }, actions: [{ type: "channel", channel: "toast" }],
});

describe("hook.* RPC family", () => {
  it("create -> list -> update -> setEnabled -> delete round-trips through the config overlay", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });

    expect(await e.handle("hook.list", {})).toEqual([]);

    const created = await e.handle("hook.create", { rule: RULE("drain-toast") }) as HookRule;
    expect(created.name).toBe("drain-toast");
    expect(created.enabled).toBe(true);
    expect(created.maxChainDepth).toBe(3);      // schema defaults are applied, not left undefined
    expect(created.maxFiresPerHour).toBe(20);

    expect(((await e.handle("hook.list", {})) as HookRule[]).map((r) => r.name)).toEqual(["drain-toast"]);

    const updated = await e.handle("hook.update", {
      name: "drain-toast", patch: { maxFiresPerHour: 5, filter: { queue: ["q-a"] } },
    }) as HookRule;
    expect(updated.maxFiresPerHour).toBe(5);
    expect(updated.filter).toEqual({ queue: ["q-a"] });
    expect(updated.on).toBe("queue.drained");   // untouched fields survive a sparse patch

    const disabled = await e.handle("hook.setEnabled", { name: "drain-toast", enabled: false }) as HookRule;
    expect(disabled.enabled).toBe(false);

    expect(await e.handle("hook.delete", { name: "drain-toast" })).toEqual({ deleted: true });
    expect(await e.handle("hook.list", {})).toEqual([]);
  });

  it("the live HookEngine sees a rule created this way with no restart (same diff-apply as config.patch)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("hook.create", { rule: RULE("live") });
    const cfg = await e.handle("config.get", {}) as { hooks: Array<{ name: string }> };
    expect(cfg.hooks.map((r) => r.name)).toEqual(["live"]);   // one storage, one source of truth
  });

  it("two creates in a row both survive — the clobber config_patch's read-modify-write allows", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    // Issued without awaiting the first: this is exactly the interleaving that loses a rule when
    // each caller does its own config.get/config.patch pair.
    await Promise.all([
      e.handle("hook.create", { rule: RULE("a") }),
      e.handle("hook.create", { rule: RULE("b") }),
    ]);
    const names = ((await e.handle("hook.list", {})) as HookRule[]).map((r) => r.name).sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("a duplicate name is refused rather than silently replacing the existing rule", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("hook.create", { rule: RULE("dup") });
    await expect(e.handle("hook.create", { rule: RULE("dup") })).rejects.toBeTruthy();
    expect(((await e.handle("hook.list", {})) as HookRule[])).toHaveLength(1);
  });

  it("update/setEnabled/delete on an unknown name are errors, not silent no-ops", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await expect(e.handle("hook.update", { name: "nope", patch: { enabled: false } })).rejects.toBeTruthy();
    await expect(e.handle("hook.setEnabled", { name: "nope", enabled: false })).rejects.toBeTruthy();
    await expect(e.handle("hook.delete", { name: "nope" })).rejects.toBeTruthy();
  });

  it("an invalid rule is rejected whole and nothing is written (config_error posture)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("hook.create", { rule: RULE("keeper") });
    await expect(e.handle("hook.create", { rule: { name: "bad", on: "not-a-real-topic", actions: [] } }))
      .rejects.toBeTruthy();
    expect(((await e.handle("hook.list", {})) as HookRule[]).map((r) => r.name)).toEqual(["keeper"]);
  });

  it("a patch that would make the rule invalid leaves the stored rule untouched", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("hook.create", { rule: RULE("solid") });
    await expect(e.handle("hook.update", { name: "solid", patch: { actions: [] } })).rejects.toBeTruthy();
    const [rule] = (await e.handle("hook.list", {})) as HookRule[];
    expect(rule!.actions).toHaveLength(1);
  });

  // F46/QA finding B (second half): subscriptions have MAX_CONTENT_SUBS_TOTAL, but content hook
  // rules (matchField "text") had no equivalent cap — each one scans every agent.output event,
  // so an unbounded pile of them is the same daemon-wide cost problem subscriptions already guard.
  it("the 65th content hook rule (matchField \"text\") is refused; a non-content rule is unaffected", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    for (let i = 0; i < 64; i++) {
      await e.handle("hook.create", { rule: CONTENT_RULE(`c${i}`) });
    }
    await expect(e.handle("hook.create", { rule: CONTENT_RULE("c64") })).rejects.toBeTruthy();
    expect(((await e.handle("hook.list", {})) as HookRule[])).toHaveLength(64);

    // A lifecycle rule (no matchField) is unaffected by the content cap.
    const lifecycle = await e.handle("hook.create", { rule: RULE("drain") }) as HookRule;
    expect(lifecycle.name).toBe("drain");
  });
});
