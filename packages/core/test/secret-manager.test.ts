import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { InMemoryKeychain } from "@chimera/core/keychain";
import { secretEnvVar, secretService } from "@chimera/core/secrets";
import { makeEngineHome } from "./helpers.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// SECRET-MANAGER: operator-held secrets in the keychain, readable only by specifically granted
// agents. Default is DENY, the value never leaves the keychain except to a granted agent, and
// every grant and read is provable afterwards.

const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend(
  Array.from({ length: 10 }, () => [{ awaitSend: true }]),
)]]);
const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const rig = () => {
  const home = makeEngineHome();
  const keychain = new InMemoryKeychain();
  const e = new Engine({ home, backends: backends(), keychain });
  return { e, home, keychain };
};
const spawn = async (e: Engine, spec: Record<string, unknown> = {}) =>
  (await e.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none", ...spec } })) as { agentId: string };

const ledger = (home: string): Array<Record<string, unknown>> => {
  const f = join(home, "audit", "ledger.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

describe("default is deny", () => {
  it("an ungranted agent cannot read a secret that exists", async () => {
    const { e } = rig();
    await e.handle("secret.set", { name: "aws-prod", value: "AKIA-super-secret" });
    const a = await spawn(e);
    await flush();
    await expect(e.handle("secret.read", { name: "aws-prod", agentId: a.agentId })).rejects.toThrow();
  });

  it("refuses an ungranted secret and a NONEXISTENT one identically — no existence oracle over the operator's key names", async () => {
    const { e } = rig();
    await e.handle("secret.set", { name: "real-one", value: "v" });
    const a = await spawn(e);
    await flush();
    const err = async (name: string) => {
      try { await e.handle("secret.read", { name, agentId: a.agentId }); return ""; }
      catch (x) { return (x as Error).message.replace(name, "<name>"); }
    };
    expect(await err("real-one")).toBe(await err("does-not-exist"));
  });

  it("lists only what THIS agent is granted — what else exists is not its business", async () => {
    const { e } = rig();
    await e.handle("secret.set", { name: "mine", value: "v1" });
    await e.handle("secret.set", { name: "not-mine", value: "v2" });
    const a = await spawn(e);
    await flush();
    await e.handle("secret.grant", { name: "mine", agent: a.agentId, mode: "reveal" });

    const res = await e.handle("secret.listForAgent", { agentId: a.agentId }) as { secrets: Array<{ name: string }> };
    expect(res.secrets.map((s) => s.name)).toEqual(["mine"]);
  });
});

describe("a value never leaves the keychain except to a granted agent", () => {
  it("secret.list returns metadata and NO value", async () => {
    const { e } = rig();
    await e.handle("secret.set", { name: "k", value: "the-actual-value", description: "prod key" });
    const res = await e.handle("secret.list", {}) as { secrets: unknown[] };
    expect(JSON.stringify(res)).not.toContain("the-actual-value");
    expect(JSON.stringify(res)).toContain("prod key");
  });

  it("never writes the value to secrets.json — only the keychain holds it", async () => {
    const { e, home, keychain } = rig();
    await e.handle("secret.set", { name: "k", value: "the-actual-value" });
    expect(readFileSync(join(home, "secrets.json"), "utf8")).not.toContain("the-actual-value");
    expect(await keychain.get(secretService("k"))).toBe("the-actual-value");
  });

  it("a granted agent reads it, and the read registers the value for redaction", async () => {
    const { e } = rig();
    await e.handle("secret.set", { name: "k", value: "sk-live-9999" });
    const a = await spawn(e);
    await flush();
    await e.handle("secret.grant", { name: "k", agent: a.agentId, mode: "reveal" });

    const got = await e.handle("secret.read", { name: "k", agentId: a.agentId }) as { value: string };
    expect(got.value).toBe("sk-live-9999");
    // The realistic leak is the AGENT echoing it back in its own output — that path runs through
    // the supervisor's sink, which scrubs both `data` and `raw`.
    (e.supervisor as unknown as { onEvent(rec: unknown, ev: unknown): void })
      .onEvent(e.supervisor.status(a.agentId), { kind: "message_complete", data: { text: "the key is sk-live-9999" } });
    await flush();
    expect(JSON.stringify(e.events.tail(a.agentId, 20))).not.toContain("sk-live-9999");
  });
});

describe("the two grant modes", () => {
  it("an inject grant is NOT readable — the value is in the process, not the context", async () => {
    const { e } = rig();
    await e.handle("secret.set", { name: "tok", value: "v" });
    const a = await spawn(e);
    await flush();
    await e.handle("secret.grant", { name: "tok", agent: a.agentId, mode: "inject" });

    // The refusal points at the env-var route WITHOUT naming a specific variable: for a secret
    // that does not exist there is no variable, and a message implying one sends the agent
    // chasing a name nothing will ever set. Uniformity beats helpfulness here.
    await expect(e.handle("secret.read", { name: "tok", agentId: a.agentId }))
      .rejects.toThrow(/CHIMERA_SECRET_\*/);
  });

  it("and lands in the agent's environment at its next process start", async () => {
    const { e } = rig();
    await e.handle("secret.set", { name: "aws/prod-key", value: "AKIA-1" });
    const a = await spawn(e);
    await flush();
    const res = await e.handle("secret.grant", { name: "aws/prod-key", agent: a.agentId, mode: "inject" }) as
      { appliesAtNextStart?: boolean; envVar?: string };

    // Said out loud rather than left for the operator to assume — env is fixed at launch.
    expect(res.appliesAtNextStart).toBe(true);
    expect(res.envVar).toBe("CHIMERA_SECRET_AWS_PROD_KEY");
    expect(await e.secrets.injectedEnvFor(a.agentId)).toEqual({ CHIMERA_SECRET_AWS_PROD_KEY: "AKIA-1" });
  });
});

describe("grants are bound to the agent", () => {
  it("can be given by NAME, not just id — the operator thinks in names", async () => {
    const { e } = rig();
    await e.handle("secret.set", { name: "k", value: "v" });
    const a = await spawn(e, { displayLabel: "deployer" });
    await flush();
    const res = await e.handle("secret.grant", { name: "k", agent: "deployer", mode: "reveal" }) as { agentId: string };
    expect(res.agentId).toBe(a.agentId);
  });

  it("REFUSES an ambiguous name rather than guessing which agent gets the secret", async () => {
    const { e } = rig();
    await e.handle("secret.set", { name: "k", value: "v" });
    await spawn(e, { displayLabel: "twin" });
    await spawn(e, { displayLabel: "twin" });
    await flush();
    await expect(e.handle("secret.grant", { name: "k", agent: "twin", mode: "reveal" })).rejects.toThrow(/names 2 agents/);
  });

  it("dies with the agent — a killed agent's grant is gone, not merely unusable", async () => {
    const { e } = rig();
    await e.handle("secret.set", { name: "k", value: "v" });
    const a = await spawn(e);
    await flush();
    await e.handle("secret.grant", { name: "k", agent: a.agentId, mode: "reveal" });
    expect(e.secrets.grantFor("k", a.agentId)).not.toBeNull();

    await e.handle("agent.kill", { agentId: a.agentId });
    expect(e.secrets.grantFor("k", a.agentId)).toBeNull();
    expect(e.secrets.list()[0]!.grants).toEqual([]);
    await expect(e.handle("secret.read", { name: "k", agentId: a.agentId })).rejects.toThrow();
  });

  it("revoke removes it immediately", async () => {
    const { e } = rig();
    await e.handle("secret.set", { name: "k", value: "v" });
    const a = await spawn(e);
    await flush();
    await e.handle("secret.grant", { name: "k", agent: a.agentId, mode: "reveal" });
    await e.handle("secret.revoke", { name: "k", agent: a.agentId });
    await expect(e.handle("secret.read", { name: "k", agentId: a.agentId })).rejects.toThrow();
  });
});

describe("everything is provable afterwards", () => {
  it("records the grant, the read, and the refusal", async () => {
    const { e, home } = rig();
    await e.handle("secret.set", { name: "k", value: "v" });
    const granted = await spawn(e);
    const denied = await spawn(e);
    await flush();
    await e.handle("secret.grant", { name: "k", agent: granted.agentId, mode: "reveal" });
    await e.handle("secret.read", { name: "k", agentId: granted.agentId });
    await e.handle("secret.read", { name: "k", agentId: denied.agentId }).catch(() => {});

    const entries = ledger(home);
    expect(entries.some((x) => x["action"] === "secret_written")).toBe(true);
    expect(entries.some((x) => x["action"] === "secret_granted" && x["decision"] === "allow")).toBe(true);
    expect(entries.some((x) => x["action"] === "secret_read" && x["decision"] === "allow" && x["agentId"] === granted.agentId)).toBe(true);
    expect(entries.some((x) => x["action"] === "secret_read" && x["decision"] === "deny" && x["agentId"] === denied.agentId)).toBe(true);
    // and the ledger itself never carries the value
    expect(JSON.stringify(entries)).not.toContain('"v"');
  });
});
