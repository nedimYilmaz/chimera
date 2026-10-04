import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { ExecFn } from "@chimera/core/credentials";

// F08/D7 residual: host.setPolicy migrated from its own ${home}/toolpolicy.json onto the config.d
// overlay via configstore, with a one-time boot migration of any legacy toolpolicy.json.

const hostExec: ExecFn = async (cmd, args) => {
  if (cmd === "kubectl" && args[0] === "version") return { stdout: "Client Version: v1.30.2", code: 0 };
  if (cmd === "kubectl" && args[0] === "config") return { stdout: "prod\nstaging\n", code: 0 };
  return { stdout: "", code: 1 };
};

function home(policy?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "chimera-tpol-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
    autoOrder: ["main"], ...(policy ? { toolPolicy: policy } : {}),
  }));
  return dir;
}
const engineOn = (dir: string) =>
  new Engine({ home: dir, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]), hostExec });

describe("host.setPolicy → config.d overlay", () => {
  it("writes to config.d/ui.json (NOT toolpolicy.json) and applies live", async () => {
    const dir = home();
    const e = engineOn(dir);
    await e.handle("host.setPolicy", { tool: "kubectl", profile: "prod", mode: "deny" });

    // the write landed in the config.d overlay, and legacy toolpolicy.json was NEVER created
    const ui = JSON.parse(readFileSync(join(dir, "config.d", "ui.json"), "utf8"));
    expect(ui.toolPolicy.kubectl.prod).toBe("deny");
    expect(existsSync(join(dir, "toolpolicy.json"))).toBe(false);

    // effective on the very next scan + across a restart (overlay persists)
    const st = await engineOn(dir).handle("host.tools", {}) as { tools: Array<{ tool: string; policy: Record<string, string> }> };
    expect(st.tools.find((t) => t.tool === "kubectl")?.policy).toEqual({ prod: "deny" });
  });

  it("migrates a legacy toolpolicy.json onto the overlay ONCE on boot, then renames it aside", async () => {
    const dir = home({ kubectl: { "*": "ask" } });   // config.json base layer
    // a legacy overlay file from before the migration — historically it WON over config.json
    writeFileSync(join(dir, "toolpolicy.json"), JSON.stringify({ kubectl: { prod: "deny" } }));

    const e = engineOn(dir);   // construction runs the one-time migration
    // legacy file is renamed aside; its content now lives in the config.d overlay
    expect(existsSync(join(dir, "toolpolicy.json"))).toBe(false);
    expect(existsSync(join(dir, "toolpolicy.json.migrated"))).toBe(true);
    const ui = JSON.parse(readFileSync(join(dir, "config.d", "ui.json"), "utf8"));
    expect(ui.toolPolicy.kubectl).toEqual({ "*": "ask", prod: "deny" });   // legacy merged over config

    const st = await e.handle("host.tools", {}) as { tools: Array<{ tool: string; policy: Record<string, string> }> };
    expect(st.tools.find((t) => t.tool === "kubectl")?.policy).toEqual({ "*": "ask", prod: "deny" });

    // a second boot does not re-migrate (no toolpolicy.json to find)
    const dir2files = existsSync(join(dir, "toolpolicy.json"));
    expect(dir2files).toBe(false);
  });
});
