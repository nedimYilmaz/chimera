import { describe, expect, it } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor } from "./helpers.js";

describe("cloud mutation gate", () => {
  it("forces the ask flow for a mutating command on a full+auto agent", async () => {
    const scenario: FakeStep[] = [
      { askPermission: { toolName: "Bash", input: { command: "kubectl delete pod mypod" } } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);

    events.subscribe((e) => {
      if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), true);
    });

    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      permissionProfile: "full", on: { permissionRequest: "auto" },
    });
    await sup.waitFor(rec.agentId, 1000);

    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "permission_request")).toHaveLength(1);
  });

  it("does not ask for a read command on the same agent", async () => {
    const scenario: FakeStep[] = [
      { askPermission: { toolName: "Bash", input: { command: "kubectl get pods -n prod" } } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);

    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      permissionProfile: "full", on: { permissionRequest: "auto" },
    });
    await sup.waitFor(rec.agentId, 1000);

    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "permission_request")).toHaveLength(0);
    // the read still ran: a full+auto agent's allowed Bash surfaces as a tool_call
    expect(tail.some((e) => e.kind === "tool_call")).toBe(true);
  });

  // PERM-READONLY-FALSE-PROMPTS: the screenshot regression case — `aws athena
  // batch-get-query-execution` used to misclassify as a mutation (cloudVerb's
  // `positional[1].split("-")[0]` read "batch", not a read verb, off a compound aws
  // operation name), forcing a permission card even for a full+auto agent. Proves the
  // cloudVerb fix end-to-end through the actual supervisor gate, not just the unit classifier.
  it("does not ask for the screenshot's aws athena batch-get-query-execution command on a full+auto agent", async () => {
    const scenario: FakeStep[] = [
      { askPermission: { toolName: "Bash", input: { command: "aws athena batch-get-query-execution --query-execution-ids abc123 --profile prod --region eu-west-1" } } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);

    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      permissionProfile: "full", on: { permissionRequest: "auto" },
    });
    await sup.waitFor(rec.agentId, 1000);

    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "permission_request")).toHaveLength(0);
    expect(tail.some((e) => e.kind === "tool_call")).toBe(true);
  });

  it("records the mutation attempt in the audit ledger", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const scenario: FakeStep[] = [
      { askPermission: { toolName: "Bash", input: { command: "aws ec2 terminate-instances --instance-ids i-1" } } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario], undefined, {
      auditLedger: { append: (e) => { entries.push(e as Record<string, unknown>); } },
    });

    events.subscribe((e) => {
      if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), true);
    });

    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      permissionProfile: "full", on: { permissionRequest: "auto" },
    });
    await sup.waitFor(rec.agentId, 1000);

    expect(entries).toContainEqual(
      expect.objectContaining({ action: "cloud_mutation_gated", decision: "prompt" }),
    );
  });

  it("CLOUD-MUTATION-GATE-OPTOUT: config cloudMutationGate 'off' auto-allows and emits no permission request", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const scenario: FakeStep[] = [
      { askPermission: { toolName: "Bash", input: { command: "kubectl delete pod mypod" } } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario], undefined, {
      auditLedger: { append: (e) => { entries.push(e as Record<string, unknown>); } },
      cloudMutationGate: () => "off",
    });

    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      permissionProfile: "full", on: { permissionRequest: "auto" },
    });
    await sup.waitFor(rec.agentId, 1000);

    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "permission_request")).toHaveLength(0);
    expect(entries).toContainEqual(
      expect.objectContaining({ action: "cloud_mutation_gated", decision: "allow" }),
    );
    // GATED-BUT-ALLOWED-INVISIBLE: the auditLedger entry above is durable but invisible in the
    // agent's own transcript — the bypass must ALSO leave a capability_decision EventLog event
    // an operator scrolling the transcript can actually see, tagged explicitPolicy so the UI
    // colors it distinctly from ordinary noise.
    const capabilityEvent = tail.find((e) => e.kind === "capability_decision");
    expect(capabilityEvent?.data).toMatchObject({
      action: "cloud_mutation_gated", decision: "allow", explicitPolicy: true, tool: "kubectl",
    });
  });

  it("CLOUD-MUTATION-GATE-OPTOUT: per-spec acknowledgeCloudMutationRisk:true beats config 'prompt' default", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const scenario: FakeStep[] = [
      { askPermission: { toolName: "Bash", input: { command: "kubectl delete pod mypod" } } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario], undefined, {
      auditLedger: { append: (e) => { entries.push(e as Record<string, unknown>); } },
      cloudMutationGate: () => "prompt",
    });

    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      permissionProfile: "full", on: { permissionRequest: "auto" },
      acknowledgeCloudMutationRisk: true,
    });
    await sup.waitFor(rec.agentId, 1000);

    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "permission_request")).toHaveLength(0);
    expect(entries).toContainEqual(
      expect.objectContaining({ action: "cloud_mutation_gated", decision: "allow" }),
    );
  });

  it("CLOUD-MUTATION-GATE-OPTOUT: per-spec acknowledgeCloudMutationRisk:false beats config 'off' default", async () => {
    const scenario: FakeStep[] = [
      { askPermission: { toolName: "Bash", input: { command: "kubectl delete pod mypod" } } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario], undefined, {
      cloudMutationGate: () => "off",
    });

    events.subscribe((e) => {
      if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), true);
    });

    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      permissionProfile: "full", on: { permissionRequest: "auto" },
      acknowledgeCloudMutationRisk: false,
    });
    await sup.waitFor(rec.agentId, 1000);

    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "permission_request")).toHaveLength(1);
  });

  it("READONLY-BASH-NO-PROMPT: still forces the ask flow for a mutating command on an acceptEdits agent", async () => {
    // acceptEdits is where hosttools.ts's isReadOnlyBash now actively relaxes Bash — this
    // proves the relaxation cannot be used to slip a MUTATING cloud call past the
    // CLOUD-MUTATION-GATE, which is computed independently of it and wins by construction
    // (askStamp short-circuits decidePermission's "auto" fast path before autoDecision is
    // ever consulted).
    const scenario: FakeStep[] = [
      { askPermission: { toolName: "Bash", input: { command: "kubectl delete pod mypod" } } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    events.subscribe((e) => {
      if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), true);
    });
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      permissionProfile: "acceptEdits", on: { permissionRequest: "auto" },
    });
    await sup.waitFor(rec.agentId, 1000);
    expect(events.tail(rec.agentId, 50).filter((e) => e.kind === "permission_request")).toHaveLength(1);
  });

  it("CLOUD-MUTATION-GATE-OPTOUT: a read command never gates regardless of the setting", async () => {
    const scenario: FakeStep[] = [
      { askPermission: { toolName: "Bash", input: { command: "kubectl get pods -n prod" } } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario], undefined, {
      cloudMutationGate: () => "off",
    });

    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      permissionProfile: "full", on: { permissionRequest: "auto" },
    });
    await sup.waitFor(rec.agentId, 1000);

    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "permission_request")).toHaveLength(0);
  });
});
