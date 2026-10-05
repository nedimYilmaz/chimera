import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ContextLinkSchema, type ContextLink, type ContextLinkCreate, type ContextLinkList, type ContextLinkView } from "@chimera/protocol";
import { scrubSecretShapes } from "./configstore.js";
import { writeFileDurable } from "./durable-write.js";
import { rpcError } from "./rpc-error.js";
import type { AuditAppendInput } from "./audit-ledger.js";

export type ContextAuthority = { operator: true } | { agentId: string };
export type ContextAgent = { agentId: string; treeId: string; projectId: string | null; principal: string; accountName: string; membership?: { team: string } };
const PinSchema = z.object({ projectId: z.string().nullable(), principal: z.string(), accountName: z.string() }).strict();
const StoredSchema = z.object({ link: ContextLinkSchema, consumer: PinSchema, creator: PinSchema.nullable(), sourceAgentId: z.string().nullable().optional() }).strict();
type Stored = z.infer<typeof StoredSchema>;
const pin = (a: ContextAgent) => ({ projectId: a.projectId, principal: a.principal, accountName: a.accountName });
const present = (value: string | null | undefined): value is string => typeof value === "string" && value.trim().length > 0;
const samePin = (a: ContextAgent, p: z.infer<typeof PinSchema>) => present(a.projectId) && present(a.principal) && present(a.accountName) && a.projectId === p.projectId && a.principal === p.principal && a.accountName === p.accountName;
const isOperator = (a: ContextAuthority): a is { operator: true } => "operator" in a;
const MAX_TEXT = 32768, MAX_LINKS = 500, MAX_TOTAL = 4 * 1024 * 1024, WEEK = 7 * 86400000;

export class ContextLinkStore {
  private rows = new Map<string, Stored>();
  private readonly file: string;
  private unavailable = false;
  constructor(home: string, private readonly deps: {
    agent: (id: string) => ContextAgent;
    summary: (id: string) => string | undefined;
    artifact: (id: string) => { agentId: string | null; label: string; sizeBytes: number | null; kind: string; url: string | null };
    artifactText: (id: string, maxBytes: number) => string;
    redact: (id: string, text: string) => string;
    audit: (input: AuditAppendInput) => void;
    changed?: (link: ContextLink) => void;
    now?: () => number;
  }) {
    mkdirSync(home, { recursive: true }); this.file = join(home, "context-links.json");
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8"));
        if (raw.v !== 1) this.unavailable = true;
        else {
          const rows = z.array(StoredSchema).max(MAX_LINKS).parse(raw.links);
          if (rows.reduce((n, r) => n + Buffer.byteLength(r.link.snapshot.text ?? ""), 0) > MAX_TOTAL) throw new Error("snapshot storage cap");
          for (const row of rows) this.rows.set(row.link.id, row);
        }
      } catch { this.unavailable = true; }
    }
  }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private ready(): void { if (this.unavailable) throw rpcError("unsupported", "Context link storage is unreadable or a newer version; file left unchanged"); }
  private save(): void { writeFileDurable(this.file, JSON.stringify({ v: 1, links: [...this.rows.values()] })); }
  private agent(id: string): ContextAgent {
    if (id.includes(":")) throw rpcError("forbidden", "Remote context sources are unavailable");
    try { return this.deps.agent(id); } catch { throw rpcError("source_removed", "Context agent no longer exists"); }
  }
  private peers(a: ContextAgent, b: ContextAgent): boolean {
    return samePin(a, pin(b)) && (present(a.treeId) && a.treeId === b.treeId || present(a.membership?.team) && a.membership.team === b.membership?.team);
  }
  private sourcePresent(link: ContextLink): boolean {
    try {
      if (link.from.kind === "artifact") this.deps.artifact(link.from.ref);
      else this.agent(link.from.ref);
      return true;
    } catch { return false; }
  }
  private status(link: ContextLink): ContextLinkView["status"] {
    if (link.revokedAt !== null) return "revoked";
    if (link.expiresAt !== null && link.expiresAt <= this.now()) return "expired";
    if (!this.sourcePresent(link)) return "source-removed";
    return "active";
  }
  private gc(): void {
    let changed = false;
    for (const [id, row] of this.rows) {
      try { this.agent(row.link.toAgentId); if (row.link.createdBy !== "operator") this.agent(row.link.createdBy); }
      catch { this.rows.delete(id); changed = true; continue; }
      if (this.status(row.link) !== "active" && row.link.snapshot.text !== undefined) {
        delete row.link.snapshot.text; changed = true;
      }
    }
    if (changed) this.save();
  }
  private allowed(row: Stored, authority: ContextAuthority, mutate = false): boolean {
    if (isOperator(authority)) return true;
    const link = row.link;
    if (authority.agentId !== link.createdBy && (mutate || authority.agentId !== link.toAgentId)) return false;
    try {
      const consumer = this.agent(link.toAgentId);
      if (!samePin(consumer, row.consumer)) return false;
      if (link.createdBy !== "operator") {
        const creator = this.agent(link.createdBy);
        if (!row.creator || !samePin(creator, row.creator) || !this.peers(creator, consumer)) return false;
        if (link.from.kind === "artifact" && this.sourcePresent(link) && this.deps.artifact(link.from.ref).agentId !== link.createdBy) return false;
      }
      return true;
    } catch { return false; }
  }
  private view(link: ContextLink, body = false): ContextLinkView {
    const copy = structuredClone(link);
    if (!body || this.status(link) !== "active") delete copy.snapshot.text;
    return { ...copy, status: this.status(link), semantics: "snapshot", untrusted: link.createdBy !== "operator" };
  }
  private audit(action: AuditAppendInput["action"], link: ContextLink, authority: ContextAuthority): void {
    this.deps.audit({ agentId: isOperator(authority) ? "operator" : authority.agentId, action, resource: `contextlink:${link.id}`, decision: "allow", reason: "explicit snapshot access", detail: { id: link.id, bytes: link.snapshot.bytes, sha256: link.snapshot.sha256 } });
  }
  create(p: ContextLinkCreate, authority: ContextAuthority): ContextLinkView {
    this.ready(); this.gc();
    const consumer = this.agent(p.toAgentId);
    const creator = isOperator(authority) ? null : this.agent(authority.agentId);
    if (creator && (!this.peers(creator, consumer) || p.from.kind === "note-snapshot" || p.confirmSecrets || p.expiresAt === null)) throw rpcError("forbidden", "Context sharing is restricted to your own sources and local account/project/team or tree");
    if (p.from.kind !== "note-snapshot" && p.text !== undefined) throw rpcError("protocol", "Source snapshot text is resolved by the engine");
    let text: string; let title: string; let sourceAgentId: string | null = p.from.kind === "artifact" ? null : p.from.ref;
    if (p.from.kind === "artifact") {
      const artifact = this.deps.artifact(p.from.ref);
      if (creator && artifact.agentId !== creator.agentId) throw rpcError("forbidden", "Only your own artifacts may be shared");
      if (artifact.agentId) this.agent(artifact.agentId);
      sourceAgentId = artifact.agentId;
      if (artifact.kind !== "link" && (artifact.sizeBytes === null || artifact.sizeBytes > MAX_TEXT)) throw rpcError("too_large", "Artifact snapshot exceeds 32 KiB; share a bounded text artifact");
      text = artifact.kind === "link" ? artifact.url ?? "" : this.deps.artifactText(p.from.ref, MAX_TEXT);
      title = p.title ?? artifact.label.slice(0, 200);
    } else if (p.from.kind === "agent-summary") {
      this.agent(p.from.ref);
      if (creator && p.from.ref !== creator.agentId) throw rpcError("forbidden", "Only your own summary may be shared");
      text = this.deps.summary(p.from.ref) ?? ""; title = p.title ?? "Agent summary";
      if (!text) throw rpcError("unavailable", "No agent result summary exists yet");
    } else {
      if (!isOperator(authority)) throw rpcError("forbidden", "Private notes require the trusted operator route");
      this.agent(p.from.ref); text = p.text ?? ""; title = p.title ?? "Shared operator note";
      if (!text) throw rpcError("protocol", "Note snapshot is empty");
    }
    if (creator) { text = scrubSecretShapes(this.deps.redact(creator.agentId, text)); title = scrubSecretShapes(this.deps.redact(creator.agentId, title)); }
    else if ((scrubSecretShapes(text) !== text || scrubSecretShapes(title) !== title) && !p.confirmSecrets) throw rpcError("secret_confirmation_required", "Snapshot contains secret-shaped text; preview and explicitly confirm before sharing");
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_TEXT) throw rpcError("too_large", "Snapshot exceeds 32 KiB");
    if (this.rows.size >= MAX_LINKS || [...this.rows.values()].reduce((n, r) => n + (r.link.snapshot.text === undefined ? 0 : r.link.snapshot.bytes), bytes) > MAX_TOTAL) throw rpcError("capacity", "Context snapshot storage limit reached");
    const createdAt = this.now(), expiresAt = p.expiresAt === undefined ? createdAt + WEEK : p.expiresAt;
    if (expiresAt !== null && (expiresAt <= createdAt || creator && expiresAt > createdAt + WEEK)) throw rpcError("protocol", "Expiry must be in the future; agents may share for at most seven days");
    const link: ContextLink = ContextLinkSchema.parse({ id: randomUUID(), from: p.from, toAgentId: p.toAgentId, createdBy: creator?.agentId ?? "operator", createdAt, expiresAt, revokedAt: null, snapshot: { title, bytes, sha256: createHash("sha256").update(text).digest("hex"), text, ...(p.from.kind === "artifact" ? { artifactId: p.from.ref } : {}) } });
    this.rows.set(link.id, { link, consumer: pin(consumer), creator: creator ? pin(creator) : null, sourceAgentId }); this.save(); this.audit("context_link_created", link, authority); this.deps.changed?.(link);
    return this.view(link);
  }
  list(p: ContextLinkList, authority: ContextAuthority): { links: ContextLinkView[] } {
    this.ready(); this.gc();
    // Resolve the caller even for an empty list: stale identities never acquire authority.
    if (!isOperator(authority)) this.agent(authority.agentId);
    return { links: [...this.rows.values()].filter(r => this.allowed(r, authority) && (!p.toAgentId || r.link.toAgentId === p.toAgentId) && (!p.fromAgentId || r.link.createdBy === p.fromAgentId || r.sourceAgentId === p.fromAgentId || r.link.from.kind !== "artifact" && r.link.from.ref === p.fromAgentId)).map(r => this.view(r.link)) };
  }
  private lookup(id: string, authority: ContextAuthority, mutate = false): ContextLink {
    this.ready(); this.gc(); const row = this.rows.get(id);
    if (!row) throw rpcError("not_found", "Context link unavailable");
    if (!this.allowed(row, authority, mutate)) throw rpcError("forbidden", "Context link access denied");
    return row.link;
  }
  get(id: string, authority: ContextAuthority): ContextLinkView {
    const link = this.lookup(id, authority);
    const status = this.status(link);
    if (status !== "active") throw rpcError(status.replace("-", "_"), `Context snapshot ${status}`);
    this.audit("context_link_read", link, authority); return this.view(link, true);
  }
  revoke(id: string, authority: ContextAuthority): ContextLinkView {
    const link = this.lookup(id, authority, true);
    link.revokedAt ??= this.now(); delete link.snapshot.text; this.save(); this.audit("context_link_revoked", link, authority); this.deps.changed?.(link); return this.view(link);
  }
}
