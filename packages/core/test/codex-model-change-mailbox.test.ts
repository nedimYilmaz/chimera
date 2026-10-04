import { describe, it, expect, vi } from "vitest";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { CodexAgentBackend } from "@chimera/core/backends/codex";
import { validateCodexModel } from "@chimera/core/providers/codex-cli-models";
import { fakeCodex } from "./codex-backend-helpers.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Codex mailbox delivery after a model change", () => {
  it.each(["setModel", "reconfigure"] as const)("%s preserves the selected model on the next incoming message", async (method) => {
    const home = mkdtempSync(join(tmpdir(), "chimera-model-mail-"));
    const config = ChimeraConfigSchema.parse({
      accounts: [{ name: "cx", provider: "codex", auth: { type: "subscription", homeDir: home } }],
      autoOrder: ["cx"],
    });
    const { factory, threads, resumedIds } = fakeCodex([
      [{ type: "thread.started", thread_id: "th-1" }, { type: "turn.completed" }],
      [{ type: "item.completed", item: { id: "reply", type: "agent_message", text: "received" } }, { type: "turn.completed" }],
    ]);
    const validateModel: typeof validateCodexModel = (model, effort, images, env) => validateCodexModel(model, effort, images, env, async () => ({
      code: 0,
      stdout: JSON.stringify({ models: ["gpt-6-astra", "gpt-6-sol"].map(slug => ({ slug, supports_search_tool: true })) }),
    }));
    const events = new EventLog(home);
    const sup = new AgentSupervisor({
      registry: new AccountRegistry(config), credentials: new CredentialResolver(),
      backends: new Map([["codex", new CodexAgentBackend({ codexFactory: factory, validateModel })]]),
      events, mailboxes: new MailboxStore(home), cooldowns: new CooldownTracker(60_000),
    });
    const initial = await sup.spawn({
      provider: "codex", account: "cx", model: "gpt-6-astra", prompt: "initial task",
      cwd: home, isolation: "none", conductor: true,
      providerOptions: { model: "gpt-6-astra", codexTransport: "exec" },
    });
    try {
      await vi.waitFor(() => expect(events.tail(initial.agentId, 50).some(e => e.kind === "turn_complete")).toBe(true));
      if (method === "setModel") await sup.setModel(initial.agentId, "gpt-6-sol");
      else await sup.reconfigure(initial.agentId, { model: "gpt-6-sol" });

      expect(resumedIds).toEqual(["th-1"]);
      expect(threads[1]!.runs).toHaveLength(0);
      await sup.send(initial.agentId, "Please review this test fixture", "reviewer-agent");
      await vi.waitFor(() => expect(events.tail(initial.agentId, 50).some(e => e.kind === "message_complete" && e.data.text === "received")).toBe(true));
      expect(sup.status(initial.agentId).state).not.toBe("failed");
      expect(threads[1]!.options?.model).toBe("gpt-6-sol");
      expect(threads[1]!.runs).toHaveLength(1);
      expect(threads[1]!.runs[0]!.input).toContain("Please review this test fixture");
      expect(sup.status(initial.agentId).spec.providerOptions).not.toHaveProperty("model");
      expect(sup.status(initial.agentId).spec.providerOptions.codexTransport).toBe("exec");
      expect(initial.spec.providerOptions.model).toBe("gpt-6-astra");
      expect(events.tail(initial.agentId, 50).filter(e => e.kind === "error")).toEqual([]);
    } finally {
      await sup.kill(initial.agentId);
    }
  });
});
