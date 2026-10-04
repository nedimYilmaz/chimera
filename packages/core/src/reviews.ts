import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ReviewSessionSchema, type ReviewDecision, type ReviewFinding, type ReviewSession } from "@chimera/protocol";
import type { EventLog } from "./events.js";

export class UnknownReviewFindingError extends Error { code = "protocol" as const; name = "UnknownReviewFindingError"; }
export class ReviewResolveForbiddenError extends Error { code = "protocol" as const; name = "ReviewResolveForbiddenError"; }

export class ReviewStore {
  private sessions = new Map<string, ReviewSession>();
  private readonly file: string;
  constructor(dir: string, private readonly events: EventLog, private readonly now: () => number = Date.now) {
    this.file = join(dir, "reviews.json");
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as { sessions: unknown[] };
        for (const value of raw.sessions) { const session = ReviewSessionSchema.parse(value); this.sessions.set(session.taskId, session); }
      } catch (err) {
        this.sessions.clear();
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        console.warn(`chimerad: corrupt review state quarantined: ${(err as Error).message}`);
      }
    }
  }
  private empty(taskId: string): ReviewSession { return { taskId, findings: [], decision: null, revision: 0, updatedAt: 0 }; }
  private save(session: ReviewSession): ReviewSession {
    const parsed = ReviewSessionSchema.parse(session); this.sessions.set(parsed.taskId, parsed);
    const tmp = `${this.file}.tmp`; writeFileSync(tmp, JSON.stringify({ sessions: [...this.sessions.values()] }, null, 2)); renameSync(tmp, this.file);
    this.events.append({ agentId: `task:${parsed.taskId}`, kind: "review_changed", data: { taskId: parsed.taskId, revision: parsed.revision, decision: parsed.decision?.status ?? null } });
    return parsed;
  }
  get(taskId: string): ReviewSession { return this.sessions.get(taskId) ?? this.empty(taskId); }
  addFinding(input: Omit<ReviewFinding, "id" | "status" | "createdAt" | "updatedAt" | "resolvedBy">): ReviewFinding {
    const session = this.get(input.taskId); const at = this.now();
    const finding: ReviewFinding = { ...input, id: randomUUID(), status: "open", createdAt: at, updatedAt: at, resolvedBy: null };
    this.save({ ...session, findings: [...session.findings, finding], revision: session.revision + 1, updatedAt: at }); return finding;
  }
  // F25: a `blocking` finding is a GATE. If the agent that has to satisfy it can also clear it,
  // the gate certifies itself — so a blocking finding is resolvable only by the agent that FILED
  // it, or by the operator (actorAgentId null: the app/TUI/CLI, which has no agent identity).
  // note/warning findings carry no gate and stay resolvable by anyone, including the diff author.
  resolveFinding(taskId: string, findingId: string, actorAgentId: string | null = null): ReviewFinding {
    const session = this.get(taskId); const current = session.findings.find((f) => f.id === findingId);
    if (!current) throw new UnknownReviewFindingError(`unknown review finding "${findingId}"`);
    if (actorAgentId !== null && current.severity === "blocking" && current.authorAgentId !== actorAgentId) {
      throw new ReviewResolveForbiddenError(
        `finding "${findingId}" is blocking and was filed by ${current.authorAgentId ?? "the operator"} — only its author or the operator can resolve it`,
      );
    }
    const finding = { ...current, status: "resolved" as const, resolvedBy: actorAgentId, updatedAt: this.now() };
    this.save({ ...session, findings: session.findings.map((f) => f.id === findingId ? finding : f), revision: session.revision + 1, updatedAt: finding.updatedAt }); return finding;
  }
  decide(taskId: string, input: Omit<ReviewDecision, "revision" | "decidedAt">): ReviewSession {
    const session = this.get(taskId); const at = this.now(); const revision = session.revision + 1;
    return this.save({ ...session, decision: { ...input, revision, decidedAt: at }, revision, updatedAt: at });
  }
}
