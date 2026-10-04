import { describe, it, expect } from "vitest";
import { ProjectSpecSchema, AgentSpecSchema, AgentMembershipSchema, TaskRecordSchema } from "@chimera/protocol";

describe("TaskRecord conductor attribution", () => {
  const base = { taskId: "t1", queue: "q", prompt: "work", createdAt: 1 };
  it("defaults legacy persisted tasks to no resolved owner", () => {
    expect(TaskRecordSchema.parse(base).originConductorId).toBeNull();
  });
  it("round-trips a resolved owner", () => {
    const task = TaskRecordSchema.parse({ ...base, originConductorId: "conductor-1" });
    expect(TaskRecordSchema.parse(JSON.parse(JSON.stringify(task))).originConductorId).toBe("conductor-1");
  });
});

describe("ProjectSpecSchema conductor fields (P1-T1)", () => {
  it("defaults autoConductor to true and conductorId to null", () => {
    const p = ProjectSpecSchema.parse({ name: "proj", path: "/tmp/proj", createdAt: 1 });
    expect(p.autoConductor).toBe(true);
    expect(p.conductorId).toBeNull();
  });

  it("round-trips explicit autoConductor/conductorId through parse -> encode -> parse", () => {
    const input = {
      name: "proj", path: "/tmp/proj", createdAt: 1,
      autoConductor: false, conductorId: "agent-123",
    };
    const parsed = ProjectSpecSchema.parse(input);
    expect(parsed.autoConductor).toBe(false);
    expect(parsed.conductorId).toBe("agent-123");

    const reparsed = ProjectSpecSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  it("parses a pre-existing persisted spec (no conductor fields) unaffected — defaults fill in", () => {
    // Simulates a projects.json row written before this change landed.
    const legacy = {
      name: "proj", path: "/tmp/proj", origin: null, teams: ["team-a"],
      queue: "q-a", createdAt: 1700000000000, archived: false,
    };
    const parsed = ProjectSpecSchema.parse(legacy);
    expect(parsed.autoConductor).toBe(true);
    expect(parsed.conductorId).toBeNull();
    expect(parsed.teams).toEqual(["team-a"]);
  });

  it("rejects an unknown key (strict)", () => {
    expect(() => ProjectSpecSchema.parse({
      name: "proj", path: "/tmp/proj", createdAt: 1, bogus: true,
    })).toThrow();
  });
});

describe("AgentMembershipSchema side-channel (P1-T1)", () => {
  it("defaults projectId to null and round-trips team/role", () => {
    const m = AgentMembershipSchema.parse({ team: "crew", role: "dev" });
    expect(m.projectId).toBeNull();
    expect(m.team).toBe("crew");
    expect(m.role).toBe("dev");
  });

  it("round-trips an explicit projectId through encode/decode", () => {
    const input = { team: "crew", role: "dev", projectId: "proj-1" };
    const parsed = AgentMembershipSchema.parse(input);
    const reparsed = AgentMembershipSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
    expect(reparsed.projectId).toBe("proj-1");
  });

  it("rejects an unknown key (strict)", () => {
    expect(() => AgentMembershipSchema.parse({ team: "crew", role: "dev", extra: 1 })).toThrow();
  });
});

describe("AgentSpecSchema stays strict — projectId is NOT a spec field", () => {
  it("rejects a spec carrying projectId directly", () => {
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", projectId: "proj-1" })).toThrow();
  });

  it("a plain valid spec still parses (unaffected by this change)", () => {
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t" })).not.toThrow();
  });
});
