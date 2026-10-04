// GUARDRAIL-BOOTSTRAP: GuardrailError lives in its own zero-dependency module rather than
// supervisor.ts so that bootstrap-time code can import it without pulling in supervisor.ts's
// full graph (@chimera/protocol -> zod, accounts, credentials, ...). workdir.ts's
// setupWorktreeNodeModules/repairMainChimeraLinks — and their CLI entry point,
// scripts/setup-worktree-modules.mjs — run BEFORE a fresh worktree has any node_modules at
// all, so importing anything that transitively needs zod to already be resolvable would make
// the bootstrap script unable to bootstrap itself. supervisor.ts re-exports this so every
// existing `import { GuardrailError } from "@chimera/core/supervisor"` site keeps working
// unchanged.
export class GuardrailError extends Error { code = "guardrail" as const; name = "GuardrailError"; }
