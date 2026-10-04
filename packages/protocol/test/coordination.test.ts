import { describe, it, expect } from "vitest";
import {
  AgentSpecSchema, TeamSpecSchema, QueueSpecSchema, TaskRecordSchema,
  RoleSpecSchema, RoleBindingSchema, TaskStateSchema, AssignParams,
} from "@chimera/protocol";

describe("AgentSpec budget extension", () => {
  it("defaults maxBudgetUsd to null and accepts a positive number", () => {
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t" }).maxBudgetUsd).toBeNull();
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t", maxBudgetUsd: 2.5 }).maxBudgetUsd).toBe(2.5);
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", maxBudgetUsd: -1 })).toThrow();
  });
});

describe("TeamSpecSchema", () => {
  it("parses a team and applies defaults down to each role binding", () => {
    const t = TeamSpecSchema.parse({ name: "crew", roles: { dev: { role: "dev" } } });
    expect(t.maxConcurrent).toBe(4);
    expect(t.queue).toBeNull();
    expect(t.roles["dev"]).toEqual({ role: "dev", overrides: {} });   // ROLES-UNIFY: a reference, not a materialized copy
  });
  it("rejects role bindings that contain an unknown key, empty role sets, and bad team names", () => {
    expect(() => TeamSpecSchema.parse({ name: "crew", roles: { dev: { role: "dev", prompt: "no" } } })).toThrow();
    expect(() => TeamSpecSchema.parse({ name: "crew", roles: {} })).toThrow();
    expect(() => TeamSpecSchema.parse({ name: "bad name!", roles: { dev: { role: "dev" } } })).toThrow();
  });
});

describe("QueueSpecSchema / TaskRecordSchema", () => {
  it("applies queue defaults and bounds", () => {
    expect(QueueSpecSchema.parse({ name: "work" }).retryLimit).toBe(2);
    expect(() => QueueSpecSchema.parse({ name: "work", retryLimit: -1 })).toThrow();
  });
  it("parses a minimal task with defaults", () => {
    const t = TaskRecordSchema.parse({ taskId: "t1", queue: "work", prompt: "do", createdAt: 123 });
    expect(t).toMatchObject({ state: "pending", priority: 0, attempts: 0, role: null, agentId: null, resultText: null, error: null });
    expect(t.overrides).toEqual({});
  });
  it("rejects unknown task states", () => {
    expect(() => TaskRecordSchema.parse({ taskId: "t1", queue: "w", prompt: "p", createdAt: 1, state: "paused" })).toThrow();
  });
});

// ---------- additional coverage: edges/branches beyond the brief's examples ----------

describe("AgentSpec.maxBudgetUsd boundaries (beyond brief examples)", () => {
  it("rejects zero (positive() excludes the boundary)", () => {
    expect.assertions(1);
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", maxBudgetUsd: 0 })).toThrow();
  });
  it("accepts an explicit null (nullable, not just defaulted)", () => {
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t", maxBudgetUsd: null }).maxBudgetUsd).toBeNull();
  });
});

describe("RoleSpecSchema (standalone, not just via TeamSpec) — ROLES-UNIFY §2", () => {
  it("parses a bare spec without prompt/cwd, applying AgentSpec defaults", () => {
    const t = RoleSpecSchema.parse({ name: "dev" });
    expect(t.account).toBe("auto");
    expect(t.isolation).toBe("worktree");
    expect((t as Record<string, unknown>)["prompt"]).toBeUndefined();
  });
  it("rejects a spec carrying prompt directly (strict + omitted key)", () => {
    expect.assertions(1);
    expect(() => RoleSpecSchema.parse({ name: "dev", cwd: "/tmp", prompt: "no" })).toThrow();
  });
  it("rejects a spec missing the required name", () => {
    expect.assertions(1);
    expect(() => RoleSpecSchema.parse({ cwd: "/tmp" })).toThrow();
  });
  // WIDENED (ROLES-UNIFY §2): cwd required -> optional — a library role must also serve a pure
  // ad-hoc session binding, which has no per-role cwd.
  it("accepts a spec with no cwd at all", () => {
    expect(() => RoleSpecSchema.parse({ name: "dev" })).not.toThrow();
    expect(RoleSpecSchema.parse({ name: "dev" }).cwd).toBeUndefined();
  });
  it("rejects a spec with an unknown key (strict)", () => {
    expect.assertions(1);
    expect(() => RoleSpecSchema.parse({ name: "dev", cwd: "/tmp", bogus: 1 })).toThrow();
  });
  it("defaults turnLimitPolicy to fail, and a role can opt into soft", () => {
    expect(RoleSpecSchema.parse({ name: "dev", cwd: "/tmp" }).turnLimitPolicy).toBe("fail");
    expect(RoleSpecSchema.parse({ name: "dev", cwd: "/tmp", turnLimitPolicy: "soft" }).turnLimitPolicy).toBe("soft");
  });
  // R2 EFFORT: effort isn't in RoleSpecSchema's .omit() set, so it inherits from
  // AgentSpecSchema automatically, exactly like model already does.
  it("inherits effort from AgentSpecSchema, same as model", () => {
    expect(RoleSpecSchema.parse({ name: "dev", cwd: "/tmp" }).effort).toBeUndefined();
    expect(RoleSpecSchema.parse({ name: "dev", cwd: "/tmp", effort: "high" }).effort).toBe("high");
    expect(() => RoleSpecSchema.parse({ name: "dev", cwd: "/tmp", effort: "ultra" })).toThrow();
  });
});

describe("RoleSpecSchema.persistent / poolSize (Task A1, unchanged by ROLES-UNIFY)", () => {
  it("role spec accepts persistent + poolSize with safe defaults", () => {
    const spec = RoleSpecSchema.parse({ name: "dev", cwd: "/x", persistent: true, poolSize: 2 });
    expect(spec.persistent).toBe(true);
    expect(spec.poolSize).toBe(2);
  });
  it("persistent defaults to false when omitted", () => {
    expect(RoleSpecSchema.parse({ name: "dev", cwd: "/x" }).persistent).toBe(false);
  });
  it("poolSize rejects zero and non-integers", () => {
    expect(() => RoleSpecSchema.parse({ name: "dev", cwd: "/x", poolSize: 0 })).toThrow();
    expect(() => RoleSpecSchema.parse({ name: "dev", cwd: "/x", poolSize: 1.5 })).toThrow();
  });
  it("poolSize rejects negative integers", () => {
    expect.assertions(1);
    expect(() => RoleSpecSchema.parse({ name: "dev", cwd: "/x", poolSize: -1 })).toThrow();
  });
  it("poolSize accepts the exact boundary value 1", () => {
    expect(RoleSpecSchema.parse({ name: "dev", cwd: "/x", poolSize: 1 }).poolSize).toBe(1);
  });
  it("poolSize is undefined when omitted (optional, no default)", () => {
    expect(RoleSpecSchema.parse({ name: "dev", cwd: "/x" }).poolSize).toBeUndefined();
  });
  it("persistent can be explicitly set to false", () => {
    expect(RoleSpecSchema.parse({ name: "dev", cwd: "/x", persistent: false }).persistent).toBe(false);
  });
  it("rejects a non-boolean persistent value", () => {
    expect.assertions(1);
    expect(() => RoleSpecSchema.parse({ name: "dev", cwd: "/x", persistent: "yes" })).toThrow();
  });
});

describe("RoleBindingSchema.overrides carries arbitrary sparse keys (ROLES-UNIFY §3.1/§4)", () => {
  it("a team-role binding is a reference + sparse overrides, not a materialized role", () => {
    const spec = TeamSpecSchema.parse({
      name: "crew", roles: { dev: { role: "dev", overrides: { persistent: true, poolSize: 2 } } }, maxConcurrent: 3,
    });
    expect(spec.roles.dev).toEqual({ role: "dev", overrides: { persistent: true, poolSize: 2 } });
  });
  it("overrides defaults to {} when omitted", () => {
    const spec = TeamSpecSchema.parse({ name: "crew", roles: { dev: { role: "dev" } } });
    expect(spec.roles.dev.overrides).toEqual({});
  });
  // overrides is a loose bag at the protocol layer — key/value validity (e.g. poolSize >= 1) is
  // enforced later when the resolved spec hits RoleSpecSchema/AgentSpecSchema at resolve/spawn
  // time (core, S2+), mirroring TaskRecordSchema.overrides' own documented contract.
  it("overrides accepts a stray/wrong-typed key unvalidated at this layer", () => {
    const spec = TeamSpecSchema.parse({ name: "crew", roles: { dev: { role: "dev", overrides: { poolSize: -1, stray: "x" } } } });
    expect(spec.roles.dev.overrides).toEqual({ poolSize: -1, stray: "x" });
  });
  it("works standalone via RoleBindingSchema directly, not just through TeamSpec", () => {
    const b = RoleBindingSchema.parse({ role: "dev" });
    expect(b.role).toBe("dev");
    expect(b.overrides).toEqual({});
  });
  it("rejects a binding with an unknown key (strict)", () => {
    expect.assertions(1);
    expect(() => RoleBindingSchema.parse({ role: "dev", cwd: "/tmp" })).toThrow();
  });
});

describe("CoordName regex — '/' is reserved for the §15 federation qualifier", () => {
  it("rejects a TeamSpec name containing '/'", () => {
    expect.assertions(1);
    expect(() => TeamSpecSchema.parse({ name: "team/a", roles: { dev: { role: "dev" } } })).toThrow();
  });
  it("rejects a QueueSpec name containing '/'", () => {
    expect.assertions(1);
    expect(() => QueueSpecSchema.parse({ name: "eng1/work" })).toThrow();
  });
  it("rejects an empty-string name", () => {
    expect.assertions(1);
    expect(() => TeamSpecSchema.parse({ name: "", roles: { dev: { role: "dev" } } })).toThrow();
  });
  it("accepts a name using only letters, digits, underscore and dash", () => {
    const t = TeamSpecSchema.parse({ name: "Team_9-crew", roles: { dev: { role: "dev" } } });
    expect(t.name).toBe("Team_9-crew");
  });
});

describe("TeamSpecSchema — additional branches", () => {
  it("rejects an unknown top-level key (strict)", () => {
    expect.assertions(1);
    expect(() => TeamSpecSchema.parse({ name: "crew", roles: { dev: { role: "dev" } }, bogus: 1 })).toThrow();
  });
  it("accepts an explicit maxConcurrent and queue, overriding defaults", () => {
    const t = TeamSpecSchema.parse({ name: "crew", roles: { dev: { role: "dev" } }, maxConcurrent: 8, queue: "q1" });
    expect(t.maxConcurrent).toBe(8);
    expect(t.queue).toBe("q1");
  });
  it("rejects maxConcurrent of zero (positive() excludes the boundary)", () => {
    expect.assertions(1);
    expect(() => TeamSpecSchema.parse({ name: "crew", roles: { dev: { role: "dev" } }, maxConcurrent: 0 })).toThrow();
  });
  it("rejects a negative maxConcurrent", () => {
    expect.assertions(1);
    expect(() => TeamSpecSchema.parse({ name: "crew", roles: { dev: { role: "dev" } }, maxConcurrent: -1 })).toThrow();
  });
  it("parses multiple role bindings, each independently addressable by key", () => {
    const t = TeamSpecSchema.parse({ name: "crew", roles: { dev: { role: "dev" }, qa: { role: "qa", overrides: { permissionProfile: "readOnly" } } } });
    expect(t.roles["dev"]).toEqual({ role: "dev", overrides: {} });
    expect(t.roles["qa"]).toEqual({ role: "qa", overrides: { permissionProfile: "readOnly" } });
  });
});

describe("TeamSpecSchema.createdBy (T9d — team owner stamp)", () => {
  it("defaults to null when omitted", () => {
    const t = TeamSpecSchema.parse({ name: "crew", roles: { dev: { role: "dev" } } });
    expect(t.createdBy).toBeNull();
  });
  it("parses an explicit createdBy string", () => {
    const t = TeamSpecSchema.parse({ name: "crew", roles: { dev: { role: "dev" } }, createdBy: "agentX" });
    expect(t.createdBy).toBe("agentX");
  });
  it("accepts an explicit null createdBy", () => {
    const t = TeamSpecSchema.parse({ name: "crew", roles: { dev: { role: "dev" } }, createdBy: null });
    expect(t.createdBy).toBeNull();
  });
  it("rejects a non-string, non-null createdBy", () => {
    expect.assertions(1);
    expect(() => TeamSpecSchema.parse({ name: "crew", roles: { dev: { role: "dev" } }, createdBy: 42 })).toThrow();
  });
});

describe("QueueSpecSchema — additional branches", () => {
  it("accepts retryLimit of exactly zero (min(0) boundary, inclusive)", () => {
    expect(QueueSpecSchema.parse({ name: "work", retryLimit: 0 }).retryLimit).toBe(0);
  });
  it("rejects a non-integer retryLimit", () => {
    expect.assertions(1);
    expect(() => QueueSpecSchema.parse({ name: "work", retryLimit: 1.5 })).toThrow();
  });
  it("rejects an unknown top-level key (strict)", () => {
    expect.assertions(1);
    expect(() => QueueSpecSchema.parse({ name: "work", bogus: true })).toThrow();
  });
});

describe("TaskStateSchema — all valid states and rejection", () => {
  it.each(["pending", "in_progress", "done", "failed"] as const)("accepts '%s'", (s) => {
    expect(TaskStateSchema.parse(s)).toBe(s);
  });
  it("rejects a state not in the enum", () => {
    expect.assertions(1);
    expect(() => TaskStateSchema.parse("cancelled")).toThrow();
  });
});

describe("TaskRecordSchema — additional branches", () => {
  it("rejects an unknown top-level key (strict)", () => {
    expect.assertions(1);
    expect(() => TaskRecordSchema.parse({ taskId: "t1", queue: "w", prompt: "p", createdAt: 1, bogus: 1 })).toThrow();
  });
  it("rejects an empty taskId", () => {
    expect.assertions(1);
    expect(() => TaskRecordSchema.parse({ taskId: "", queue: "w", prompt: "p", createdAt: 1 })).toThrow();
  });
  it("rejects an empty queue", () => {
    expect.assertions(1);
    expect(() => TaskRecordSchema.parse({ taskId: "t1", queue: "", prompt: "p", createdAt: 1 })).toThrow();
  });
  it("rejects an empty prompt", () => {
    expect.assertions(1);
    expect(() => TaskRecordSchema.parse({ taskId: "t1", queue: "w", prompt: "", createdAt: 1 })).toThrow();
  });
  it("rejects a missing createdAt", () => {
    expect.assertions(1);
    expect(() => TaskRecordSchema.parse({ taskId: "t1", queue: "w", prompt: "p" })).toThrow();
  });
  it("rejects a negative attempts (min(0) boundary)", () => {
    expect.assertions(1);
    expect(() => TaskRecordSchema.parse({ taskId: "t1", queue: "w", prompt: "p", createdAt: 1, attempts: -1 })).toThrow();
  });
  it("accepts a negative priority (no lower bound — higher drains first, negatives are valid low priority)", () => {
    const t = TaskRecordSchema.parse({ taskId: "t1", queue: "w", prompt: "p", createdAt: 1, priority: -5 });
    expect(t.priority).toBe(-5);
  });
  it("rejects a non-integer priority", () => {
    expect.assertions(1);
    expect(() => TaskRecordSchema.parse({ taskId: "t1", queue: "w", prompt: "p", createdAt: 1, priority: 1.5 })).toThrow();
  });
  it("overrides is SPARSE: only the caller's explicit keys survive, no AgentSpec defaults are filled", () => {
    const t = TaskRecordSchema.parse({ taskId: "t1", queue: "w", prompt: "p", createdAt: 1, overrides: { model: "opus" } });
    // NOT filled with account:"auto"/permissionProfile:"acceptEdits" etc. — the scheduler's
    // {...roleTemplate, ...overrides} merge must not clobber role-template values with defaults.
    expect(t.overrides).toEqual({ model: "opus" });
  });
  it("omitting the whole overrides key yields exactly {}", () => {
    const t = TaskRecordSchema.parse({ taskId: "t1", queue: "w", prompt: "p", createdAt: 1 });
    expect(t.overrides).toEqual({});
    expect(Object.keys(t.overrides).length).toBe(0);
  });
  it("overrides is a loose bag at the protocol layer — key/value validity is enforced at spawn (strict AgentSpecSchema), not here", () => {
    // A stray or wrong-typed override key is accepted by TaskRecord (sparse bag) and only
    // rejected later when the merged spec hits AgentSpecSchema.parse in supervisor.spawn.
    const t = TaskRecordSchema.parse({ taskId: "t1", queue: "w", prompt: "p", createdAt: 1, overrides: { account: "second", stray: 1 } });
    expect(t.overrides).toEqual({ account: "second", stray: 1 });
  });
  it("accepts explicit non-default values for role, state, agentId, resultText, error", () => {
    const t = TaskRecordSchema.parse({
      taskId: "t1", queue: "w", prompt: "p", createdAt: 1,
      role: "dev", state: "in_progress", agentId: "a1", resultText: "ok", error: null,
    });
    expect(t.role).toBe("dev");
    expect(t.state).toBe("in_progress");
    expect(t.agentId).toBe("a1");
    expect(t.resultText).toBe("ok");
  });
});

describe("AssignParams (Task C1)", () => {
  it("parses the agentId target shape, priority omitted", () => {
    const p = AssignParams.parse({ target: { agentId: "a1" }, prompt: "hi" });
    expect(p.target).toEqual({ agentId: "a1" });
    expect(p.priority).toBeUndefined();
  });

  it("parses the team target shape without role", () => {
    const p = AssignParams.parse({ target: { team: "crew" }, prompt: "hi" });
    expect(p.target).toEqual({ team: "crew" });
  });

  it("parses the team target shape with an optional role and priority", () => {
    const p = AssignParams.parse({ target: { team: "crew", role: "dev" }, prompt: "hi", priority: 5 });
    expect(p.target).toEqual({ team: "crew", role: "dev" });
    expect(p.priority).toBe(5);
  });

  it("rejects a blank (empty-string) prompt", () => {
    expect.assertions(1);
    expect(() => AssignParams.parse({ target: { agentId: "a1" }, prompt: "" })).toThrow();
  });

  it("rejects a target with neither agentId nor team", () => {
    expect.assertions(1);
    expect(() => AssignParams.parse({ target: {}, prompt: "hi" })).toThrow();
  });

  it("rejects a target mixing agentId and team keys (each union member is strict)", () => {
    expect.assertions(1);
    expect(() => AssignParams.parse({ target: { agentId: "a1", team: "crew" }, prompt: "hi" })).toThrow();
  });

  it("rejects an empty-string agentId in the target (min(1))", () => {
    expect.assertions(1);
    expect(() => AssignParams.parse({ target: { agentId: "" }, prompt: "hi" })).toThrow();
  });

  it("rejects an empty-string team name in the target (min(1))", () => {
    expect.assertions(1);
    expect(() => AssignParams.parse({ target: { team: "" }, prompt: "hi" })).toThrow();
  });

  it("rejects an empty-string role when provided (min(1))", () => {
    expect.assertions(1);
    expect(() => AssignParams.parse({ target: { team: "crew", role: "" }, prompt: "hi" })).toThrow();
  });

  it("rejects a missing prompt entirely", () => {
    expect.assertions(1);
    expect(() => AssignParams.parse({ target: { agentId: "a1" } })).toThrow();
  });

  it("rejects a non-integer priority", () => {
    expect.assertions(1);
    expect(() => AssignParams.parse({ target: { agentId: "a1" }, prompt: "hi", priority: 1.5 })).toThrow();
  });

  it("accepts a negative integer priority (no lower bound)", () => {
    const p = AssignParams.parse({ target: { agentId: "a1" }, prompt: "hi", priority: -3 });
    expect(p.priority).toBe(-3);
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect.assertions(1);
    expect(() => AssignParams.parse({ target: { agentId: "a1" }, prompt: "hi", bogus: 1 })).toThrow();
  });

  it("rejects an unknown key inside the target (each union member is strict)", () => {
    expect.assertions(1);
    expect(() => AssignParams.parse({ target: { agentId: "a1", extra: 1 }, prompt: "hi" })).toThrow();
  });
});
