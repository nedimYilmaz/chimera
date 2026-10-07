import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Codex } from "@openai/codex-sdk";
import { CodexAgentBackend } from "@chimera/core/backends/codex";
import { cxSpec } from "./codex-backend-helpers.js";

it("actual SDK argv changes only on the next fresh exec and retains the same resumed session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chimera-permission-exec-"));
  const binary = join(dir, "offline.mjs"); const capture = join(dir, "argv.jsonl"); const events: any[] = [];
  writeFileSync(binary, `#!${process.execPath}\nimport{appendFileSync,readFileSync,existsSync}from'node:fs';\nprocess.stdin.resume();process.stdin.on('end',()=>{const n=existsSync(process.env.CAPTURE)?readFileSync(process.env.CAPTURE,'utf8').trim().split('\\n').length:0;appendFileSync(process.env.CAPTURE,JSON.stringify(process.argv.slice(2))+'\\n');console.log(JSON.stringify({type:'thread.started',thread_id:'offline-thread'}));console.log(JSON.stringify({type:'turn.started'}));const timer=setInterval(()=>{if(existsSync(process.env.CAPTURE+'.release'+n)){clearInterval(timer);console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,cached_input_tokens:0,output_tokens:0}}));}},5);});\n`, { mode: 0o700 });
  const backend = new CodexAgentBackend({ validateModel: async () => {}, codexFactory: options => new Codex({ ...options, config: options.config as never, codexPathOverride: binary, env: { PATH: process.env.PATH ?? "", HOME: dir, CODEX_HOME: dir, CAPTURE: capture } }) as never });
  const handle = backend.spawn(cxSpec({ cwd: dir, permissionProfile: "full", acknowledgeCodexFullAccessRisk: true, persistent: true }), e => events.push(e), async () => false);
  const rows = () => existsSync(capture) ? readFileSync(capture, "utf8").trim().split("\n").map(x => JSON.parse(x) as string[]) : [];
  try {
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toContain("danger-full-access");
    await vi.waitFor(() => expect(events.filter(e => e.data.permissionApplication).at(-1).data.permissionApplication).toMatchObject({ profileStatus: "unverified", submittedProfile: "full", submittedVersion: 0 }));
    expect(handle.updatePermission!({ version: 1, permissionProfile: "readOnly", permissionRequest: "tui" })).toMatchObject({ profileStatus: "pending", submittedProfile: "full", submittedVersion: 0, routingStatus: "unsupported", nativeApprovals: false });
    await handle.send("queued exactly once");
    expect(rows()).toHaveLength(1);
    writeFileSync(capture + ".release0", "");
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[1]).toContain("read-only");
    expect(rows()[1]).toContain("resume"); expect(rows()[1]).toContain("offline-thread");
    expect(rows()[1]).not.toContain("danger-full-access");
    await vi.waitFor(() => expect(events.filter(e => e.data.permissionApplication).at(-1).data.permissionApplication).toMatchObject({ profileStatus: "unverified", submittedProfile: "readOnly", submittedVersion: 1, nativeApprovals: false }));
    expect(events.filter(e => e.data.permissionApplication).every(e => e.data.permissionApplication.effectiveProfile === undefined)).toBe(true);
    writeFileSync(capture + ".release1", "");
    await vi.waitFor(() => expect(events.filter(e => e.kind === "turn_complete")).toHaveLength(2));
    expect(rows()).toHaveLength(2);
  } finally { await handle.kill(); rmSync(dir, { recursive: true, force: true }); }
});

it("exec initialization failure never establishes an effective profile", async () => {
  const events: any[] = [];
  const handle = new CodexAgentBackend({ validateModel: async () => {}, codexFactory: () => ({ startThread: () => ({ id: null, runStreamed: async () => { throw new Error("CLI launch rejected"); } }), resumeThread: () => { throw new Error("not used"); } }) }).spawn(cxSpec(), e => events.push(e), async () => false);
  try {
    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe("error"));
    expect(events.filter(e => e.data.permissionApplication).at(-1).data.permissionApplication).toMatchObject({ profileStatus: "failed", error: "Codex permission application could not be confirmed" });
    expect(events.filter(e => e.data.permissionApplication).some(e => e.data.permissionApplication.effectiveProfile)).toBe(false);
    expect(events.filter(e => e.kind === "error").at(-1).data.message).toContain("CLI launch rejected");
  } finally { await handle.kill(); }
});

it("permission updates preserve the explicit full-access risk guard", () => {
  const handle = new CodexAgentBackend({ validateModel: async () => {}, codexFactory: () => ({ startThread: () => ({ id: null, runStreamed: async () => ({ events: (async function* () {})() }) }), resumeThread: () => { throw new Error("not used"); } }) }).spawn(cxSpec({ permissionProfile: "readOnly" }), () => {}, async () => false);
  expect(() => handle.updatePermission!({ version: 1, permissionProfile: "full", permissionRequest: "auto" })).toThrow("explicit risk grant");
  void handle.kill();
});

it("arbitrary permission diagnostics never include provider content", async () => {
  const events: any[] = [];
  const secret = "opaque provider credential=do-not-project-this-value";
  const handle = new CodexAgentBackend({ validateModel: async () => {}, codexFactory: () => ({ startThread: () => ({ id: null, runStreamed: async () => { throw new Error(secret); } }), resumeThread: () => { throw new Error("not used"); } }) }).spawn(cxSpec(), e => events.push(e), async () => false);
  try {
    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe("error"));
    const diagnostics = events.filter(e => e.data.permissionApplication);
    expect(diagnostics.at(-1).data.permissionApplication).toMatchObject({ profileStatus: "failed", error: "Codex permission application could not be confirmed" });
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(events.filter(e => e.kind === "error").at(-1).data.message).toContain(secret);
  } finally { await handle.kill(); }
});
