// HOOK-6 (PLAN-HOOKS.md §7) — the lifecycle-hooks card's own CRUD store, cloned
// 1:1 from commands.notify.ts (HostToolsCard shape discipline: a PURE factory over
// injected deps, unit-testable against a stub request).
//
// HOOK-CRUD-RPC: storage is still ChimeraConfig.hooks on the D7 overlay, but the CRUD now goes
// through the hook.* RPC family instead of assembling config.patch({hooks:[...]}) here. The old
// path had to send the WHOLE desired array on every write (JSON-merge-patch replaces an array,
// it cannot merge one), so a rule an agent installed between this card's read and its write was
// silently erased — and vice versa. hook.create/update/setEnabled/delete do that read-modify-
// write inside one daemon turn, so the card no longer has to hold the whole array to change one
// rule. Reads stay a plain list. Unlike notify there is still no per-rule "test" RPC (hooks fire
// off real events, not a sample).
import type { HookRule, HookAction, Topic, TopicFilter } from "@chimera/protocol";
import type { UiStore } from "@chimera/ui-state";
import { buildHookRows, hookDraftFilterIssue, isContentTopic, reconcileFilterKey, HOOK_TOPICS, type HookRuleRow } from "./selectors.hooks";

export type RequestFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;

const errMessage = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
};

// ---------------------------------------------------------------------------
// form draft — a flat, per-action-type shape (one editor row per action). Every
// action-type's fields live on the same object; buildAction reads only the ones
// relevant to `type`, exactly the way NotifyFormDraft carries webhookUrl for all
// channels but only uses it for "webhook".
// ---------------------------------------------------------------------------

export type ChannelKind = "toast" | "os" | "webhook" | "a2a";

export type HookActionDraft = {
  type: HookAction["type"];
  to: string;          // notify
  text: string;        // notify
  queue: string;       // push
  prompt: string;      // push / spawn
  role: string;        // push / spawn
  command: string;     // run
  timeoutSec: string;  // run
  channel: ChannelKind; // channel
  webhookUrl: string;  // channel
};

export const blankAction: HookActionDraft = {
  type: "notify", to: "", text: "", queue: "", prompt: "", role: "", command: "", timeoutSec: "60", channel: "toast", webhookUrl: "",
};

export type HookFormDraft = {
  name: string;
  topic: Topic;
  filterKey: string;
  filterValue: string;
  /** F46.UI: the filter keys the single key/value pair cannot show. An agent-installed
   * agent.output rule is typically `{agentId, contains}` — two keys — so editing it in a
   * one-pair form used to silently DROP the second one and widen the rule fleet-wide.
   * They are carried read-only through the edit and spread back on save. */
  extraFilter?: TopicFilter;
  actions: HookActionDraft[];
  enabled: boolean;
};

const blankDraft: HookFormDraft = {
  name: "", topic: "task.state", filterKey: "", filterValue: "", actions: [{ ...blankAction }], enabled: true,
};

export type HooksState = {
  open: boolean;
  rules: HookRule[];
  loaded: boolean;
  selected: number;
  formOpen: boolean;
  /** the rule name being edited; null while the form is a "new rule" draft. */
  editing: string | null;
  draft: HookFormDraft;
  formError: string | null;
  confirmDelete: string | null;
};

const initial: HooksState = {
  open: false, rules: [], loaded: false, selected: 0, formOpen: false, editing: null, draft: blankDraft, formError: null, confirmDelete: null,
};

function actionToDraft(a: HookAction): HookActionDraft {
  const d: HookActionDraft = { ...blankAction, type: a.type };
  if (a.type === "notify") { d.to = a.to; d.text = a.text; }
  else if (a.type === "push") { d.queue = a.queue; d.prompt = a.prompt; d.role = a.role ?? ""; }
  else if (a.type === "spawn") { d.prompt = a.spec.prompt; d.role = a.spec.role ?? ""; }
  else if (a.type === "run") { d.command = a.command; d.timeoutSec = String(a.timeoutSec); }
  else if (a.type === "channel") { d.channel = a.channel; d.webhookUrl = a.webhookUrl ?? ""; }
  return d;
}

// Exported for the round-trip test: edit-then-save of an agent-installed rule must be an
// identity, not a silent key drop.
export function draftFromRule(r: HookRule): HookFormDraft {
  const entries = Object.entries(r.filter ?? {});
  // The pair shows the key the operator cares about: on a content topic that is always the
  // needle (`contains`), whatever order the daemon serialized the filter in.
  const primary = entries.find(([k]) => k === "contains" && isContentTopic(r.on)) ?? entries[0];
  const [filterKey, filterValue] = primary ?? ["", ""];
  const extra = Object.fromEntries(entries.filter(([k]) => k !== filterKey)) as TopicFilter;
  return {
    name: r.name,
    topic: r.on,
    ...(Object.keys(extra).length > 0 ? { extraFilter: extra } : {}),
    filterKey,
    filterValue: filterValue === undefined ? "" : Array.isArray(filterValue) ? filterValue.join(",") : String(filterValue),
    actions: r.actions.length > 0 ? r.actions.map(actionToDraft) : [{ ...blankAction }],
    enabled: r.enabled,
  };
}

/** Build ONE discriminated-union action from its flat draft, or an error string. */
function actionFromDraft(d: HookActionDraft): HookAction | { error: string } {
  switch (d.type) {
    case "notify": {
      if (!d.to.trim()) return { error: "notify: target (to) is required" };
      if (!d.text.trim()) return { error: "notify: message text is required" };
      return { type: "notify", to: d.to.trim(), text: d.text };
    }
    case "push": {
      if (!d.queue.trim()) return { error: "push: queue is required" };
      if (!d.prompt.trim()) return { error: "push: prompt is required" };
      return { type: "push", queue: d.queue.trim(), prompt: d.prompt, ...(d.role.trim() ? { role: d.role.trim() } : {}) };
    }
    case "spawn": {
      if (!d.prompt.trim()) return { error: "spawn: prompt is required" };
      return { type: "spawn", spec: { prompt: d.prompt, ...(d.role.trim() ? { role: d.role.trim() } : {}) } };
    }
    case "run": {
      if (!d.command.trim()) return { error: "run: command is required" };
      const timeoutSec = Number(d.timeoutSec);
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > 600) return { error: "run: timeout must be 1–600 seconds" };
      return { type: "run", command: d.command.trim(), timeoutSec: Math.floor(timeoutSec) };
    }
    case "channel": {
      if (d.channel === "webhook" && !d.webhookUrl.trim()) return { error: "channel: webhook url is required for the webhook channel" };
      return { type: "channel", channel: d.channel, ...(d.channel === "webhook" && d.webhookUrl.trim() ? { webhookUrl: d.webhookUrl.trim() } : {}) };
    }
  }
}

// TASK-TAGS: `tags` is the one TopicFilter key whose value is an ARRAY of its own — every other
// key is a scalar-or-array. The old one-line `{ [key]: value }` always produced a STRING, so
// choosing "tags" in this form built a filter TopicFilterSchema rejects outright: the card could
// not express a tag filter at all, which is precisely the filter task tags exist for. Comma-split
// (trimmed, blanks dropped) is the form's list convention; an empty result drops the filter
// entirely rather than sending `{tags: []}`, which matches nothing by definition.
export function filterFromDraft(key: string, value: string): TopicFilter | undefined {
  const k = key.trim();
  if (!k) return undefined;
  if (k === "tags") {
    const tags = value.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
    return tags.length > 0 ? ({ tags } as TopicFilter) : undefined;
  }
  return { [k]: value } as TopicFilter;
}

// HOOK-CRUD-RPC: a full rule -> the sparse patch hook.update takes. `filter: null` is how the
// RPC expresses "clear this rule's filter" (HookRuleSchema's filter is optional, not nullable),
// so an edit that removed the filter has to send null rather than simply omitting the key.
function patchFrom(rule: HookRule): Record<string, unknown> {
  return {
    on: rule.on,
    filter: rule.filter ?? null,
    actions: rule.actions,
    enabled: rule.enabled,
  };
}

export function ruleFromDraft(d: HookFormDraft): HookRule | { error: string } {
  const name = d.name.trim();
  if (!name) return { error: "name is required" };
  if (!HOOK_TOPICS.includes(d.topic)) return { error: "a valid topic is required" };
  if (d.actions.length === 0) return { error: "at least one action is required" };
  if (d.actions.length > 4) return { error: "at most 4 actions per rule" };
  const actions: HookAction[] = [];
  for (const ad of d.actions) {
    const built = actionFromDraft(ad);
    if ("error" in built) return { error: built.error };
    actions.push(built);
  }
  // Same verdict the daemon would return, raised as an inline form error instead of a
  // round-trip failure (the schema is still the authority — this is only the fast path).
  const filterIssue = hookDraftFilterIssue(d.topic, d.filterKey, d.filterValue);
  if (filterIssue) return { error: filterIssue };
  const pair = filterFromDraft(d.filterKey, d.filterValue);
  const extra = d.extraFilter && Object.keys(d.extraFilter).length > 0 ? d.extraFilter : undefined;
  const filter = pair || extra ? ({ ...extra, ...pair } as TopicFilter) : undefined;
  // maxChainDepth/maxFiresPerHour carry HookRuleSchema's own defaults (3/20) — omitted
  // here so the server re-applies them, exactly as an omitted-enabled would.
  return {
    name,
    enabled: d.enabled,
    on: d.topic,
    ...(filter ? { filter } : {}),
    actions,
  } as HookRule;
}

export type HooksCommands = ReturnType<typeof createHooksCommands>;

export function createHooksCommands(store: UiStore, request: RequestFn) {
  let state: HooksState = initial;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<HooksState>): void => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };
  const fail = (err: unknown): void => store.dispatch({ type: "commandError", message: errMessage(err) });

  /** rows carry each rule's live activity, folded in the ui-state reducer under
   * state.hooks (hook_fired/hook_suppressed) — read fresh on every render so the
   * card's activity column live-updates (the card also subscribes to the app store
   * to force that re-render). */
  const rows = (): HookRuleRow[] => buildHookRows(state.rules, store.getState().hooks);

  const refresh = async (): Promise<void> => {
    try {
      const rules = await request<HookRule[]>("hook.list", {});
      const max = Math.max(0, rules.length - 1);
      set({ rules: Array.isArray(rules) ? rules : [], loaded: true, selected: Math.min(state.selected, max) });
    } catch (err) {
      fail(err); // keep the previous rows
    }
  };

  /** One rule-scoped mutation, then re-read. Scoped rather than whole-array: a concurrent
   * change by an agent (or another window) survives instead of being overwritten by whatever
   * this card happened to have loaded. */
  const mutate = async (method: string, params: Record<string, unknown>): Promise<boolean> => {
    try {
      await request(method, params);
      await refresh();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  return {
    getState: (): HooksState => state,
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    rows,
    refresh,

    toggle: (): void => {
      if (state.open) { set({ open: false, formOpen: false, confirmDelete: null }); return; }
      set({ open: true, selected: 0 });
      void refresh();
    },

    /** esc tiering: form → confirm → card (NotifyRulesCard precedent). */
    escape: (): void => {
      if (state.formOpen) { set({ formOpen: false, formError: null }); return; }
      if (state.confirmDelete !== null) { set({ confirmDelete: null }); return; }
      set({ open: false });
    },

    select: (i: number): void => set({ selected: Math.min(Math.max(0, i), Math.max(0, state.rules.length - 1)) }),
    move: (delta: number): void => set({ selected: Math.min(Math.max(0, state.selected + delta), Math.max(0, state.rules.length - 1)) }),

    openNew: (): void => set({ formOpen: true, editing: null, draft: { ...blankDraft, actions: [{ ...blankAction }] }, formError: null }),

    openEdit: (): void => {
      const r = state.rules[state.selected];
      if (!r) return;
      set({ formOpen: true, editing: r.name, draft: draftFromRule(r), formError: null });
    },

    // F46/QA finding E: changing the topic REWRITES the filter key when the old one is illegal
    // on the new topic (contains is required on a content topic and rejected everywhere else).
    // Done at the store seam, not only in the card, so any caller gets a legal draft.
    updateDraft: (patch: Partial<HookFormDraft>): void => {
      const draft = { ...state.draft, ...patch };
      if (patch.topic !== undefined && patch.filterKey === undefined) {
        draft.filterKey = reconcileFilterKey(draft.topic, state.draft.filterKey);
        if (draft.filterKey !== state.draft.filterKey) draft.filterValue = "";
      }
      // Carried-over keys belong to the topic they were authored for; retargeting the rule
      // must not smuggle them onto the new topic (TopicFilterSchema would reject some outright).
      if (patch.topic !== undefined && patch.topic !== state.draft.topic) delete draft.extraFilter;
      set({ draft, formError: null });
    },

    /** action-list editing (the 5-type editor): add / remove / patch one row. */
    addAction: (): void => {
      if (state.draft.actions.length >= 4) return;
      set({ draft: { ...state.draft, actions: [...state.draft.actions, { ...blankAction }] }, formError: null });
    },
    removeAction: (i: number): void => {
      if (state.draft.actions.length <= 1) return;
      set({ draft: { ...state.draft, actions: state.draft.actions.filter((_, j) => j !== i) }, formError: null });
    },
    updateAction: (i: number, patch: Partial<HookActionDraft>): void => {
      set({ draft: { ...state.draft, actions: state.draft.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) }, formError: null });
    },

    submitForm: async (): Promise<boolean> => {
      const built = ruleFromDraft(state.draft);
      if ("error" in built) { set({ formError: built.error }); return false; }
      // Local duplicate check kept as the FAST feedback path (an inline form error beats a
      // round-trip). hook.create refuses a duplicate server-side regardless, which is what
      // actually closes the window between this check and the write.
      const dupe = state.rules.some((r) => r.name === built.name && r.name !== state.editing);
      if (dupe) { set({ formError: `a rule named "${built.name}" already exists` }); return false; }
      // A rename is still a delete+create: hook.update is keyed BY name, so it has no way to
      // express "and call it something else".
      const renaming = state.editing !== null && state.editing !== built.name;
      const ok = state.editing === null || renaming
        ? (renaming ? await mutate("hook.delete", { name: state.editing }) : true)
          && await mutate("hook.create", { rule: built })
        : await mutate("hook.update", { name: state.editing, patch: patchFrom(built) });
      if (ok) set({ formOpen: false, formError: null });
      return ok;
    },

    toggleSelected: (): Promise<void> => {
      const r = state.rules[state.selected];
      if (!r) return Promise.resolve();
      return mutate("hook.setEnabled", { name: r.name, enabled: !r.enabled }).then(() => {});
    },

    requestDelete: (): void => {
      const r = state.rules[state.selected];
      if (r) set({ confirmDelete: r.name });
    },

    confirmDelete: (): Promise<void> => {
      const name = state.confirmDelete;
      if (!name) return Promise.resolve();
      set({ confirmDelete: null });
      return mutate("hook.delete", { name }).then(() => {});
    },

    cancelDelete: (): void => set({ confirmDelete: null }),
  };
}

let cardSingleton: HooksCommands | null = null;
export function getHooksCommands(store: UiStore, request: RequestFn): HooksCommands {
  if (!cardSingleton) cardSingleton = createHooksCommands(store, request);
  return cardSingleton;
}
