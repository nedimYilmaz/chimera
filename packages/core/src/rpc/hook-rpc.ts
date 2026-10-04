// HOOK-CRUD-RPC: the hook.list/create/update/setEnabled/delete family — thin, atomic CRUD over
// ChimeraConfig.hooks, mirroring sub-rpc.ts's shape.
//
// Storage is deliberately UNCHANGED: rules still live on the config.d overlay, and the desktop
// HooksCard still reads and writes them through config.get / config.patch ({hooks:[...]}) — one
// store, one source of truth. What this family adds is doing the read-modify-write on the
// DAEMON side. A caller assembling its own config patch needs three round trips (get the array,
// splice it, patch it back), and JSON-merge-patch replaces an array wholesale rather than
// merging it — so two agents each adding a rule interleave into one of the two rules silently
// disappearing. Here the read and the write happen inside a single synchronous engine turn,
// which makes that interleaving structurally impossible.
//
// It also gives the MCP surface a real hook_create/hook_list/... Before this, an agent that
// scanned the tool catalogue for a way to install a lifecycle hook correctly concluded there
// wasn't one — the capability existed but only as "hand-assemble a config patch".
import { HookRuleSchema, type HookRule } from "@chimera/protocol";
import type { ContractHandlers } from "@chimera/protocol/contract";
import { TOPIC_TABLE } from "../topics.js";

// `code = "protocol"` so engine.handle()'s normalizer turns these into the same clean
// {code,message} the queue/team families already return, not an "unknown" 500-shaped error.
export class UnknownHookError extends Error { code = "protocol" as const; name = "UnknownHookError"; }
export class DuplicateHookError extends Error { code = "protocol" as const; name = "DuplicateHookError"; }
// QA-FIX F46/F: subscriptions.ts's MAX_CONTENT_SUBS_TOTAL bounds content SUBSCRIPTIONS
// daemon-wide, but hook rules were never counted against any cap — a standing content hook rule
// (deliberately exempt from forced once:true, unlike subscriptions) could bypass that budget
// entirely. `code = "guardrail"` mirrors SubscriptionCapError's refusal shape.
export class HookCapError extends Error { code = "guardrail" as const; name = "HookCapError"; }
const MAX_CONTENT_HOOK_RULES = 64;

export type HookRpcHandlers = Pick<
  ContractHandlers, "hook.list" | "hook.create" | "hook.update" | "hook.setEnabled" | "hook.delete"
>;

export type HookRpcDeps = {
  /** The effective config's current rules. */
  readHooks: () => HookRule[];
  /**
   * Replace the whole rule array. The implementation validates the config as a whole and throws
   * WITHOUT writing on any failure (the D7 config_error posture), so every mutator below can
   * build its next array optimistically and let an invalid result be refused at the write.
   */
  writeHooks: (rules: HookRule[]) => void;
};

export class HookRpc {
  readonly handlers: HookRpcHandlers;

  constructor(private readonly deps: HookRpcDeps) {
    this.handlers = {
      "hook.list": () => this.deps.readHooks(),

      "hook.create": (p) => {
        const rules = this.deps.readHooks();
        // Refused, not upserted: silently replacing a rule someone else installed is exactly the
        // clobber this family exists to prevent — an intentional overwrite goes through
        // hook.update, which says so.
        if (rules.some((r) => r.name === p.rule.name))
          throw new DuplicateHookError(`hook "${p.rule.name}" already exists (use hook.update to change it)`);
        // Parse here rather than trusting the request schema's output object: this is what
        // applies HookRuleSchema's own defaults (enabled/maxChainDepth/maxFiresPerHour) so the
        // stored rule and the returned one are the fully-resolved rule, not the caller's sparse input.
        const rule = HookRuleSchema.parse(p.rule);
        const next = [...rules, rule];
        this.assertContentCap(next);
        this.deps.writeHooks(next);
        return rule;
      },

      "hook.update": (p) => {
        const rules = this.deps.readHooks();
        const idx = this.indexOf(rules, p.name);
        // `filter: null` is the only way a sparse patch can EXPRESS "drop this rule's filter"
        // (HookRuleSchema's filter is optional, not nullable), so it's translated to a key
        // removal rather than written through as a null the schema would reject.
        const { filter, ...rest } = p.patch;
        const merged: Record<string, unknown> = { ...rules[idx]!, ...rest };
        if (filter === null) delete merged["filter"];
        else if (filter !== undefined) merged["filter"] = filter;
        // Re-validated as a WHOLE rule: a patch that would make it invalid (e.g. actions: [])
        // throws here, before writeHooks, so the stored rule is untouched.
        const rule = HookRuleSchema.parse(merged);
        const next = [...rules];
        next[idx] = rule;
        this.assertContentCap(next);
        this.deps.writeHooks(next);
        return rule;
      },

      // Separate from hook.update for the same reason queue.pause/resume are separate from
      // queue.update: muting a noisy rule is a frequent operator action, not a config edit.
      "hook.setEnabled": (p) => {
        const rules = this.deps.readHooks();
        const idx = this.indexOf(rules, p.name);
        const rule = HookRuleSchema.parse({ ...rules[idx]!, enabled: p.enabled });
        const next = [...rules];
        next[idx] = rule;
        this.deps.writeHooks(next);
        return rule;
      },

      // Throws on an unknown name rather than returning {deleted:false}: a caller deleting a
      // rule that isn't there has a stale view of the world and should be told, not reassured.
      "hook.delete": (p) => {
        const rules = this.deps.readHooks();
        const idx = this.indexOf(rules, p.name);
        this.deps.writeHooks(rules.filter((_, i) => i !== idx));
        return { deleted: true as const };
      },
    };
  }

  // QA-FIX F46/F: counts rules on a content topic (matchField "text") in the CANDIDATE next
  // array, not just the new/patched rule — a rename via hook.update that turns a non-content
  // rule into a content one must be checked too.
  private assertContentCap(rules: HookRule[]): void {
    const n = rules.filter((r) => TOPIC_TABLE[r.on]?.matchField === "text").length;
    if (n > MAX_CONTENT_HOOK_RULES) {
      throw new HookCapError(`content hook rules are capped at ${MAX_CONTENT_HOOK_RULES} daemon-wide (each one scans every output event, same rationale as subscriptions' MAX_CONTENT_SUBS_TOTAL)`);
    }
  }

  private indexOf(rules: HookRule[], name: string): number {
    const idx = rules.findIndex((r) => r.name === name);
    if (idx === -1) throw new UnknownHookError(`unknown hook "${name}"`);
    return idx;
  }
}
