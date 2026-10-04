// BACKEND-CONFORMANCE: a shared vitest suite every AgentBackend implementation should satisfy,
// exercising the AgentBackend/AgentHandle contract generically (spawn -> stream -> interrupt ->
// send -> kill, permission/dialog decider round-trips, capability honesty). Test helper, not
// shipped in src/ — follows this repo's test/helpers.ts / test/coord-helpers.ts / test/fed-helpers.ts
// convention of a plain .ts (not .test.ts) module other test files import from.
//
// Not every backend implements every part of the contract identically (e.g. CodexAgentBackend
// never invokes decidePermission/decideDialog at all — documented in codex.ts as intentional,
// permissionProfile is enforced via the sandbox instead; FakeAgentBackend's interrupt() is a
// deliberate no-op, it exists to test supervisor scheduling, not the interrupt/grace loop). The
// harness's boolean flags encode those real differences — this suite turns each backend's own
// documented divergence into an enforced assertion (either "the round-trip happens" or "the
// decider is never invoked"/"interrupt never throws"), rather than forcing false uniformity.
import { describe, it, expect, vi } from "vitest";
import type { AgentBackend, BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";

export type ConformanceHarness = {
  label: string;
  makeSpec(overrides?: Partial<ResolvedAgentSpec>): ResolvedAgentSpec;

  // A backend scripted to run one turn to a clean, non-interrupted finish (a `result` or `error`
  // terminal event, never both, never neither).
  makeHappyPathBackend(): AgentBackend;

  // Only meaningful when the backend actually aborts an in-flight turn on interrupt() (see
  // supportsInterrupt below). Its first turn must stay open (e.g. a hanging/blocked stream)
  // until interrupt() aborts it, then must be resumable by a follow-up send().
  supportsInterrupt: boolean;
  makeInterruptibleBackend?(): AgentBackend;

  supportsPermissionDecider: boolean;
  // Scripts exactly one tool-call round trip through the injected decidePermission. Called once
  // per sub-test (allow, deny) so each gets its own fresh backend/scenario.
  makePermissionScenario?(): AgentBackend;

  supportsDialogDecider: boolean;
  // Scripts exactly one dialog trigger through the injected decideDialog.
  makeDialogScenario?(): AgentBackend;
};

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const terminalEvents = (events: BackendEvent[]) => events.filter((e) => e.kind === "result" || e.kind === "error");

export function runBackendConformance(harness: ConformanceHarness): void {
  describe(`backend conformance: ${harness.label}`, () => {
    it("declares all four documented BackendCapabilities keys as booleans", () => {
      const backend = harness.makeHappyPathBackend();
      expect(Object.keys(backend.capabilities).sort()).toEqual(
        ["supportsMcpServers", "supportsResume", "supportsSettingSources", "supportsVoiceRealtime"].sort(),
      );
      for (const v of Object.values(backend.capabilities)) expect(typeof v).toBe("boolean");
    });

    it("spawn() returns a handle synchronously; the happy path ends in exactly one terminal event", async () => {
      const backend = harness.makeHappyPathBackend();
      const events: BackendEvent[] = [];
      const handle = backend.spawn(harness.makeSpec(), (e) => events.push(e), async () => true);
      expect(handle).toBeTruthy();
      expect(typeof handle.send).toBe("function");
      expect(typeof handle.interrupt).toBe("function");
      expect(typeof handle.kill).toBe("function");
      await settle(80);
      expect(terminalEvents(events).length).toBe(1);
    });

    it("kill() is terminal (no further events emitted) and idempotent", async () => {
      const backend = harness.makeHappyPathBackend();
      const events: BackendEvent[] = [];
      const handle = backend.spawn(harness.makeSpec(), (e) => events.push(e), async () => true);
      await handle.kill();
      const countRightAfterKill = events.length;
      await settle(80);
      expect(events.length).toBe(countRightAfterKill);      // nothing further landed after kill()
      await expect(handle.kill()).resolves.not.toThrow();   // idempotent
    });

    if (harness.supportsInterrupt) {
      it("interrupt() aborts the in-flight turn: emits turn_complete{interrupted:true}, not an error", async () => {
        const backend = harness.makeInterruptibleBackend!();
        const events: BackendEvent[] = [];
        const handle = backend.spawn(harness.makeSpec(), (e) => events.push(e), async () => true);
        await settle(30);
        await handle.interrupt();
        await settle(80);
        expect(events).toContainEqual({ kind: "turn_complete", data: { interrupted: true } });
        expect(events.some((e) => e.kind === "error")).toBe(false);
      });

      it("send() right after interrupt() starts a new turn within the grace window", async () => {
        const backend = harness.makeInterruptibleBackend!();
        const events: BackendEvent[] = [];
        const handle = backend.spawn(harness.makeSpec(), (e) => events.push(e), async () => true);
        await settle(30);
        await handle.interrupt();
        // Let the abort actually propagate through the backend's catch block and arm its grace
        // window (consumeInterrupt() + the pending waitForNext()'s `wake` resolver) BEFORE
        // send() — otherwise push()'s wake?.() races the backend into missing it and the
        // follow-up only lands once the (long) grace TIMEOUT elapses, not via the early wake.
        await settle(30);
        await handle.send("conformance follow-up");
        await settle(120);
        expect(terminalEvents(events).length).toBe(1);   // the follow-up turn ran to completion, not lost
      });
    } else {
      it("interrupt() is a documented no-op for this backend — never throws, never crashes the handle", async () => {
        const backend = harness.makeHappyPathBackend();
        const events: BackendEvent[] = [];
        const handle = backend.spawn(harness.makeSpec(), (e) => events.push(e), async () => true);
        await expect(handle.interrupt()).resolves.not.toThrow();
        await settle(80);
        expect(events.some((e) => e.kind === "error")).toBe(false);
      });
    }

    if (harness.supportsPermissionDecider) {
      it("awaits the injected decidePermission and reflects an allow decision", async () => {
        const backend = harness.makePermissionScenario!();
        const events: BackendEvent[] = [];
        const decidePermission = vi.fn(async () => true);
        backend.spawn(harness.makeSpec(), (e) => events.push(e), decidePermission);
        await settle(80);
        expect(decidePermission).toHaveBeenCalled();
        expect(events.some((e) => e.kind === "tool_call")).toBe(true);
      });

      it("awaits the injected decidePermission and reflects a deny decision", async () => {
        const backend = harness.makePermissionScenario!();
        const events: BackendEvent[] = [];
        const decidePermission = vi.fn(async () => false);
        backend.spawn(harness.makeSpec(), (e) => events.push(e), decidePermission);
        await settle(80);
        expect(decidePermission).toHaveBeenCalled();
        expect(events.some((e) => e.data && (e.data as Record<string, unknown>)["denied"] === true)).toBe(true);
      });
    } else {
      it("never invokes decidePermission (documented no-op contract for this backend)", async () => {
        const backend = harness.makeHappyPathBackend();
        const decidePermission = vi.fn(async () => true);
        backend.spawn(harness.makeSpec(), () => {}, decidePermission);
        await settle(80);
        expect(decidePermission).not.toHaveBeenCalled();
      });
    }

    if (harness.supportsDialogDecider) {
      it("invokes the injected decideDialog for a scripted dialog trigger", async () => {
        const backend = harness.makeDialogScenario!();
        const decideDialog = vi.fn(async () => ({ behavior: "cancelled" as const }));
        backend.spawn(harness.makeSpec(), () => {}, async () => true, decideDialog);
        await settle(80);
        expect(decideDialog).toHaveBeenCalled();
      });
    } else {
      it("never invokes decideDialog (documented no-op contract for this backend)", async () => {
        const backend = harness.makeHappyPathBackend();
        const decideDialog = vi.fn(async () => ({ behavior: "cancelled" as const }));
        backend.spawn(harness.makeSpec(), () => {}, async () => true, decideDialog);
        await settle(80);
        expect(decideDialog).not.toHaveBeenCalled();
      });
    }
  });
}
