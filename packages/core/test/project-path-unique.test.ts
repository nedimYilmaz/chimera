import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// PROJECT-PATH-UNIQUE + PROJECT-SCOPED-LIVE-SESSIONS. Registering one directory as two projects
// looked harmless and was not: each registration grew its OWN conductor, both conductors' cwd
// resolved to the same folder, and the UI — which names a conductor after its resolved project —
// showed two identically named rows disambiguated with a "-2" suffix, reading as a duplicated
// AGENT rather than the duplicated PROJECT it was. It also deadlocked deletion: the delete guard
// counted live sessions by PATH, so removing one project was refused because the OTHER project's
// conductor was running there — a refusal the operator could not act on without killing work
// that belonged to a project they were keeping.

const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend([[{ awaitSend: true }]])]]);
const newDir = (): string => mkdtempSync(join(tmpdir(), "chimera-proj-"));

describe("one directory, one project", () => {
  it("refuses a second project at the same path, naming the one already there", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const path = newDir();
    await e.handle("project.create", { name: "first", path });
    await expect(e.handle("project.create", { name: "second", path })).rejects.toMatchObject({
      message: expect.stringContaining("first"),
    });
    expect(((await e.handle("project.list", {})) as unknown[]).length).toBe(1);
  });

  it("still refuses when the same directory is spelled differently", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const path = newDir();
    mkdirSync(join(path, "sub"), { recursive: true });
    await e.handle("project.create", { name: "first", path });
    // a trailing slash and a "go down then back up" segment are the same folder
    await expect(e.handle("project.create", { name: "second", path: `${path}/` })).rejects.toBeTruthy();
    await expect(e.handle("project.create", { name: "third", path: join(path, "sub", "..") })).rejects.toBeTruthy();
  });

  it("a different directory is still fine", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("project.create", { name: "a", path: newDir() });
    await e.handle("project.create", { name: "b", path: newDir() });
    expect(((await e.handle("project.list", {})) as unknown[]).length).toBe(2);
  });
});

describe("the delete guard counts the project's OWN sessions", () => {
  it("a session belonging to another project no longer blocks this one's delete", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const path = newDir();
    await e.handle("project.create", { name: "keeper", path });
    // Simulate the pre-guard world: a second registration at the same path. It has to be
    // installed BELOW ProjectStore.create (which now refuses exactly this), because the case
    // under test is the data an existing install already carries, not one it can still make.
    const store = (e as unknown as { projects: { projects: Map<string, unknown>; save(): void; get(n: string): unknown } }).projects;
    store.projects.set("stale", { ...(store.get("keeper") as Record<string, unknown>), name: "stale" });
    store.save();

    // A live agent in that directory, owned by "keeper".
    await e.handle("agent.spawn", { spec: { prompt: "work", cwd: path, isolation: "none" } });
    await new Promise((r) => setTimeout(r, 10));

    // Deleting the STALE registration must not be blocked by keeper's session...
    await e.handle("project.delete", { name: "stale" });
    const names = ((await e.handle("project.list", {})) as Array<{ name: string }>).map((p) => p.name);
    expect(names).toEqual(["keeper"]);
  });
});
