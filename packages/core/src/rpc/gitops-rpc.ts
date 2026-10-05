import type { GitTarget } from "@chimera/protocol";
import type { ContractHandlers } from "@chimera/protocol/contract";
import { GitOps, GitOpsError } from "../gitops.js";

type Methods = "worktree.gitStatus" | "worktree.gitDiff" | "worktree.fileRead" | "worktree.fileWrite" | "worktree.gitStage" | "worktree.gitCommit";
export class GitOpsRpc {
  readonly handlers: Pick<ContractHandlers, Methods>;
  constructor(deps: { resolve: (target: GitTarget, caller?: string) => string; writeReason: (root: string, caller?: string) => string | null; ops?: GitOps }) {
    const ops = deps.ops ?? new GitOps();
    const rootFor = (p: { target: GitTarget; callerAgentId?: string }, write = false) => {
      const root = deps.resolve(p.target, p.callerAgentId);
      const reason = write ? deps.writeReason(root, p.callerAgentId) : null;
      if (reason) throw new GitOpsError("lease_held", reason);
      return root;
    };
    this.handlers = {
      "worktree.gitStatus": p => { const root = rootFor(p); const reason = deps.writeReason(root, p.callerAgentId); return { ...ops.status(root), writable: !reason, writeReason: reason }; },
      "worktree.gitDiff": p => ops.diff(rootFor(p), p.path, p.staged, p.context, p.maxBytes),
      "worktree.fileRead": p => ops.read(rootFor(p), p.path),
      "worktree.fileWrite": p => ops.write(rootFor(p, true), p.path, p.text, p.expectedContentVersion),
      "worktree.gitStage": p => ops.stage(rootFor(p, true), p.paths, p.unstage, p.expectedHead, p.expectedIndexFingerprint),
      "worktree.gitCommit": p => ops.commit(rootFor(p, true), p.message, p.expectedHead, p.expectedIndexFingerprint),
    };
  }
}
