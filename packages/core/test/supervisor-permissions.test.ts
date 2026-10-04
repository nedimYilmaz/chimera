import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { EventLog } from "@chimera/core/events";
import { makeSupervisor } from "./helpers.js";

const ASK_BASH: FakeStep[] = [{ askPermission: { toolName: "Bash" } }, { end: { resultText: "done" } }];
const SPAWN = { prompt: "x", cwd: "/tmp", account: "main", isolation: "none", on: { permissionRequest: "poke:caller" } };

describe("AgentSupervisor permissions", () => {
  it("poke:caller emits permission_request and honors respondPermission(true)", async () => {
    const { sup, events } = makeSupervisor([ASK_BASH]);   // the SAME EventLog instance the supervisor writes to
    events.subscribe((e) => {
      if (e.kind === "permission_request") {
        expect(sup.respondPermission(String(e.data["requestId"]), true)).toBe(true);
      }
    });
    const rec = await sup.spawn(SPAWN);
    await sup.waitFor(rec.agentId, 1000);
    const kinds = events.tail(rec.agentId, 50).map((e) => e.kind);
    expect(kinds).toContain("permission_request");
    expect(kinds).toContain("tool_call");            // allowed → Bash ran
  });

  it("falls back to the profile decision on timeout (acceptEdits denies Bash)", async () => {
    const { sup, dir } = makeSupervisor([ASK_BASH]);  // permissionTimeoutMs: 100 in makeSupervisor
    const rec = await sup.spawn(SPAWN);                // nobody responds
    await sup.waitFor(rec.agentId, 2000);
    const evs = new EventLog(dir).tail(rec.agentId, 50);
    const denied = evs.find((e) => e.kind === "status" && e.data["denied"] === true);
    expect(denied?.data["toolName"]).toBe("Bash");
  });

  it("auto policy never emits permission_request", async () => {
    const { sup, dir } = makeSupervisor([ASK_BASH]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    expect(new EventLog(dir).tail(rec.agentId, 50).every((e) => e.kind !== "permission_request")).toBe(true);
  });

  it("respondPermission returns false for unknown request ids", () => {
    const { sup } = makeSupervisor([]);
    expect(sup.respondPermission("nope", true)).toBe(false);
  });

  it("isolates concurrent approvals when backends reuse the same request id", async () => {
    const { sup, events } = makeSupervisor([[{ awaitSend: true }], [{ awaitSend: true }]]);
    const internal = sup as unknown as {
      decidePermission(record: unknown, request: { requestId: string; toolName: string; input: unknown }): Promise<boolean | string>;
    };
    const requests: Array<{ agentId: string; requestId: string; backendRequestId: string }> = [];
    events.subscribe((event) => {
      if (event.kind !== "permission_request") return;
      requests.push({
        agentId: event.agentId,
        requestId: String(event.data["requestId"]),
        backendRequestId: String(event.data["backendRequestId"]),
      });
      if (requests.length === 2) {
        expect(requests[0]!.requestId).not.toBe(requests[1]!.requestId);
        expect(requests[0]!.backendRequestId).toBe(requests[1]!.backendRequestId);
        expect(sup.respondPermission(requests[0]!.requestId, false)).toBe(true);
        expect(sup.respondPermission(requests[1]!.requestId, true)).toBe(true);
      }
    });
    const [first, second] = await Promise.all([
      sup.spawn({ ...SPAWN, account: "main" }),
      sup.spawn({ ...SPAWN, account: "second" }),
    ]);
    const [firstDecision, secondDecision] = await Promise.all([
      internal.decidePermission(first, { requestId: "reused-backend-id", toolName: "Bash", input: {} }),
      internal.decidePermission(second, { requestId: "reused-backend-id", toolName: "Bash", input: {} }),
    ]);
    expect(firstDecision).toBe(false);
    expect(secondDecision).toBe(true);
    await Promise.all([sup.kill(first.agentId), sup.kill(second.agentId)]);
  });

  it("does not let a stale approval answer resolve a later request with the same backend id", async () => {
    const { sup, events } = makeSupervisor([ASK_BASH, ASK_BASH]);
    const ids: string[] = [];
    events.subscribe((event) => {
      if (event.kind !== "permission_request") return;
      ids.push(String(event.data["requestId"]));
      if (ids.length === 1) expect(sup.respondPermission(ids[0]!, false)).toBe(true);
      if (ids.length === 2) {
        expect(sup.respondPermission(ids[0]!, false)).toBe(false);
        expect(sup.respondPermission(ids[1]!, true)).toBe(true);
      }
    });
    const first = await sup.spawn(SPAWN);
    await sup.waitFor(first.agentId, 1000);
    const second = await sup.spawn(SPAWN);
    await sup.waitFor(second.agentId, 1000);
    expect(ids[0]).not.toBe(ids[1]);
    expect(events.tail(second.agentId, 50).some((event) => event.kind === "tool_call")).toBe(true);
  });

  it("poke:caller deny via respondPermission(false) emits status{denied}", async () => {
    expect.assertions(3);
    const { sup, events } = makeSupervisor([ASK_BASH]);
    events.subscribe((e) => {
      if (e.kind === "permission_request") {
        expect(sup.respondPermission(String(e.data["requestId"]), false)).toBe(true);
      }
    });
    const rec = await sup.spawn(SPAWN);
    await sup.waitFor(rec.agentId, 1000);
    expect(sup.status(rec.agentId).permissionDenied).toBe(true);
    const evs = events.tail(rec.agentId, 50);
    const denied = evs.find((e) => e.kind === "status" && e.data["denied"] === true);
    expect(denied?.data["toolName"]).toBe("Bash");
  });

  it("tui policy uses the same mechanics as poke:caller (allow via respondPermission)", async () => {
    const { sup, events } = makeSupervisor([ASK_BASH]);
    events.subscribe((e) => {
      if (e.kind === "permission_request") {
        expect(sup.respondPermission(String(e.data["requestId"]), true)).toBe(true);
      }
    });
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none", on: { permissionRequest: "tui" } });
    await sup.waitFor(rec.agentId, 1000);
    const kinds = events.tail(rec.agentId, 50).map((e) => e.kind);
    expect(kinds).toContain("permission_request");
    expect(kinds).toContain("tool_call");
  });

  it("permission_request event data carries requestId, toolName, input, and policy", async () => {
    expect.assertions(4);
    const { sup, events } = makeSupervisor([ASK_BASH]);
    events.subscribe((e) => {
      if (e.kind === "permission_request") {
        expect(typeof e.data["requestId"]).toBe("string");
        expect(e.data["toolName"]).toBe("Bash");
        expect(e.data["input"]).toEqual({});
        expect(e.data["policy"]).toBe("poke:caller");
        sup.respondPermission(String(e.data["requestId"]), true);
      }
    });
    const rec = await sup.spawn(SPAWN);
    await sup.waitFor(rec.agentId, 1000);
  });

  it("timeout fallback still allows Bash when the profile is 'full'", async () => {
    const { sup, dir } = makeSupervisor([ASK_BASH]);
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      permissionProfile: "full", on: { permissionRequest: "poke:caller" },
    });                                                  // nobody responds → fallback → autoDecision("full", "Bash") === true
    await sup.waitFor(rec.agentId, 2000);
    const evs = new EventLog(dir).tail(rec.agentId, 50);
    expect(evs.some((e) => e.kind === "tool_call")).toBe(true);
    expect(evs.some((e) => e.kind === "status" && e.data["denied"] === true)).toBe(false);
  });

  it("scrubs an injected credential value out of the permission_request event data (spec §6)", async () => {
    expect.assertions(2);
    // spawning on "second" resolves keychain secret "tok-second" into the supervisor's
    // secrets list; a tool input echoing it must be redacted before the event is appended
    const scenario: FakeStep[] = [
      { askPermission: { toolName: "Bash", input: "run with token=tok-second" } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    events.subscribe((e) => {
      if (e.kind === "permission_request") {
        const input = String(e.data["input"]);
        expect(input).not.toContain("tok-second");     // secret redacted before persistence
        expect(input).toContain("[REDACTED]");
        sup.respondPermission(String(e.data["requestId"]), true);
      }
    });
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", isolation: "none", on: { permissionRequest: "poke:caller" } });
    await sup.waitFor(rec.agentId, 1000);
  });

  // PERM-READONLY-FALSE-PROMPTS: the requested behaviour change — a provably read-only Bash
  // command must auto-allow under "readOnly" too, not just "acceptEdits"/"full". The
  // isReadOnlyBash relaxation lives inside autoDecision, which is only consulted by the
  // "auto" policy's immediate fast path (or any policy's timeout fallback) — "poke:caller"/
  // "tui" always raise a card regardless of profile (a separate routing axis), so this uses
  // "auto" (the default) to actually exercise the relaxation.
  it("readOnly auto-allows a provably read-only Bash command with no permission card", async () => {
    const scenario: FakeStep[] = [
      { askPermission: { toolName: "Bash", input: { command: "grep -rn foo src/" } } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      permissionProfile: "readOnly",
    });
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "permission_request")).toHaveLength(0);
    expect(tail.some((e) => e.kind === "tool_call")).toBe(true);
  });

  // readOnly must still deny a non-provably-read-only Bash command — the relaxation is
  // scoped to isReadOnlyBash's fail-closed allowlist, not a blanket Bash allow.
  it("readOnly still denies a Bash command that isn't provably read-only", async () => {
    const scenario: FakeStep[] = [
      { askPermission: { toolName: "Bash", input: { command: "rm -rf build" } } },
      { end: { resultText: "done" } },
    ];
    const { sup, dir } = makeSupervisor([scenario]);
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      permissionProfile: "readOnly",
    });
    await sup.waitFor(rec.agentId, 1000);
    const evs = new EventLog(dir).tail(rec.agentId, 50);
    expect(evs.some((e) => e.kind === "status" && e.data["denied"] === true)).toBe(true);
  });
});
