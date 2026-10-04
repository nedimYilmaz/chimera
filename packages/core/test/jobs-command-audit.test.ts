import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// The ledger is append-only JSONL with no read API by design (append + verify only) — read it
// the way an auditor would.
const ledger = (home: string): Array<Record<string, unknown>> => {
  const file = join(home, "audit", "ledger.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
};

// SECURITY (sandbox-escape-rce): agents may create command jobs by an explicit operator decision,
// so the answer is not refusal — it is that the capability can never be SILENT. A scheduled shell
// command runs unattended with the daemon's own privileges, outside the permission profile of
// whoever asked for it, which makes "what scheduled shell exists here and who put it there" a
// question that must stay answerable after the fact.

const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend([[{ awaitSend: true }]])]]);

describe("creating a command job is audited", () => {
  it("writes a hash-chained ledger entry naming the command and the schedule", async () => {
    const home = makeEngineHome();
    const e = new Engine({ home, backends: backends() });
    await e.handle("job.create", {
      spec: { name: "sso", schedule: { cron: "0 9 * * *" }, target: { command: "aws sso login --no-browser" } },
    });

    const entries = ledger(home);
    const entry = entries.find((x) => x["action"] === "job_command_created");
    expect(entry).toBeDefined();
    expect(entry!["resource"]).toBe("sso");
    expect((entry!["detail"] as Record<string, unknown>)["command"]).toBe("aws sso login --no-browser");
    expect(String(entry!["reason"])).toContain("daemon privileges");
  });

  it("does NOT audit an ordinary agent job — the ledger records the exemption, not every schedule", async () => {
    const home = makeEngineHome();
    const e = new Engine({ home, backends: backends() });
    await e.handle("job.create", {
      spec: {
        name: "nightly", schedule: { cron: "0 3 * * *" }, prompt: "audit deps",
        target: { agentSpec: { cwd: "/tmp", isolation: "none" } },
      },
    });
    expect(ledger(home).some((x) => x["action"] === "job_command_created")).toBe(false);
  });
});
