import { projectsLocal } from "../../src/state/commands.projects";

const path = `/synthetic/projects/${"long-directory-name-".repeat(18)}/selected-project`;
const items = [
  { name: "delete-fixture", path, origin: null, teams: [], queue: null, sessions: 0, archived: false },
  { name: "second-fixture", path: "/synthetic/second-project", origin: null, teams: [], queue: null, sessions: 0, archived: false },
];

let pending: { resolve(value: unknown): void; reject(error: unknown): void } | null = null;

// No filesystem or daemon calls: only the production component/commands execute.
export const projectDeleteFixture = {
  active: false,
  reject: false,
  defer: false,
  calls: [] as Record<string, unknown>[],
  reset() { projectsLocal.reset(); this.reject = false; this.defer = false; this.calls = []; pending = null; },
  settle(outcome: "resolve" | "reject") {
    const response = pending; pending = null;
    if (!response) throw new Error("No deferred deletion");
    if (outcome === "resolve") response.resolve({ deleted: true });
    else response.reject({ code: "conflict", message: "Synthetic deferred live cwd refusal" });
  },
  selectSecond() { projectsLocal.set({ cursor: 1 }); },
  snapshot() { return { calls: this.calls, path, selection: projectsLocal.getState().confirmDeleteFiles, target: projectsLocal.getState().confirmDelete, pending: pending !== null, selected: items[projectsLocal.getState().cursor]?.name }; },
  rpc(method: string, params: Record<string, unknown>) {
    if (method === "project.list") return items;
    if (method === "project.status") return { spec: items.find((p) => p.name === params.name), sessions: [], teams: [] };
    if (method === "fs.list") return { path: "", entries: [], truncated: false };
    if (method === "project.delete") {
      this.calls.push(params);
      if (this.defer) return new Promise((resolve, reject) => { pending = { resolve, reject }; });
      if (this.reject) throw { code: "conflict", message: "Synthetic live cwd refusal: finish the active session before deleting" };
      return { deleted: true };
    }
    return [];
  },
};
