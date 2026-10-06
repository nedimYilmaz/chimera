import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBackend } from "@chimera/core/backend";
import type { AgentRecord } from "@chimera/core/supervisor";

// Only this test's module graph intercepts removal, and only for its temporary project.
const removal = vi.hoisted(() => ({ path: "", fail: false, partial: false, calls: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (String(args[0]) === removal.path) {
        removal.calls++;
        if (removal.fail) {
          if (removal.partial) actual.rmSync(`${removal.path}/removed.txt`);
          throw Object.assign(new Error("EACCES: injected removal failure"), { code: "EACCES" });
        }
      }
      return actual.rmSync(...args);
    },
  };
});

const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { Engine } = await import("@chimera/core/engine");
const { FakeAgentBackend } = await import("@chimera/core/backends/fake");
const { makeEngineHome } = await import("./helpers.js");

const temporaryPaths: string[] = [];
const engines: InstanceType<typeof Engine>[] = [];
function engine(home: string) {
  const e = new Engine({ home, backends: new Map<string, AgentBackend>([
    ["claude", new FakeAgentBackend([[{ awaitSend: true }]])],
  ]) });
  engines.push(e);
  return e;
}
async function setup() {
  const home = makeEngineHome();
  const path = mkdtempSync(join(tmpdir(), "chimera-delete-failure-"));
  temporaryPaths.push(home, path);
  const e = engine(home);
  await e.handle("project.create", { name: "offline", path, autoConductor: false });
  writeFileSync(join(path, "removed.txt"), "first file");
  writeFileSync(join(path, "leftover.txt"), "recoverable file");
  Object.assign(removal, { path, fail: true, partial: false, calls: 0 });
  return { e, home, path };
}
afterEach(() => {
  removal.path = "";
  vi.restoreAllMocks();
  for (const e of engines.splice(0)) e.events.flushDurable();
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("project.delete filesystem failure", () => {
  it.each([false, true])("rejects and preserves registration after removal fails (partial=%s), then permits retry", async (partial) => {
    const { e, home, path } = await setup();
    removal.partial = partial;
    const events = vi.spyOn(e.events, "append");

    const outcome = await e.handle("project.delete", { name: "offline", deleteFiles: true })
      .then((result) => ({ result }), (error: unknown) => ({ error }));
    expect(removal.calls).toBe(1);
    expect(existsSync(join(path, "removed.txt"))).toBe(!partial);
    expect(readFileSync(join(path, "leftover.txt"), "utf8")).toBe("recoverable file");
    const registered = await e.handle("project.list", {});
    const persisted = JSON.parse(readFileSync(join(home, "projects.json"), "utf8")) as unknown;
    expect({ outcome, registered, persisted }).toMatchObject({ outcome: { error: {
      code: "filesystem",
      message: `failed to delete project "offline" directory "${path}": EACCES: injected removal failure. Registration retained; directory may be partially removed. Fix the filesystem error and retry, or delete registration only with deleteFiles:false.`,
    } }, registered: [{ name: "offline", path }], persisted: [{ name: "offline", path }] });
    expect(events.mock.calls.some(([event]) => event.data["state"] === "deleted" || event.data["orphanedTeams"])).toBe(false);

    // Read persisted state through a fresh store, so a daemon restart cannot strand the leftover.
    const reloaded = engine(home);
    expect(await reloaded.handle("project.list", {})).toMatchObject([{ name: "offline", path }]);
    removal.fail = false;
    expect(await reloaded.handle("project.delete", { name: "offline", deleteFiles: true })).toEqual({ deleted: true });
    expect(existsSync(path)).toBe(false);
    expect(await reloaded.handle("project.list", {})).toEqual([]);
  });

  it("allows registration-only recovery after a failed wipe without attempting removal again", async () => {
    const { e, path } = await setup();
    await expect(e.handle("project.delete", { name: "offline", deleteFiles: true })).rejects.toMatchObject({ code: "filesystem" });
    expect(await e.handle("project.delete", { name: "offline", deleteFiles: false })).toEqual({ deleted: true });
    expect(removal.calls).toBe(1);
    expect(existsSync(join(path, "leftover.txt"))).toBe(true);
    expect(await e.handle("project.list", {})).toEqual([]);
  });

  it("keeps registration-only deletion as the default even when removal would fail", async () => {
    const { e, path } = await setup();
    expect(await e.handle("project.delete", { name: "offline" })).toEqual({ deleted: true });
    expect(removal.calls).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("refuses a wipe before filesystem access while another live agent works under the project", async () => {
    const { e, path } = await setup();
    const record = await e.handle("agent.spawn", { spec: { prompt: "offline guard", cwd: path, isolation: "none" } }) as AgentRecord;
    try {
      await expect(e.handle("project.delete", { name: "offline", deleteFiles: true })).rejects.toMatchObject({ code: "conflict" });
      expect(removal.calls).toBe(0);
      expect(await e.handle("project.list", {})).toMatchObject([{ name: "offline", path }]);
      expect(existsSync(join(path, "leftover.txt"))).toBe(true);
    } finally {
      await e.handle("agent.kill", { agentId: record.agentId });
    }
  });

  it("treats an already absent directory as a successful wipe", async () => {
    const { e, path } = await setup();
    removal.fail = false;
    rmSync(path, { recursive: true, force: true });
    expect(await e.handle("project.delete", { name: "offline", deleteFiles: true })).toEqual({ deleted: true });
    expect(await e.handle("project.list", {})).toEqual([]);
  });
});
