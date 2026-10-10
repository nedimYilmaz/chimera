import { useEffect, useMemo, useRef, useState } from "react";
import type { UiState } from "@chimera/ui-state";
import { buildSessionRolePatch } from "@chimera/ui-state";
import { estimateChimeraMcpToolSurface } from "@chimera/protocol/mcp-tools";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { fmtTokens } from "../state/selectors";
import {
  agentCommands,
  cycleValue,
  type SpawnInput,
} from "../state/commands.agents";
import { composerLocal } from "../state/commands.agents";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { PathPicker } from "./PathPicker";
import { isPathUnderRoot } from "../state/pathRefs";
import styles from "./SpawnCard.module.css";
import { nativeMcpPatch } from "../state/nativeMcpSettings";

// W4 build item 6 — the spawn-agent form (mock showSpawn, line 282-312;
// coverage B6 spawn row): OverlayCard center, width 680. ↑↓ fields, enter
// next/submit (validation: empty prompt/cwd → red header error + focus),
// tab cycles model (dynamic per-provider list, see below), engine
// (local ⇄ peers from state.peers) and isolation (none default per the
// CRITICAL worktree-stranding decision / worktree). Submits ONLY the filled
// fields (TUI SpawnForm port); the current ◇/◆ mode rides the spec
// (commands.agents.ts spawnAgent).

// SPAWN-FORM-SURFACE: provider + model are always-visible dropdowns (no
// "advanced" fold — SPAWN-PROVIDER-MODEL built the data/ProviderSelect but
// left both hidden behind a fold and a plain-text model input, which made
// them undiscoverable). Model is a <select> over the live per-provider model
// list with a "custom…" escape hatch (model ids churn faster than the
// catalog), toggled via modelCustom.

// SPAWN-FORM-ACCOUNTS: the account field (build item 1) is a <select> over
// accounts.list, not a provider <select> — a provider-level picker can only
// ever target ONE account per provider, but the top bar already shows
// multiple accounts per provider (main:claude · codex:codex, per-account
// autoOrder/failover in AccountRegistry), so it under-served the real
// question ("which account spawns this?"). Picking an account DERIVES its
// provider (row.provider) for the model list + spec.provider — no
// standalone provider control is exposed anymore. See AccountSelect below.
type AccountEntry = { name: string; provider: string; authType: string };

// SPAWN-PROVIDER-MODEL: the providers.list RPC's per-row shape (engine.ts),
// trimmed to the fields this form actually needs — kept local rather than
// imported from selectors.settings.ts (that module's ProviderCatalogRow
// carries Settings-only view state like tosNote/overridden this form has no
// use for, and importing it would couple two independently-evolving screens).
// `accounts` is what makes a provider actually spawnable: the daemon only
// registers a provider's backend when it has a configured account
// (daemon/main.ts + HOT-RELOAD-BACKENDS) — still used here to source the
// model catalog/defaultModel per provider id, keyed off the picked account's
// provider (or the display-only default when on "auto").
export type ProviderCatalogEntry = {
  id: string; label: string; defaultModel: string; models: readonly string[];
  accounts: readonly { name: string; authType: string }[];
};

// SPAWN-ROLE-OVERRIDES: `effort` and `instructions` sit at the END — they are role-tuning
// knobs, not part of the fast path to a spawn, and both are diffed against the picked role so
// leaving them alone still inherits.
// F41.UI (QA F41-3): the daemon hands back a per-component `reason` string, but the row needs a
// SHORT operator-facing clause keyed on the component's KIND. The previous single hardcoded
// sentence ("resolved inside the provider CLI") was true only for settings/plugins and plainly
// false for the other two kinds, so it told the operator the wrong thing about their own servers.
// Keys are the protocol's unpriced `kind` union (settings | plugins | spec-mcp | store-direct);
// the daemon's full `reason` stays available as the span's tooltip.
const UNPRICED_WHY: Record<string, string> = {
  settings: "loaded inside the provider CLI — chimera never sees that catalog",
  plugins: "loaded inside the provider CLI — chimera never sees that catalog",
  "spec-mcp": "this spawn's own MCP servers — forwarded to the CLI, never connected by chimera",
  "store-direct": "MCP-store servers this agent connects to itself — only priced once connected",
};
const unpricedWhy = (kind: string): string => UNPRICED_WHY[kind] ?? "not priced by chimera";

const FIELDS = ["prompt", "name", "cwd", "account", "profile", "autonomy", "model", "effort", "conductor", "session", "role", "deliverTo", "budget", "engine", "isolation", "runtime", "settings", "nativeMcps", "executionMode", "orchestration", "instructions"] as const;
type Field = (typeof FIELDS)[number] | "provider";
const QUICK_FIELDS: readonly Field[] = ["provider", "account", "model"];

export { preferredProviderModel as quickSpawnModel } from "../state/providerModels";
import { preferredProviderModel as quickSpawnModel } from "../state/providerModels";

const PLACEHOLDER: Partial<Record<Field, string>> = {
  name: "auto",
  profile: "acceptEdits",
  deliverTo: "main",
  budget: "$ 0.00",
  // ROLES-TAB S6 fallback: only shown when role.list is unreachable (older
  // daemon) and the field degrades to free text — see the roleListOk effect.
  role: "aws / review / triage / blank",
};

// ROLES-UNIFY §6.5: the sparse "what did the operator actually change" bag that ends up
// riding through agent.spawn's existing `spec` param and gets stamped as
// `sessionRoleOverrides` by engine.ts (`sessionRoleOverrides = rawSpec`, core S2 — already
// landed, not this file's to change). Reuses S4's `buildSessionRolePatch` verbatim (same
// non-`.partial()` sparse technique, ui-state/src/roles.ts) rather than a second diff
// implementation — the trick is calling it with `next` as the FULLY MERGED effective spec
// (`{...role, ...submitted}`), not just the sparse `submitted` bag on its own: comparing
// `role` against a bare sparse object would flag every role field the operator's form
// never touches (instructions, mcpServers, …) as a false "changed to undefined" override,
// exactly the "inherited turns into pinned" hazard this slice exists to avoid. Merging
// `submitted` over `role` first means an untouched field's `next[key]` always equals
// `role[key]`, so it correctly drops out of the patch.
export function computeRoleSpecOverrides(
  role: Record<string, unknown>,
  submitted: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...buildSessionRolePatch(role, { ...role, ...submitted }),
    // loadSettings is an AgentSpec convenience field, not a RoleSpec field.
    ...(submitted.loadSettings !== undefined && submitted.loadSettings !== role.loadSettings
      ? { loadSettings: submitted.loadSettings } : {}),
    ...(submitted.strictMcpConfig !== undefined && (role.providerOptions as Record<string, unknown> | undefined)?.strictMcpConfig !== undefined
      ? { strictMcpConfig: submitted.strictMcpConfig } : {}),
  };
}

export function SpawnCard({ onClose, quick = false }: { onClose: () => void; quick?: boolean }) {
  const commands = agentCommands(appStore, rpcCall);
  const peers = useStore((s: UiState) => s.peers);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [modelCustom, setModelCustom] = useState(false);
  const [quickProvider, setQuickProvider] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelProvider, setModelProvider] = useState("");
  // SPAWN-ROLE-OVERRIDES: the role-override panel is collapsed by default (see its row below).
  const [roleOverridesOpen, setRoleOverridesOpen] = useState(false);
  const [values, setValues] = useState<Record<Field, string>>({
    provider: "", prompt: "", name: "", cwd: "", account: "", profile: "", autonomy: "ask", model: "", effort: "", budget: "",
    // SPAWN-ROLE-OVERRIDES: prefilled from the picked role (see the effect below) precisely so
    // the operator can SEE what they are overriding — safe because computeRoleSpecOverrides
    // diffs it back out when it is left untouched.
    instructions: "",
    conductor: "no", session: "no",
    // ROLES-TAB S6: prefilled by RolesScreen's "spawn session with this
    // role" (composerLocal.spawnPrefillRole), consumed once here.
    role: composerLocal.getState().spawnPrefillRole ?? "",
    deliverTo: "", engine: "local", isolation: "none", runtime: "sdk",
    // SPAWN-SETTING-SOURCES: "" = auto (defer to the resolved project's own toggle, or the
    // picked role's own value — see the settings chip row below), "on"/"off" = explicit.
    settings: "", nativeMcps: "", executionMode: "",
    // CROSS-PROVIDER-MCP-STORE: "" = auto (defer to the picked role's own orchestration.allow,
    // or the schema default false with no role — see the orchestration chip row below),
    // "on"/"off" = explicit spec.orchestration.allow.
    orchestration: "",
  });
  // ROLES-TAB S6 / ROLES-UNIFY §6.5: role.list-fed selection — mirrors commands.roles.ts's
  // loadRoles tryPhase2 idiom (§6): an unknown-method error means an older daemon, so the
  // field degrades to free text instead of an empty/broken picker. `null` = not yet
  // resolved (renders as free text until resolved, same as unavailable, to avoid a flash
  // of an empty select). role.list now returns the WHOLE unified library (§5) — full
  // resolved `RoleSpec` rows, not just names — kept in full here (not projected to names
  // immediately) so submit() can diff the picked role's resolved defaults against what was
  // actually typed (computeRoleSpecOverrides above).
  const [roleSpecs, setRoleSpecs] = useState<ReadonlyArray<Record<string, unknown>> | null>(null);
  useEffect(() => {
    let alive = true;
    rpcCall<Array<Record<string, unknown>>>("role.list", {}).then((rows) => {
      if (alive && Array.isArray(rows)) setRoleSpecs(rows.filter((r) => typeof r["name"] === "string"));
    }).catch(() => {
      if (alive) setRoleSpecs(null);
    });
    return () => { alive = false; };
  }, []);
  const roleOptions = useMemo(() => roleSpecs?.map((r) => r["name"] as string) ?? null, [roleSpecs]);

  // SPAWN-ROLE-OVERRIDES: when a role is picked, prefill the two OVERRIDE-ONLY fields from its
  // resolved defaults — you cannot tweak a prompt you cannot see, and "which effort does this
  // role actually use?" is the first question an operator has. Deliberately limited to these
  // two: prefilling the whole form would turn every inherited field into a visible value the
  // operator might not realise they now own. Safe even so, because computeRoleSpecOverrides
  // diffs the submitted bag against this same role — a prefilled value left untouched equals
  // the role's own default and drops straight back out of the override patch.
  const pickedRoleName = values.role.trim();
  useEffect(() => {
    const picked = pickedRoleName ? roleSpecs?.find((r) => r["name"] === pickedRoleName) : undefined;
    setValues((v) => ({
      ...v,
      effort: typeof picked?.["effort"] === "string" ? (picked["effort"] as string) : "",
      instructions: typeof picked?.["instructions"] === "string" ? (picked["instructions"] as string) : "",
    }));
  }, [pickedRoleName, roleSpecs]);
  // ROLES-UNIFY §6.5: the picker default-filters to un-dotted (global library) names —
  // team-qualified `<team>.<key>` entries exist because S2's migration created one per
  // pre-existing team role slot (§3.2); they're not meant to be the everyday session-spawn
  // choice and would clutter the list (a team with 6+ roles migrates to 6+ dotted names).
  // The toggle reveals them for the deliberate "spawn a session using a team's role" case.
  const [showAdvancedRoles, setShowAdvancedRoles] = useState(false);
  const visibleRoleOptions = useMemo(() => {
    if (!roleOptions) return null;
    const base = showAdvancedRoles ? roleOptions : roleOptions.filter((n) => !n.includes("."));
    // A qualified name already picked (prefill, or toggled on then off) stays visible even
    // with the fold collapsed — never silently yank the current selection off the list.
    if (values.role && !base.includes(values.role) && roleOptions.includes(values.role)) return [...base, values.role];
    return base;
  }, [roleOptions, showAdvancedRoles, values.role]);
  // ROLE-FOLD-DEAD-CONTROL: is there anything behind the fold at all? (see the toggle's own comment)
  const hasFoldableRoles = useMemo(() => (roleOptions ?? []).some((n) => n.includes(".")), [roleOptions]);
  const inputRefs = useRef(new Map<Field, HTMLInputElement | HTMLSelectElement>());

  // SPAWN-PROVIDER-MODEL: the provider catalog (providers.list) + the CURRENT
  // provider's model list (catalog fallback immediately, overwritten by a live
  // providers.models probe when one succeeds — see the effect below).
  const [catalog, setCatalog] = useState<readonly ProviderCatalogEntry[]>([]);
  const [modelOptions, setModelOptions] = useState<readonly string[]>([]);
  const [modelSource, setModelSource] = useState<"catalog" | "live" | null>(null);
  // SDK-MODEL-LISTS: id -> displayName, from a live probe's modelDetails (Codex CLI's/Claude
  // SDK's own catalog carries friendly names like "GPT-5.6-Sol" alongside the wire id) — the
  // <select>'s value/spec.model still always stay the raw id; this only swaps the label text.
  const [modelLabels, setModelLabels] = useState<Readonly<Record<string, string>>>({});
  // SPAWN-FORM-ACCOUNTS: accounts.list rows — the account dropdown's actual
  // option list (multiple rows can share one provider).
  const [accounts, setAccounts] = useState<readonly AccountEntry[]>([]);

  const fields: readonly Field[] = quick ? QUICK_FIELDS : FIELDS;
  const active = fields[Math.min(fieldIndex, fields.length - 1)]!;

  // ROLES-TAB S6: consume the one-shot prefill so a later plain spawn (mod+n)
  // doesn't inherit a stale role from a previous "spawn with this role" click.
  useEffect(() => {
    if (composerLocal.getState().spawnPrefillRole !== null) composerLocal.set({ spawnPrefillRole: null });
  }, []);

  // cwd default — the composer's own default (seam → Tauri homeDir → "~").
  useEffect(() => {
    void commands.defaultCwd().then((cwd) => {
      setValues((v) => (v.cwd === "" ? { ...v, cwd } : v));
    });
  }, [commands]);

  // Provider catalog — loaded once, still needed for the model list/defaultModel
  // lookups keyed off whichever provider the picked account (or the "auto"
  // fallback) resolves to.
  useEffect(() => {
    let alive = true;
    rpcCall<ProviderCatalogEntry[]>("providers.list", {}).then((rows) => {
      if (alive && Array.isArray(rows)) setCatalog(rows);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // SPAWN-FORM-ACCOUNTS: accounts.list — loaded once. This IS the account
  // dropdown's option list; unlike the old provider dropdown there's no
  // "configured only" filter needed since every row here is by definition a
  // configured account.
  useEffect(() => {
    let alive = true;
    rpcCall<AccountEntry[]>("accounts.list", {}).then((rows) => {
      if (alive && Array.isArray(rows)) setAccounts(rows);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // SPAWN-SETTING-SOURCES: project.list — loaded once, just the fields the "settings" chip's
  // "auto" preview needs (name/path/loadProjectSettings). Kept local rather than reusing
  // pathRefs.ts's loadProjectRoots cache — that cache deliberately trims rows to {name, path}
  // for the file-link feature and has no loadProjectSettings field.
  const [projects, setProjects] = useState<readonly { name: string; path: string; loadProjectSettings: boolean }[]>([]);
  useEffect(() => {
    let alive = true;
    rpcCall<Array<Record<string, unknown>>>("project.list", {}).then((rows) => {
      if (!alive || !Array.isArray(rows)) return;
      setProjects(rows.map((r) => ({
        name: String(r["name"] ?? ""), path: String(r["path"] ?? ""),
        loadProjectSettings: r["loadProjectSettings"] !== false,
      })));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  // Longest (most specific) matching registered project root wins, mirroring
  // supervisor.ts's own projectFor resolution (core's isPathUnder, reimplemented
  // client-side here as isPathUnderRoot — see pathRefs.ts).
  const matchedProject = useMemo(() => {
    const cwd = values.cwd.trim();
    if (!cwd) return null;
    const hits = projects.filter((p) => p.path && isPathUnderRoot(cwd, p.path));
    hits.sort((a, b) => b.path.length - a.path.length);
    return hits[0] ?? null;
  }, [projects, values.cwd]);
  const autoLoadsSettings = matchedProject?.loadProjectSettings ?? false;

  // CROSS-PROVIDER-MCP-STORE: the "auto" chip's live preview — mirrors autoLoadsSettings above,
  // but resolves from the picked role's own orchestration.allow (roleSpecs, already loaded for
  // the role <select>) rather than a project match; no role picked ⇒ the schema default, false.
  const pickedRoleForPreview = useMemo(
    () => (values.role.trim() ? roleSpecs?.find((r) => r["name"] === values.role.trim()) : undefined),
    [roleSpecs, values.role],
  );
  const autoOrchestrationAllow = (pickedRoleForPreview?.["orchestration"] as { allow?: unknown } | undefined)?.allow === true;

  // F41 / TOOL-SURFACE-MEASURE: the local half is a pure function of the three controls above
  // (frozen-at-spawn — never recomputed against a running agent), so it's a useMemo, not state.
  const effectiveOrchestration = values.orchestration === "on" ? true : values.orchestration === "off" ? false : autoOrchestrationAllow;
  const surface = useMemo(
    () => (effectiveOrchestration
      ? estimateChimeraMcpToolSurface({ autonomy: values.autonomy === "full" ? "full" : "ask", conductor: values.conductor === "yes" })
      : null),
    [effectiveOrchestration, values.autonomy, values.conductor],
  );
  // Daemon-side half: unpriced components + the observational "measured" median. Debounced so
  // typing in cwd/prompt doesn't fire an RPC per keystroke; a failed call just leaves the row
  // showing the local `surface` figure only — never an error state on an informational row.
  const [toolSurfaceRpc, setToolSurfaceRpc] = useState<{
    unpriced: Array<{ source: string; kind: string; count: number; reason: string }>;
    measured: { medianCacheWriteTokens: number; minTokens: number; maxTokens: number; n: number; servers: string[] } | null;
  } | null>(null);
  // F41.UI: "not yet asked" and "asked, daemon could not answer" used to render identically
  // (both `null`), so the row silently looked the same while loading as when unavailable. This
  // flips true on the FIRST settled call and never back, so a refetch (typing in cwd) keeps the
  // previous answer on screen instead of flashing "checking…" on every keystroke.
  const [toolSurfaceProbed, setToolSurfaceProbed] = useState(false);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      rpcCall<{
        unpriced: Array<{ source: string; kind: string; count: number; reason: string }>;
        measured: { medianCacheWriteTokens: number; minTokens: number; maxTokens: number; n: number; servers: string[] } | null;
      }>("agent.estimateToolSurface", {
        orchestration: effectiveOrchestration,
        autonomy: values.autonomy === "full" ? "full" : "ask",
        conductor: values.conductor === "yes",
        // F41.QA-FIX (F1): "auto" settings can't be resolved here — only the daemon knows
        // whether cwd matches a project with loadProjectSettings on — so hand over cwd/role
        // and let agent.estimateToolSurface resolve settingSources/pluginCount/mcpServers
        // the same way supervisor.spawn would for this exact spec.
        cwd: values.cwd.trim() ? values.cwd.trim() : undefined,
        role: values.role.trim() ? values.role.trim() : undefined,
      }).then((r) => {
        // Defensive: a version-skewed daemon (or an unmodeled RPC stub in tests) can resolve
        // a shape lacking unpriced/measured — never let a malformed response crash this
        // informational row, just treat it the same as "not yet loaded".
        if (alive) { setToolSurfaceRpc(r && Array.isArray(r.unpriced) ? r : null); setToolSurfaceProbed(true); }
      }).catch(() => {
        if (alive) { setToolSurfaceRpc(null); setToolSurfaceProbed(true); }
      });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [effectiveOrchestration, values.autonomy, values.conductor, values.settings, values.cwd]);

  // SCOPE NETLEŞTİRME (carried over from the provider dropdown): still used
  // below to pick the DISPLAY-only default provider (claude, else the first
  // configured provider) for the "auto" account case — model lookups key off
  // `catalog` by id regardless of whether that id came from a picked account
  // or this fallback.
  const connectedCatalog = useMemo(() => catalog.filter((c) => c.accounts.length > 0), [catalog]);

  const defaultProviderId = useMemo(
    () => connectedCatalog.find((c) => c.id === "claude")?.id ?? connectedCatalog[0]?.id ?? "",
    [connectedCatalog],
  );

  // SPAWN-FORM-ACCOUNTS: the picked account row ("auto" ⇒ undefined) — the
  // single source of truth the account select, the model list, and submit()
  // all derive the effective provider from.
  const selectedAccount = useMemo(
    () => accounts.find((a) => a.name === values.account.trim()),
    [accounts, values.account],
  );
  const effectiveProvider = quick ? (quickProvider || defaultProviderId) : selectedAccount?.provider || defaultProviderId;
  const quickAccounts = accounts.filter((account) => account.provider === effectiveProvider);
  const quickAccount = quickAccounts.find((account) => account.name === values.account)?.name ?? quickAccounts[0]?.name ?? "";
  const modelAccount = quick ? quickAccount : values.account;
  const quickModels = modelProvider === effectiveProvider ? modelOptions : (catalog.find((entry) => entry.id === effectiveProvider)?.models ?? []);

  // Dynamic per-provider model list (build item 2): the catalog fallback
  // applies immediately on a provider change (no flicker to empty), then a
  // live providers.models probe overwrites it when the daemon can reach a
  // usable account's key — a stale response from a provider/account the user
  // has since changed away from is dropped via the `seq` token. Keyed off
  // `effectiveProvider` (not the raw field) so the model list is populated
  // even before the user has touched the provider field at all.
  const modelFetchSeq = useRef(0);
  // SPAWN-FORM-ACCOUNTS: the previously effective provider, so a provider
  // switch (auto→account, or account→another account on a different
  // provider) can detect and reset a now-stale model pick — e.g. picking
  // codex then switching to a claude account left "gpt-5.1-codex" stuck as a
  // "custom" model under claude, since AccountSelect's onChange only stamps
  // a defaultModel onto an ALREADY-BLANK field. null on the very first run
  // so mount never fires a spurious reset.
  const prevProviderRef = useRef<string | null>(null);
  useEffect(() => {
    if (!effectiveProvider) { setModelsLoading(false); setModelOptions([]); setModelSource(null); setModelLabels({}); return; }
    const entry = catalog.find((c) => c.id === effectiveProvider);
    const fallbackModels = entry ? (entry.models.length ? entry.models : [entry.defaultModel]) : [];
    setModelsLoading(true);
    setModelProvider(effectiveProvider);
    setModelOptions(fallbackModels);
    setModelSource(entry ? "catalog" : null);
    setModelLabels({});

    if (prevProviderRef.current !== null && prevProviderRef.current !== effectiveProvider) {
      setValues((v) => (fallbackModels.includes(v.model.trim()) ? v : { ...v, model: "" }));
      setModelCustom(false);
    }
    prevProviderRef.current = effectiveProvider;

    const seq = ++modelFetchSeq.current;
    const account = modelAccount.trim();
    rpcCall<{
      models: string[]; source: "catalog" | "live" | "cache";
      modelDetails?: Array<{ value: string; displayName?: string; description?: string }>;
    }>("providers.models", {
      provider: effectiveProvider, ...(account ? { account } : {}),
    }).then((res) => {
      if (modelFetchSeq.current !== seq || !Array.isArray(res?.models) || res.models.length === 0) return;
      setModelOptions(res.models);
      // "cache" is a list previously observed from the provider's own CLI, not the static
      // catalog — it deserves the same badge as a fresh probe.
      setModelSource(res.source === "catalog" ? "catalog" : "live");
      setModelLabels(Object.fromEntries(
        (res.modelDetails ?? [])
          .filter((m) => m.displayName && m.displayName !== m.value)
          .map((m) => [m.value, m.displayName as string]),
      ));
    }).catch(() => {}).finally(() => {
      if (modelFetchSeq.current === seq) setModelsLoading(false);
    });
    return () => { modelFetchSeq.current++; };
  }, [effectiveProvider, modelAccount, catalog]);

  // focus follows the active field
  useEffect(() => {
    inputRefs.current.get(active)?.focus();
  }, [active, fields]);

  const set = (field: Field) => (v: string): void => {
    setValues((s) => ({ ...s, [field]: v,
      ...(field === "nativeMcps" && v === "on" ? { settings: "on" } : {}),
      ...(field === "settings" && v !== "on" && s.nativeMcps === "on" ? { nativeMcps: "" } : {}),
    }));
    if (error) setError(null);
  };

  const engineOptions = useMemo(() => ["local", ...peers.map((p) => p.engineId)], [peers]);

  const cycleField = (field: Field, reverse: boolean): void => {
    if (field === "model") set("model")(cycleValue(modelOptions, values.model.trim(), reverse));
    else if (field === "engine") set("engine")(cycleValue(engineOptions, values.engine.trim() || "local", reverse));
    else if (field === "conductor") set("conductor")(cycleValue(["no", "yes"], values.conductor, reverse));
    else if (field === "session") set("session")(cycleValue(["no", "yes"], values.session, reverse));
    else if (field === "autonomy") set("autonomy")(cycleValue(["ask", "full"], values.autonomy.trim() || "ask", reverse));
    else if (field === "isolation") set("isolation")(cycleValue(["none", "worktree"], values.isolation.trim() || "none", reverse));
    // TERMINAL-RUNTIME: cycled like isolation — the two together are "where does this run".
    else if (field === "runtime") set("runtime")(cycleValue(["sdk", "terminal"], values.runtime.trim() || "sdk", reverse));
    else if (field === "settings") set("settings")(cycleValue(["", "on", "off"], values.settings, reverse));
    else if (field === "executionMode" && effectiveProvider === "claude" && values.runtime !== "terminal") set("executionMode")(cycleValue(["", "auto", "execute", "plan"], values.executionMode, reverse));
    else if (field === "nativeMcps" && effectiveProvider === "claude" && values.runtime !== "terminal") set("nativeMcps")(cycleValue(["", "on", "off"], values.nativeMcps, reverse));
    else if (field === "orchestration") set("orchestration")(cycleValue(["", "on", "off"], values.orchestration, reverse));
  };

  // TUI SpawnForm.next() port: enter advances; on the last field, validate +
  // submit only the FILLED fields.
  const next = (): void => {
    if (fieldIndex < fields.length - 1) { setFieldIndex(fieldIndex + 1); return; }
    submit();
  };

  const submit = (): void => {
    if (quick) {
      if (submittingRef.current || modelsLoading || !effectiveProvider || !quickAccount || !displayModel.trim()) return;
      submittingRef.current = true;
      setSubmitting(true);
      void commands.spawnDefault({ provider: effectiveProvider, account: quickAccount, model: displayModel.trim() })
        .finally(() => { submittingRef.current = false; setSubmitting(false); onClose(); });
      return;
    }
    if (!values.prompt.trim()) { setFieldIndex(fields.indexOf("prompt")); setError("prompt is required"); return; }
    if (!values.cwd.trim()) { setFieldIndex(fields.indexOf("cwd")); setError("cwd is required"); return; }
    setError(null);
    const b = Number(values.budget.replace(/[$\s]/g, ""));
    const engine = values.engine.trim();
    // ROLES-UNIFY §6.5: every RoleSpec-named field the operator may have filled in — the
    // full submitted bag, unfiltered. `isolation` is deliberately NOT here: it rides
    // unconditionally below (see that field's own comment) since commands.agents.ts's
    // `input.isolation ?? "none"` fallback would silently override an omitted-as-inherited
    // value back to "none" instead of the role's own default, corrupting the actual spawn
    // — omitting it is only safe for the fields below that stay purely conditional
    // (no non-empty fallback) all the way through commands.agents.ts's spawnAgent().
    const roleFields: Record<string, unknown> = {
      ...(values.name.trim() ? { displayLabel: values.name.trim() } : {}),
      ...(values.account.trim() ? { account: values.account.trim() } : {}),
      ...(values.profile.trim() ? { permissionProfile: values.profile.trim() } : {}),
      // AGENT-AUTONOMY: mirrors conductor/session's own "only submit the non-default value"
      // convention — "ask" (the default) never rides through, even if explicitly reselected.
      ...(values.autonomy === "full" ? { autonomy: "full" } : {}),
      ...(values.conductor === "yes" ? { conductor: true } : {}),
      ...(values.session === "yes" ? { session: true } : {}),
      // SPAWN-FORM-ACCOUNTS: derived from the picked account row, not a
      // standalone field — "auto" (selectedAccount undefined) sends neither
      // account nor provider, leaving the daemon's own failover to resolve it.
      ...(selectedAccount ? { provider: selectedAccount.provider } : {}),
      ...(values.model.trim() ? { model: values.model.trim() } : {}),
      ...(values.effort.trim() ? { effort: values.effort.trim() } : {}),
      ...(values.instructions.trim() ? { instructions: values.instructions } : {}),
      ...(values.deliverTo.trim() ? { deliverTo: values.deliverTo.trim() } : {}),
      ...(Number.isFinite(b) && b > 0 ? { maxBudgetUsd: b } : {}),
      // SPAWN-SETTING-SOURCES: "auto" (values.settings === "") stays OUT of roleFields
      // entirely, same "only submit the non-default value" convention as autonomy/conductor/
      // session above — the daemon then defers to the picked role's own loadSettings, or (no
      // role / role leaves it unset too) this spawn's resolved project's own toggle.
      ...(values.settings === "on" ? { loadSettings: true } : {}),
      ...(values.settings === "off" ? { loadSettings: false } : {}),
      ...(effectiveProvider === "claude" && values.runtime !== "terminal" && values.executionMode ? { executionMode: values.executionMode } : {}),
      ...(effectiveProvider === "claude" && values.runtime !== "terminal" && values.nativeMcps
        ? nativeMcpPatch(values.nativeMcps === "on") : {}),
      // CROSS-PROVIDER-MCP-STORE: same "auto stays out of roleFields entirely" convention —
      // the daemon then defers to the picked role's own orchestration.allow, or the schema
      // default (false) with no role.
      ...(values.orchestration === "on" ? { orchestration: true } : {}),
      ...(values.orchestration === "off" ? { orchestration: false } : {}),
    };
    // ROLES-UNIFY §6.5: diff against the picked role's resolved defaults (computeRoleSpecOverrides
    // above) so a value that merely matches the role's own default never rides through as a
    // pinned override — no role picked (or an unresolved/unknown role name) leaves `roleFields`
    // untouched, byte-identical to pre-S6 behavior (engine.ts: "sp.role absent ⇒ spec passes
    // through completely untouched").
    const pickedRole = values.role.trim() ? roleSpecs?.find((r) => r["name"] === values.role.trim()) : undefined;
    const overrides = pickedRole ? computeRoleSpecOverrides(pickedRole, roleFields) : roleFields;
    // ROLE-PERMISSION-REQUEST-STOMPED: spawnAgent's own "on.permissionRequest" fallback used
    // to stomp a picked role's own value whenever the profile field was left blank (no
    // dedicated UI control for on.permissionRequest exists, so it was never part of the
    // roleFields/overrides diff above). Read the role's declared value straight off
    // `pickedRole` here — same gate as permissionProfile's own override check just above:
    // an explicit profile override (present in `overrides`) means the operator already chose
    // to diverge from the role, so on.permissionRequest defers to spawnAgent's own
    // profile-derived heuristic instead of the role in that case.
    const roleOn = pickedRole ? (pickedRole["on"] as { permissionRequest?: unknown } | undefined) : undefined;
    const roleOnPermissionRequest = typeof roleOn?.permissionRequest === "string" ? roleOn.permissionRequest : undefined;
    // PERM-READONLY-FALSE-PROMPTS: a picked role's OWN permissionProfile default counts as
    // "resolved full" exactly like an explicit override does — otherwise a role declaring
    // `permissionProfile: full` alongside its own `on.permissionRequest: tui` silently
    // defeated full's "no approval prompts" promise (PERMISSION_PROFILE_DESCRIPTION)
    // whenever the operator left the profile field blank to inherit the role's default.
    // "full" always wins over ANY role-declared on.permissionRequest below.
    const roleDefaultProfile = typeof pickedRole?.["permissionProfile"] === "string"
      ? pickedRole["permissionProfile"] as string : undefined;
    const resolvedProfile = (overrides["permissionProfile"] as string | undefined) ?? roleDefaultProfile;
    const input: SpawnInput = {
      prompt: values.prompt.trim(),
      cwd: values.cwd.trim(),
      ...(overrides["displayLabel"] !== undefined ? { displayLabel: overrides["displayLabel"] as string } : {}),
      ...(overrides["account"] !== undefined ? { account: overrides["account"] as string } : {}),
      ...(overrides["permissionProfile"] !== undefined ? { permissionProfile: overrides["permissionProfile"] as string } : {}),
      // An explicitly chosen full profile remains consent even if role diffing
      // drops it because it equals the role default. Merely inheriting is not.
      ...(values.profile.trim() === "full" ? { acknowledgeCodexFullAccessRisk: true } : {}),
      ...(resolvedProfile === "full"
        ? { permissionRequest: "auto" }
        : overrides["permissionProfile"] === undefined && roleOnPermissionRequest ? { permissionRequest: roleOnPermissionRequest } : {}),
      ...(overrides["autonomy"] !== undefined ? { autonomy: overrides["autonomy"] as string } : {}),
      ...(overrides["conductor"] !== undefined ? { conductor: true } : {}),
      ...(overrides["session"] !== undefined ? { session: true } : {}),
      // isolation always rides along, un-diffed — see roleFields' own comment.
      ...(values.isolation.trim() ? { isolation: values.isolation.trim() } : {}),
      // TERMINAL-RUNTIME: only sent when it is NOT the default. "sdk" is the schema default, and
      // sending it explicitly would make every spawn record carry a field nobody chose.
      ...(values.runtime.trim() === "terminal" ? { runtime: "terminal" } : {}),
      ...(overrides["provider"] !== undefined ? { provider: overrides["provider"] as string } : {}),
      ...(overrides["model"] !== undefined ? { model: overrides["model"] as string } : {}),
      ...(overrides["effort"] !== undefined ? { effort: overrides["effort"] as string } : {}),
      ...(overrides["instructions"] !== undefined ? { instructions: overrides["instructions"] as string } : {}),
      ...(overrides["deliverTo"] !== undefined ? { deliverTo: overrides["deliverTo"] as string } : {}),
      ...(overrides["maxBudgetUsd"] !== undefined ? { maxBudgetUsd: overrides["maxBudgetUsd"] as number } : {}),
      ...(values.role.trim() ? { role: values.role.trim() } : {}),
      ...(engine && engine !== "local" ? { engine } : {}),
      ...(overrides["loadSettings"] !== undefined ? { loadSettings: overrides["loadSettings"] as boolean } : {}),
      ...(overrides["executionMode"] ? { executionMode: overrides["executionMode"] as "plan" | "execute" | "auto" } : {}),
      ...(overrides["strictMcpConfig"] !== undefined ? { strictMcpConfig: overrides["strictMcpConfig"] as boolean } : {}),
      ...(overrides["orchestration"] !== undefined ? { orchestration: overrides["orchestration"] as boolean } : {}),
    };
    void commands.spawnAgent(input);
    onClose();
  };

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    // Quick mode uses native Tab/arrow navigation, including the footer buttons.
    if (quick) {
      if (ev.key === "Enter" && (ev.target as HTMLElement).tagName === "INPUT" && !ev.altKey && !ev.metaKey && !ev.ctrlKey) {
        ev.preventDefault(); submit();
      }
      return;
    }
    // A focused <select> (account/model) owns ↑↓ for its own option list
    // (native combobox behavior) — don't hijack them into field navigation.
    const onSelect = (ev.target as HTMLElement).tagName === "SELECT";
    if (!onSelect && ev.key === "ArrowUp") { ev.preventDefault(); setFieldIndex((i) => Math.max(0, i - 1)); return; }
    if (!onSelect && ev.key === "ArrowDown") { ev.preventDefault(); setFieldIndex((i) => Math.min(fields.length - 1, i + 1)); return; }
    if (ev.key === "Enter" && !ev.altKey && !ev.metaKey && !ev.ctrlKey) { ev.preventDefault(); next(); return; }
    if (ev.key === "Tab") { ev.preventDefault(); cycleField(active, ev.shiftKey); return; }
  };

  const registerRef = (field: Field) => (el: HTMLInputElement | HTMLSelectElement | null): void => {
    if (el) inputRefs.current.set(field, el);
    else inputRefs.current.delete(field);
  };

  const TextInput = (field: Field, hint?: string, listId?: string): React.ReactElement => (
    <span className={[styles.inputBox, active === field ? styles.inputActive : ""].filter(Boolean).join(" ")}>
      <input
        ref={registerRef(field)}
        className={styles.input}
        value={values[field]}
        placeholder={PLACEHOLDER[field] ?? ""}
        onChange={(e) => set(field)(e.target.value)}
        onFocus={() => setFieldIndex(fields.indexOf(field))}
        spellCheck={false}
        data-spawn-field={field}
        {...(listId ? { list: listId } : {})}
      />
      {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
    </span>
  );

  // SPAWN-FORM-ACCOUNTS (build item 1): account is a <select> over
  // accounts.list — not free text, and not a provider picker: the top bar
  // already shows multiple accounts per provider (main:claude · codex:codex),
  // and a provider-only field could never target the SECOND account on one
  // provider. The select shows `values.account` directly with an explicit
  // "auto (failover order)" option at value "" — an untouched selection
  // stays OUT of the spec (only an actual onChange writes it; see submit()),
  // making the daemon's own autoOrder/failover behavior visible instead of
  // implicit. Picking a row also stamps its provider's defaultModel onto a
  // still-blank model field, since GenericAgentBackend (every non-agentic-sdk
  // provider) has no fallback of its own and needs SOME model string to
  // spawn at all.
  const AccountSelect = (): React.ReactElement => (
    <span className={[styles.inputBox, active === "account" ? styles.inputActive : ""].filter(Boolean).join(" ")}>
      <select
        ref={registerRef("account")}
        className={styles.input}
        value={quick ? quickAccount : values.account}
        aria-label="Account"
        onChange={(e) => {
          const name = e.target.value;
          if (quick && name === quickAccount) return;
          const row = accounts.find((a) => a.name === name);
          const entry = row ? catalog.find((c) => c.id === row.provider) : undefined;
          setValues((v) => ({ ...v, account: name, model: quick ? "" : v.model.trim() ? v.model : (entry?.defaultModel ?? v.model) }));
          if (quick) { setModelsLoading(true); setModelCustom(false); }
        }}
        onFocus={() => setFieldIndex(fields.indexOf("account"))}
        data-spawn-field="account"
      >
        {!quick ? <option value="">auto (failover order)</option> : null}
        {quick && !quickAccounts.length ? <option value="">no configured account</option> : null}
        {(quick ? quickAccounts : accounts).map((a) => <option key={a.name} value={a.name}>{a.name} · {a.provider}</option>)}
      </select>
    </span>
  );

  // build item 2: model is a <select> over the current provider's model list
  // (modelOptions — catalog fallback, overwritten by the live probe), with a
  // "custom…" escape hatch since model ids churn faster than the catalog.
  // `displayModel` mirrors the provider select's effectiveProvider pattern:
  // an untouched model field shows the provider's defaultModel as the
  // SELECTED option without writing it into values.model/the spec.
  const fallbackModel = catalog.find((c) => c.id === effectiveProvider)?.defaultModel || "";
  const displayModel = quick && modelCustom ? values.model.trim()
    : values.model.trim() || (quick ? quickSpawnModel(effectiveProvider, quickModels, fallbackModel) : fallbackModel);
  const ModelSelect = (): React.ReactElement => {
    if (modelCustom) {
      return (
        <span className={[styles.inputBox, active === "model" ? styles.inputActive : ""].filter(Boolean).join(" ")}>
          <input
            ref={registerRef("model")}
            className={styles.input}
            value={values.model}
            placeholder={PLACEHOLDER.model ?? ""}
            onChange={(e) => set("model")(e.target.value)}
            onFocus={() => setFieldIndex(fields.indexOf("model"))}
            spellCheck={false}
            aria-label="Model"
            data-spawn-field="model"
            list="spawn-model-options"
          />
          <datalist id="spawn-model-options">
            {modelOptions.map((m) => <option key={m} value={m} />)}
          </datalist>
          <button type="button" className={styles.modelModeBtn} onClick={() => setModelCustom(false)} data-spawn-model-list>
            ▾ list
          </button>
        </span>
      );
    }
    const known = modelOptions.includes(displayModel);
    return (
      <span className={[styles.inputBox, active === "model" ? styles.inputActive : ""].filter(Boolean).join(" ")}>
        <select
          ref={registerRef("model")}
          className={styles.input}
          value={known ? displayModel : ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__custom__") { setModelCustom(true); return; }
            set("model")(v);
          }}
          onFocus={() => setFieldIndex(fields.indexOf("model"))}
          aria-label="Model"
          data-spawn-field="model"
        >
          {!known ? <option value="">{displayModel ? `${displayModel} (custom)` : "loading…"}</option> : null}
          {modelOptions.map((m) => <option key={m} value={m}>{modelLabels[m] ?? m}</option>)}
          <option value="__custom__">custom…</option>
        </select>
        {modelSource ? <span className={styles.fieldHint}>{modelSource}</span> : null}
      </span>
    );
  };

  // cwd: the same inputBox chrome as TextInput, but the field itself is a
  // PathPicker (text input + native browse button) instead of a bare input.
  const CwdInput = (): React.ReactElement => (
    <span className={[styles.inputBox, active === "cwd" ? styles.inputActive : ""].filter(Boolean).join(" ")}>
      <PathPicker
        ref={registerRef("cwd")}
        className={styles.input}
        value={values.cwd}
        onChange={set("cwd")}
        mode="directory"
        onFocus={() => setFieldIndex(fields.indexOf("cwd"))}
        dataAttr="spawn-cwd"
      />
    </span>
  );

  // ROLES-TAB S6 §6 / ROLES-UNIFY §6.5: role is a <select> over role.list — empty option =
  // no role. roleOptions === null (unresolved or an older daemon without role.list)
  // degrades to the pre-S6 free-text input rather than showing a picker that cannot work.
  // The option list is `visibleRoleOptions` (dotted/team-qualified names folded away by
  // default) rather than the raw `roleOptions`; the "advanced" toggle sits beside the
  // select to reach them.
  const RoleSelect = (): React.ReactElement => (
    <span className={[styles.inputBox, active === "role" ? styles.inputActive : ""].filter(Boolean).join(" ")}>
      <select
        ref={registerRef("role")}
        className={styles.input}
        value={values.role}
        onChange={(e) => set("role")(e.target.value)}
        onFocus={() => setFieldIndex(fields.indexOf("role"))}
        data-spawn-field="role"
      >
        <option value="">no role</option>
        {roleOptions?.includes(values.role) === false && values.role
          ? <option value={values.role}>{values.role} (unknown)</option>
          : null}
        {(visibleRoleOptions ?? []).map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      {/* ROLE-FOLD-DEAD-CONTROL: this toggle exists to reveal DOTTED, team-qualified role names
          (chimera-dev.worker) that are folded away by default. When the library contains none —
          which is the normal state after a consolidation pass replaces them with flat names — it
          has nothing to reveal and toggling it visibly does nothing, which reads as a broken
          control. Render it only when there is actually something behind the fold. */}
      {hasFoldableRoles ? (
      <button
        type="button"
        className={styles.modelModeBtn}
        onClick={() => setShowAdvancedRoles((v) => !v)}
        data-spawn-role-advanced={showAdvancedRoles ? "on" : "off"}
      >
        {showAdvancedRoles ? "▾ simple" : "▸ advanced"}
      </button>
      ) : null}
    </span>
  );

  const Label = (field: Field, text: string): React.ReactElement => (
    <span className={[styles.label, active === field ? styles.labelActive : ""].filter(Boolean).join(" ")}>{text}</span>
  );

  if (quick) {
    return (
      <OverlayCard width={520} align="center" onClose={onClose}>
        <div onKeyDown={onKeyDown} data-spawn-card data-quick-spawn>
          <OverlayCardHeader title="spawn session" hint="tab fields · esc cancel" />
          <div className={styles.body}>
            <div className={styles.row}>
              {Label("provider", "provider")}
              <span className={styles.inputBox}>
                <select className={styles.input} ref={registerRef("provider")} aria-label="Provider"
                  data-spawn-field="provider" value={effectiveProvider}
                  onFocus={() => setFieldIndex(0)}
                  onChange={(event) => {
                    if (event.target.value === effectiveProvider) return;
                    setQuickProvider(event.target.value);
                    setValues((value) => ({ ...value, account: "", model: "" }));
                    setModelsLoading(true);
                    setModelCustom(false);
                  }}>
                  {!connectedCatalog.length ? <option value="">no configured provider</option> : null}
                  {connectedCatalog.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                </select>
              </span>
            </div>
            <div className={styles.row}>{Label("account", "account")}{AccountSelect()}</div>
            <div className={styles.row}>{Label("model", "model")}{ModelSelect()}</div>
          </div>
          <div className={styles.footer}>
            <button type="button" className={styles.submitChip} onClick={submit} data-spawn-submit
              disabled={submitting || modelsLoading || !quickAccount || !displayModel.trim()}>
              {submitting ? "spawning…" : modelsLoading ? "loading models…" : "spawn"}
            </button>
            <button type="button" className={styles.cancelChip} onClick={onClose}>cancel</button>
          </div>
        </div>
      </OverlayCard>
    );
  }

  return (
    <OverlayCard width={680} align="center" onClose={onClose}>
      <div onKeyDown={onKeyDown} data-spawn-card>
        <OverlayCardHeader
          title="spawn agent"
          meta={error ? <span className={styles.error}>{error}</span> : undefined}
          hint="↑↓ fields · enter next · esc cancel"
        />
        <div className={styles.body}>
          <div className={styles.row}>{Label("prompt", "prompt")}{TextInput("prompt")}</div>
          <div className={styles.row}>{Label("name", "name")}{TextInput("name", "optional · auto-generated when empty")}</div>
          <div className={styles.row}>{Label("cwd", "cwd")}{CwdInput()}</div>
          <div className={styles.pair}>
            <div className={styles.row}>{Label("account", "account")}{AccountSelect()}</div>
            <div className={styles.row}>{Label("profile", "profile")}{TextInput("profile")}</div>
          </div>
          <p className={styles.isoNote}>Choosing full or spawning in bypass mode authorizes Codex without its sandbox or Chimera tool-policy guards. Use acceptEdits or readOnly for sandboxed access.</p>
          <div className={styles.row}>
            {Label("autonomy", "autonomy")}
            <span className={styles.isolationRow}>
              <button
                type="button"
                className={values.autonomy === "ask" ? styles.isoChipActive : styles.isoChip}
                onClick={() => set("autonomy")("ask")}
                data-spawn-autonomy="ask"
              >
                ask
              </button>
              <button
                type="button"
                className={values.autonomy === "full" ? styles.isoChipActive : styles.isoChip}
                onClick={() => set("autonomy")("full")}
                data-spawn-autonomy="full"
              >
                full
              </button>
              <span className={styles.isoNote}>
                {values.autonomy === "full"
                  ? "no ask_human/ask_agent/ask_team, no questions · permission profile is separate"
                  : "may ask a human or a peer when it needs a decision"}
              </span>
            </span>
          </div>
          <div className={styles.row}>{Label("model", "model")}{ModelSelect()}</div>
          <div className={styles.pair}>
            <div className={styles.row}>
              {Label("conductor", "conductor")}
              <span className={styles.isolationRow}>
                <button
                  type="button"
                  className={values.conductor === "no" ? styles.isoChipActive : styles.isoChip}
                  onClick={() => set("conductor")("no")}
                  data-spawn-conductor="no"
                >
                  no
                </button>
                <button
                  type="button"
                  className={values.conductor === "yes" ? styles.isoChipActive : styles.isoChip}
                  onClick={() => set("conductor")("yes")}
                  data-spawn-conductor="yes"
                >
                  yes
                </button>
              </span>
            </div>
            <div className={styles.row}>{Label("deliverTo", "deliver to")}{TextInput("deliverTo")}</div>
          </div>
          {/* FORM-GRID: `role` gets a full-width row of its own rather than a third cell in the
              pair above. It is a compound control — a select PLUS the simple/advanced toggle —
              and `.inputBox`'s `min-width: 0` lets the select shrink to nothing when the cell is
              narrow, which is exactly what happened when the pair became a two-column grid: the
              select collapsed to zero width and only the toggle was left visible. It also leaves
              the pair above at two cells, so it aligns with the account/profile pair. */}
          <div className={styles.row}>{Label("role", "role")}{roleOptions !== null ? RoleSelect() : TextInput("role")}</div>
          {/* SPAWN-ROLE-OVERRIDES: deliberately OUTSIDE the .pair above — that container is a
              single flex LINE (conductor | role | deliver to), so a row placed inside it becomes
              a fourth column and collides with its neighbours instead of stacking. These are
              full-width rows of their own, collapsed until a role is picked and the operator
              opens them: the fast path to a spawn stays short, but "same role, different effort
              / one extra prompt line" no longer means editing the shared library entry. Both
              fields are prefilled from the role and diffed back out when untouched, so opening
              this and changing nothing pins nothing. */}
          {pickedRoleName ? (
            <div className={styles.row}>
              {Label("role", "overrides")}
              <span className={styles.inputBox}>
                <button
                  type="button"
                  className={styles.listButton}
                  onClick={() => setRoleOverridesOpen((o) => !o)}
                  data-role-overrides-toggle
                >
                  {roleOverridesOpen ? "▾ overrides" : "▸ overrides"}
                </button>
                <span className={styles.fieldHint}>{roleOverridesOpen ? `for this spawn only · "${pickedRoleName}" stays unchanged` : `adjust "${pickedRoleName}" for this spawn`}</span>
              </span>
            </div>
          ) : null}
          {pickedRoleName && roleOverridesOpen ? (
            <>
              <div className={styles.row}>{Label("effort", "effort")}{TextInput("effort", "inherits the role's effort")}</div>
              <div className={styles.row}>{Label("instructions", "role prompt")}{TextInput("instructions", "inherits the role's instructions")}</div>
            </>
          ) : null}
          <div className={styles.row}>
            {Label("session", "session")}
            <span className={styles.isolationRow}>
              <button
                type="button"
                className={values.session === "no" ? styles.isoChipActive : styles.isoChip}
                onClick={() => set("session")("no")}
                data-spawn-session="no"
              >
                no
              </button>
              <button
                type="button"
                className={values.session === "yes" ? styles.isoChipActive : styles.isoChip}
                onClick={() => set("session")("yes")}
                data-spawn-session="yes"
              >
                yes
              </button>
              <span className={styles.isoNote}>
                {values.session === "yes" ? "ad-hoc — buckets separately in the agent list" : "an ordinary worker"}
              </span>
            </span>
          </div>
          <div className={styles.row}>{Label("budget", "budget")}{TextInput("budget")}</div>
          <div className={styles.row}>
            {Label("engine", "engine")}
            {TextInput("engine", peers.length > 0
              ? `— tab: ${peers.map((p) => `⇅ ${p.engineId}`).join(" / ")} (remote spawn, account name resolved on the peer)`
              : "local")}
          </div>
          <div className={styles.row}>
            {Label("isolation", "isolation")}
            <span className={styles.isolationRow}>
              <button
                type="button"
                className={values.isolation === "none" ? styles.isoChipActive : styles.isoChip}
                onClick={() => set("isolation")("none")}
                data-spawn-isolation="none"
              >
                none
              </button>
              <button
                type="button"
                className={values.isolation === "worktree" ? styles.isoChipActive : styles.isoChip}
                onClick={() => set("isolation")("worktree")}
                data-spawn-isolation="worktree"
              >
                worktree
              </button>
              <span className={styles.isoNote}>
                {values.isolation === "worktree" ? "isolated checkout — its output does not reach main by itself" : "runs directly in the repo at cwd"}
              </span>
            </span>
          </div>
          {/* TERMINAL-RUNTIME: sits next to isolation because together they answer the same
              question — where this agent runs. The note states the real trade rather than
              advertising the feature: a terminal agent gains the CLI's interactive surface and
              loses the structured transcript. */}
          <div className={styles.row}>
            {Label("runtime", "runtime")}
            <span className={styles.isolationRow}>
              <button
                type="button"
                className={values.runtime !== "terminal" ? styles.isoChipActive : styles.isoChip}
                onClick={() => set("runtime")("sdk")}
                data-spawn-runtime="sdk"
              >
                sdk
              </button>
              <button
                type="button"
                className={values.runtime === "terminal" ? styles.isoChipActive : styles.isoChip}
                onClick={() => set("runtime")("terminal")}
                data-spawn-runtime="terminal"
              >
                terminal
              </button>
              <span className={styles.isoNote}>
                {values.runtime === "terminal"
                  ? "a real CLI you can attach to — no tool rows, no token meter, permissions answered there"
                  : "headless, with the full transcript and permission prompts here"}
              </span>
            </span>
          </div>
          {/* Settings inheritance remains independent of the native MCP filter. */}
          <div className={styles.row}>
            {Label("settings", "settings")}
            <span className={styles.isolationRow}>
              <button
                type="button"
                className={values.settings === "" ? styles.isoChipActive : styles.isoChip}
                onClick={() => set("settings")("")}
                data-spawn-settings="auto"
              >
                auto · {autoLoadsSettings ? "on (project default)" : "off"}
              </button>
              <button
                type="button"
                className={values.settings === "on" ? styles.isoChipActive : styles.isoChip}
                onClick={() => set("settings")("on")}
                data-spawn-settings="on"
              >
                on
              </button>
              <button
                type="button"
                className={values.settings === "off" ? styles.isoChipActive : styles.isoChip}
                onClick={() => set("settings")("off")}
                data-spawn-settings="off"
              >
                off
              </button>
              <span className={styles.isoNote}>
                {values.settings === "on" ? "loads the project's .claude/ skills, commands, CLAUDE.md and global ~/.claude skills"
                  : values.settings === "off" ? "no project or user settings — an isolated toolset"
                  : matchedProject ? `follows project "${matchedProject.name}"` : "no registered project matches cwd"}
              </span>
            </span>
          </div>
          <div className={styles.row}>
            <label className={styles.label} htmlFor="spawn-execution-mode">execution mode</label>
            <span className={styles.inputBox}>
              <select id="spawn-execution-mode" className={styles.input} ref={registerRef("executionMode")}
                data-spawn-field="executionMode" value={values.executionMode}
                onFocus={() => setFieldIndex(fields.indexOf("executionMode"))}
                onChange={e => set("executionMode")(e.target.value)}
                disabled={effectiveProvider !== "claude" || values.runtime === "terminal"}>
                <option value="">Role default</option><option value="auto">Auto</option><option value="execute">Execute</option><option value="plan">Plan</option>
              </select>
            </span>
          </div>
          <div className={`${styles.fieldHint} ${styles.wrapHint}`}>Claude SDK: Auto explicitly selects automatic permission review. Role default inherits the role’s selection. Plan uses native planning; Chimera permission restrictions still apply.</div>
          <div className={styles.row}>
            <label className={styles.label} htmlFor="spawn-native-mcps">native MCPs</label>
            <span className={styles.inputBox}>
              <select id="spawn-native-mcps" aria-describedby="spawn-native-mcps-hint" className={styles.input}
                ref={registerRef("nativeMcps")} data-spawn-field="nativeMcps" value={values.nativeMcps}
                onFocus={() => setFieldIndex(fields.indexOf("nativeMcps"))}
                onChange={e => set("nativeMcps")(e.target.value)}
                disabled={effectiveProvider !== "claude" || values.runtime === "terminal"}>
                <option value="">Auto · inherit</option><option value="on">On</option><option value="off">Off</option>
              </select>
            </span>
          </div>
          <div id="spawn-native-mcps-hint" className={`${styles.fieldHint} ${styles.wrapHint}`}>
            {effectiveProvider === "claude" && values.runtime !== "terminal"
              ? "On loads installed Claude MCP plugins and user/project settings. Chimera tools are controlled separately below."
              : "Native MCP configuration is managed by this provider's CLI."}
          </div>
          {/* CROSS-PROVIDER-MCP-STORE: on = grant this agent chimera's own MCP server (every
              chimera-native tool, incl. mcp_store_tools/mcp_store_call — reaches every shared
              MCP-store server, e.g. Slack, through the daemon's one connection) plus the ability
              to spawn/coordinate other agents. Previously reachable ONLY via a role template or
              a hand-written agent_spawn call — this chip is the first spawn-form control for it
              on any provider. off = no chimera tools at all (today's lean default). auto defers
              to the picked role's own orchestration.allow, shown live below. */}
          <div className={styles.row}>
            {Label("orchestration", "chimera tools")}
            <span className={styles.isolationRow}>
              <button
                type="button"
                className={values.orchestration === "" ? styles.isoChipActive : styles.isoChip}
                onClick={() => set("orchestration")("")}
                data-spawn-orchestration="auto"
              >
                auto
              </button>
              <button
                type="button"
                className={values.orchestration === "on" ? styles.isoChipActive : styles.isoChip}
                onClick={() => set("orchestration")("on")}
                data-spawn-orchestration="on"
              >
                on
              </button>
              <button
                type="button"
                className={values.orchestration === "off" ? styles.isoChipActive : styles.isoChip}
                onClick={() => set("orchestration")("off")}
                data-spawn-orchestration="off"
              >
                off
              </button>
              <span className={styles.isoNote}>
                {values.orchestration === "on" ? "chimera MCP + mcp_store — can spawn and reach shared MCP servers"
                  : values.orchestration === "off" ? "no chimera MCP — cannot spawn or reach shared MCP servers"
                  : autoOrchestrationAllow ? "follows the picked role (on)" : "off unless a role says otherwise"}
              </span>
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>tool surface</span>
            <span className={styles.surfaceLines}>
              {surface
                ? <span>
                    {`chimera MCP ~${fmtTokens(surface.approxTokens)} tok · ${surface.toolCount} tools`}
                  </span>
                : <span>no chimera MCP grant — 0 tok</span>}
              {/* F41.UI: the per-server breakdown behind that one number, live as the server set
                  changes (conductor on/off flips the second row in or out). "chimera-" is stripped
                  because the label above already says chimera. */}
              {surface
                ? <span>{surface.bySource.map((r) => `${r.source.replace(/^chimera-/, "")} ${r.toolCount} tools ~${fmtTokens(r.approxTokens)} tok`).join(" · ")}</span>
                : null}
              <span>written once at spawn, then re-read every turn as cached input for this agent's life</span>
              {/* F41.UI: one line PER unpriced component, each with its own kind-correct
                  explanation (see UNPRICED_WHY) — a single joined sentence could only ever be
                  right about one kind. The daemon's own `reason` rides along as the tooltip. */}
              {toolSurfaceRpc
                ? toolSurfaceRpc.unpriced.map((u) => (
                    <span key={`${u.kind}:${u.source}`} title={u.reason}>
                      {`not counted: ${u.source} (${u.count}) — ${unpricedWhy(u.kind)}`}
                    </span>
                  ))
                : null}
              {/* The ` over <servers>` clause is guarded the same way AgentDetailPanel.tsx:207
                  guards its own: records written before toolSurfaceServers existed still join the
                  measured cohort, so an empty server union is the common case, not an edge one. */}
              {toolSurfaceRpc
                ? (toolSurfaceRpc.measured
                    ? <span>
                        {`measured: ${toolSurfaceRpc.measured.n} comparable past spawns wrote ${fmtTokens(toolSurfaceRpc.measured.medianCacheWriteTokens)} tok median (min ${fmtTokens(toolSurfaceRpc.measured.minTokens)} / max ${fmtTokens(toolSurfaceRpc.measured.maxTokens)})${toolSurfaceRpc.measured.servers.length > 0 ? ` over ${toolSurfaceRpc.measured.servers.join(", ")}` : ""} — an observational contrast over recent records, not a controlled estimate`}
                      </span>
                    : <span>measured: fewer than 3 comparable past spawns — no figure</span>)
                : toolSurfaceProbed ? null : <span>measured: checking recent spawns…</span>}
            </span>
          </div>
        </div>
        <div className={styles.footer}>
          <button type="button" className={styles.submitChip} onClick={submit} data-spawn-submit>
            <span className={styles.submitKey}>enter</span>
            <span className={styles.chipLabel}> spawn</span>
          </button>
          <button type="button" className={styles.cancelChip} onClick={onClose}>esc cancel</button>
        </div>
      </div>
    </OverlayCard>
  );
}
