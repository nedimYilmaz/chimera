// W20 (F18 notifications, coverage B22/C16) — the notification-rules card's
// own CRUD store (HostToolsCard/commands.host.ts shape discipline: a PURE
// factory over injected deps, unit-testable against a stub request) PLUS the
// app-wide notify bridge: routing a delivered `notify`/`notify_error` daemon
// event to a toast or an OS notification, and applying a click's deep-link.
//
// Rule storage has NO notify.rules.list/create/update/delete RPC family — CRUD
// is config.get/config.patch({notify:[...]}) (D7 overlay pattern, the SAME
// door SettingsScreen's providers/general sections write through); the ONE
// notify-specific RPC is notify.test (the `t` row test).
import type { NotifyRule } from "@chimera/protocol";
import type { UiStore } from "@chimera/ui-state";
import { buildNotifyRows, deepLinkFor, kindLabel, type NotifyDeepLink, type NotifyRuleRow } from "./selectors.notify";
import { getSettingsCommands } from "./commands.settings";
import { getJobsCommands, jobsLocal } from "./commands.jobs";
import { showOsNotification } from "./notifyOs";

export type RequestFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;

const errMessage = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
};

// ---------------------------------------------------------------------------
// the card's own local store (open/rows/form/confirm — mirrors HostToolsState)
// ---------------------------------------------------------------------------

export type NotifyFormDraft = {
  name: string;
  kind: string;
  filterKey: string;
  filterValue: string;
  channel: NotifyRule["channel"];
  webhookUrl: string;
  throttleSec: string;
  enabled: boolean;
};

const blankDraft: NotifyFormDraft = {
  name: "", kind: "", filterKey: "", filterValue: "", channel: "toast", webhookUrl: "", throttleSec: "60", enabled: true,
};

export type NotifyRulesState = {
  open: boolean;
  rules: NotifyRule[];
  loaded: boolean;
  selected: number;
  formOpen: boolean;
  /** the rule name being edited; null while the form is a "new rule" draft. */
  editing: string | null;
  draft: NotifyFormDraft;
  formError: string | null;
  confirmDelete: string | null;
};

const initial: NotifyRulesState = {
  open: false, rules: [], loaded: false, selected: 0, formOpen: false, editing: null, draft: blankDraft, formError: null, confirmDelete: null,
};

function draftFromRule(r: NotifyRule): NotifyFormDraft {
  const [filterKey, filterValue] = r.on.filter ? Object.entries(r.on.filter)[0] ?? ["", ""] : ["", ""];
  return {
    name: r.name,
    kind: r.on.kind,
    filterKey,
    filterValue: filterValue === undefined ? "" : String(filterValue),
    channel: r.channel,
    webhookUrl: r.webhookUrl ?? "",
    throttleSec: String(r.throttleSec),
    enabled: r.enabled,
  };
}

function ruleFromDraft(d: NotifyFormDraft): NotifyRule | { error: string } {
  const name = d.name.trim();
  if (!name) return { error: "name is required" };
  const kind = d.kind.trim();
  if (!kind) return { error: "event kind is required" };
  const throttleSec = Number(d.throttleSec);
  if (!Number.isFinite(throttleSec) || throttleSec <= 0) return { error: "throttle must be a positive number of seconds" };
  if (d.channel === "webhook" && !d.webhookUrl.trim()) return { error: "webhook url is required for the webhook channel" };
  const filter = d.filterKey.trim() ? { [d.filterKey.trim()]: d.filterValue } : undefined;
  return {
    name,
    on: filter ? { kind, filter } : { kind },
    channel: d.channel,
    ...(d.webhookUrl.trim() ? { webhookUrl: d.webhookUrl.trim() } : {}),
    throttleSec: Math.floor(throttleSec),
    enabled: d.enabled,
  };
}

export type NotifyCommands = ReturnType<typeof createNotifyCommands>;

export function createNotifyCommands(store: UiStore, request: RequestFn) {
  let state: NotifyRulesState = initial;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<NotifyRulesState>): void => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };
  const fail = (err: unknown): void => store.dispatch({ type: "commandError", message: errMessage(err) });

  const rows = (): NotifyRuleRow[] => buildNotifyRows(state.rules);

  /** config.get carries the effective (redacted) ChimeraConfig — `.notify` is
   * server-validated already (ChimeraConfigSchema), so trusting the shape here
   * mirrors commands.settings.ts's autoOrder/dailyCapUsd reads. */
  const refresh = async (): Promise<void> => {
    try {
      const cfg = await request<{ notify?: unknown }>("config.get", {});
      const rules = Array.isArray(cfg?.notify) ? (cfg.notify as NotifyRule[]) : [];
      const max = Math.max(0, rules.length - 1);
      set({ rules, loaded: true, selected: Math.min(state.selected, max) });
    } catch (err) {
      fail(err); // keep the previous rows
    }
  };

  /** Every write replaces the WHOLE array (config.patch is a JSON merge-patch —
   * engine.ts's own doc comment: "send the full desired array, not a per-rule
   * delta"). One reconcile fetch after, same discipline as host.setPolicy. */
  const writeRules = async (rules: NotifyRule[]): Promise<boolean> => {
    try {
      await request("config.patch", { patch: { notify: rules } });
      await refresh();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  return {
    getState: (): NotifyRulesState => state,
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    rows,
    refresh,

    /** the settings-rail "notifications" row / this card's own opener re-toggle. */
    toggle: (): void => {
      if (state.open) { set({ open: false, formOpen: false, confirmDelete: null }); return; }
      set({ open: true, selected: 0 });
      void refresh();
    },

    /** esc tiering: form → confirm → card (HostToolsCard's profile-edit precedent). */
    escape: (): void => {
      if (state.formOpen) { set({ formOpen: false, formError: null }); return; }
      if (state.confirmDelete !== null) { set({ confirmDelete: null }); return; }
      set({ open: false });
    },

    select: (i: number): void => set({ selected: Math.min(Math.max(0, i), Math.max(0, state.rules.length - 1)) }),
    move: (delta: number): void => set({ selected: Math.min(Math.max(0, state.selected + delta), Math.max(0, state.rules.length - 1)) }),

    /** mod+o — the create form, blank. */
    openNew: (): void => set({ formOpen: true, editing: null, draft: blankDraft, formError: null }),

    /** e — the create form PREFILLED from the selected row (W16 edit convention). */
    openEdit: (): void => {
      const r = state.rules[state.selected];
      if (!r) return;
      set({ formOpen: true, editing: r.name, draft: draftFromRule(r), formError: null });
    },

    updateDraft: (patch: Partial<NotifyFormDraft>): void => set({ draft: { ...state.draft, ...patch }, formError: null }),

    /** enter/save — validates, then upserts by name (rename-safe: editing tracks
     * the ORIGINAL name so a rename replaces the right array slot). */
    submitForm: async (): Promise<boolean> => {
      const built = ruleFromDraft(state.draft);
      if ("error" in built) { set({ formError: built.error }); return false; }
      const dupe = state.rules.some((r) => r.name === built.name && r.name !== state.editing);
      if (dupe) { set({ formError: `a rule named "${built.name}" already exists` }); return false; }
      const next = state.editing
        ? state.rules.map((r) => (r.name === state.editing ? built : r))
        : [...state.rules, built];
      const ok = await writeRules(next);
      if (ok) set({ formOpen: false, formError: null });
      return ok;
    },

    /** space — flip enabled on the selected rule. */
    toggleSelected: (): Promise<void> => {
      const r = state.rules[state.selected];
      if (!r) return Promise.resolve();
      return writeRules(state.rules.map((x) => (x.name === r.name ? { ...x, enabled: !x.enabled } : x))).then(() => {});
    },

    /** t — notify.test {rule}: fires a sample through the rule's own channel
     * immediately (bypasses the throttle window — core's NotifyEvaluator.test). */
    testSelected: async (): Promise<void> => {
      const r = state.rules[state.selected];
      if (!r) return;
      try {
        await request("notify.test", { rule: r.name });
      } catch (err) {
        fail(err);
      }
    },

    /** d — opens the ⚠ ConfirmCard gate (F15 destructive-action convention). */
    requestDelete: (): void => {
      const r = state.rules[state.selected];
      if (r) set({ confirmDelete: r.name });
    },

    confirmDelete: (): Promise<void> => {
      const name = state.confirmDelete;
      if (!name) return Promise.resolve();
      set({ confirmDelete: null });
      return writeRules(state.rules.filter((r) => r.name !== name)).then(() => {});
    },

    cancelDelete: (): void => set({ confirmDelete: null }),
  };
}

let cardSingleton: NotifyCommands | null = null;
export function getNotifyCommands(store: UiStore, request: RequestFn): NotifyCommands {
  if (!cardSingleton) cardSingleton = createNotifyCommands(store, request);
  return cardSingleton;
}

// ---------------------------------------------------------------------------
// deep link application (App-level: an OS-notification click, or a future
// toast click) — navigates the store to the exact pending surface.
// ---------------------------------------------------------------------------

export function applyNotifyDeepLink(link: NotifyDeepLink, store: UiStore, request: RequestFn): void {
  if (!link) return;
  if (link.tab === "agents") {
    store.dispatch({ type: "selectAgent", agentId: link.agentId });
    store.dispatch({ type: "selectTab", tab: "agents" });
    return;
  }
  if (link.tab === "settings") {
    getSettingsCommands(store, request).setSection(link.section);
    store.dispatch({ type: "selectTab", tab: "settings" });
    return;
  }
  // "queues" — bring the failed job's row under the schedules-panel cursor
  // (QueuesScreen renders `selected={jobsFocused && i === jobCursor}`), then
  // switch to the tab. job.list is re-fetched so a click landing before the
  // panel has ever mounted still finds the row.
  const jobs = getJobsCommands(store, request);
  void jobs.loadJobs().then(() => {
    const idx = jobsLocal.getState().items.findIndex((j) => j.name === link.jobName);
    if (idx >= 0) jobsLocal.set({ cursor: idx, focused: true });
  });
  store.dispatch({ type: "selectTab", tab: "queues" });
}

// ---------------------------------------------------------------------------
// the app-wide bridge: a delivered `notify`/`notify_error` event → toast / OS
// notification. Mounted once (App.tsx's system-surfaces effect), independent
// of whether the rules card is open.
// ---------------------------------------------------------------------------

type NotifyPayload = { ruleId: string; kind: string; channel: NotifyRule["channel"]; agentId: string; count: number };

function notifyTitle(payload: NotifyPayload): string {
  const label = kindLabel(payload.kind);
  return payload.count > 1 ? `${label} (×${payload.count})` : label;
}

export function createNotifyBridge(store: UiStore, request: RequestFn) {
  return {
    onDaemonEvent: (kind: string, data: Record<string, unknown> | undefined): void => {
      if (kind === "notify") {
        const p = data as unknown as NotifyPayload;
        if (!p || typeof p.kind !== "string" || typeof p.agentId !== "string") return;
        const link = deepLinkFor(p.kind, p.agentId);
        if (p.channel === "os") {
          showOsNotification(notifyTitle(p), `rule "${p.ruleId}"`, () => applyNotifyDeepLink(link, store, request));
        } else if (p.channel === "toast") {
          store.dispatch({ type: "notice", message: notifyTitle(p) });
        }
        return;
      }
      if (kind === "notify_error") {
        const ruleId = typeof data?.["ruleId"] === "string" ? (data["ruleId"] as string) : "?";
        const channel = typeof data?.["channel"] === "string" ? (data["channel"] as string) : "?";
        const message = typeof data?.["message"] === "string" ? (data["message"] as string) : "delivery failed";
        store.dispatch({ type: "commandError", message: `notify: rule "${ruleId}" (${channel}) — ${message}` });
      }
    },
  };
}

export type NotifyBridge = ReturnType<typeof createNotifyBridge>;

let bridgeSingleton: NotifyBridge | null = null;
export function getNotifyBridge(store: UiStore, request: RequestFn): NotifyBridge {
  if (!bridgeSingleton) bridgeSingleton = createNotifyBridge(store, request);
  return bridgeSingleton;
}
