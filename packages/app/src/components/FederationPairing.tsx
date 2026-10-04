import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { appStore } from "../state/store";
import { rpcCall, onDaemonEvent } from "../rpc/bridge";
import { writeClipboard } from "../state/copyOnSelect";
import { isEditableTarget } from "../keymap";
import { getFederationCommands } from "../state/commands.federation";
import { ConfirmCard } from "./ConfirmCard";
import { CONFIRMS } from "../copy";
import {
  blobPreview,
  derivePeerRows,
  deriveInviteRows,
  projectJoin,
  stepVisual,
  joinError,
  fmtExp,
  toggleGrantAccount,
  INVITE_TTL_CHOICES,
  type GrantForm,
  type InviteRow,
  type PeerRow,
} from "../state/selectors.federation";
import { FED_JOIN_STEPS } from "@chimera/protocol";
import styles from "./FederationPairing.module.css";

// W10 (F10 · coverage B15) — the federation pairing UI, mounted at the W9
// `data-federation-pairing-seam` in SettingsScreen's network section (mock
// ?screen=settings network, lines 935-946). Three blocks:
//   1. invite — TTL choice → g generate → the blob on one line + c copy; the
//      active invite list with r revoke. The RAW token lives ONLY in the copied
//      blob (never rendered separately, never logged — F10 secret discipline).
//   2. join — paste a chimera-pair:v1 blob → v join → the config→tunnel→
//      handshake→paired step indicator, the failing step's error inline.
//   3. peers — pending·paired·granted·partitioned rows + per-peer outbox; space
//      opens the {allowSpawn, accounts, maxConcurrent} grant menu.
// All decisions live in selectors.federation (pure, tested); this file is
// wiring + token-only markup. Keyboard + click parity via a section-scoped
// window listener (the SettingsScreen convention — registerActionHandler is for
// GLOBAL/overlay actions; this UI is only mounted while the network section is).

const cmds = getFederationCommands(appStore, rpcCall);

function copyWithToast(text: string): void {
  if (!text) return;
  void writeClipboard(text).then((ok) => {
    if (ok) appStore.dispatch({ type: "notice", message: `${text.length} characters copied to clipboard` });
  });
}

export function FederationPairing({ engineId }: { engineId: string | null }) {
  const state = useSyncExternalStore(cmds.subscribe, cmds.getState);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [ttlIndex, setTtlIndex] = useState(2); // default 24h (mock/daemon default)
  const [blob, setBlob] = useState("");
  const [selectedPeerKey, setSelectedPeerKey] = useState<string | null>(null);
  const [selectedInviteId, setSelectedInviteId] = useState<string | null>(null);
  const [grantOpenKey, setGrantOpenKey] = useState<string | null>(null);
  // REVOKE-CONFIRM: revoking an invite is destructive (the token becomes
  // permanently unusable) — gate it behind the same ConfirmCard the other
  // destructive actions (killAgent, deleteProject, ...) use, rather than
  // firing on a bare hotkey/click.
  const [confirmRevoke, setConfirmRevoke] = useState<InviteRow | null>(null);
  const joinRef = useRef<HTMLTextAreaElement | null>(null);

  // load once on mount; keep fresh off daemon events (peer_paired / config /
  // network_changed) — the pairing UI self-refreshes like the rest of settings.
  useEffect(() => {
    void cmds.loadAll();
    const off = onDaemonEvent((e) => cmds.onDaemonEvent(e.kind));
    return off;
  }, []);

  // countdown/exp labels age while the section sits open.
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const inviteRows = deriveInviteRows(state.invites, nowTick);
  const peerRows = derivePeerRows(state.configPeers, state.peers, state.invites, nowTick);
  const preview = blobPreview(blob, nowTick);
  const steps = projectJoin(state.joinResult, state.joining);
  const stepErr = joinError(steps);

  const generate = async (): Promise<void> => {
    const seconds = INVITE_TTL_CHOICES[ttlIndex]?.seconds;
    const created = await cmds.createInvite(seconds);
    if (created) copyWithToast(created); // copy-on-generate: the token transits once
  };

  const doJoin = async (): Promise<void> => {
    if (!blob.trim() || state.joining) return;
    const res = await cmds.join(blob);
    if (res && res.paired) setBlob(""); // clear the field only on a clean pairing
  };

  const revokeSelected = (): void => {
    const target = selectedInviteId && inviteRows.find((r) => r.id === selectedInviteId && r.revocable)
      ? inviteRows.find((r) => r.id === selectedInviteId)
      : inviteRows.find((r) => r.revocable);
    if (target) setConfirmRevoke(target);
  };

  const openGrant = (row: PeerRow): void => {
    if (!row.grantable) return;
    setSelectedPeerKey(row.key);
    setGrantOpenKey((k) => (k === row.key ? null : row.key));
  };

  // section-scoped hotkeys: g invite · v join · r revoke · space grant (mock
  // footer + per-row "space grant"). Skipped while an input owns the keys.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (isEditableTarget(ev.target)) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (k === "g") { ev.preventDefault(); void generate(); }
      else if (k === "v") { ev.preventDefault(); joinRef.current?.focus(); }
      else if (k === "r") { ev.preventDefault(); revokeSelected(); }
      else if (k === "x") { ev.preventDefault(); cmds.clearBlob(); }
      else if (ev.key === " ") {
        const row = peerRows.find((r) => r.key === selectedPeerKey);
        if (row?.grantable) { ev.preventDefault(); openGrant(row); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [peerRows, selectedPeerKey, ttlIndex, blob, state.joining, inviteRows, selectedInviteId]);

  const tone = (t: string): string =>
    t === "success" ? styles.ok : t === "warn" ? styles.warn : t === "danger" ? styles.danger : styles.muted;

  return (
    <div className={styles.card} data-federation-pairing>
      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>federation · pairing</span>
        <span className={styles.faint}>engine.id {engineId ?? "—"}</span>
        <span className={styles.spacer} />
        <span className={styles.faint}>g invite · v join · r revoke</span>
      </div>

      {/* ---- invite generation ---- */}
      <div className={styles.inviteRow}>
        <span className={styles.rowLabel}>invite</span>
        <div className={styles.ttlGroup} data-ttl-group>
          {INVITE_TTL_CHOICES.map((c, i) => (
            <button
              key={c.label}
              type="button"
              className={i === ttlIndex ? styles.ttlChipActive : styles.ttlChip}
              onClick={() => setTtlIndex(i)}
              data-ttl={c.label}
            >{c.label}</button>
          ))}
        </div>
        <button type="button" className={styles.ghostBtn} onClick={() => void generate()} data-invite-generate>g generate</button>
      </div>

      {state.lastBlob && (
        <>
          <div className={styles.blobRow} data-invite-blob>
            <span className={styles.rowLabel} />
            <span className={styles.blob} title="chimera-pair:v1 invite — carries the single-use token; copy it to the other engine">
              {state.lastBlob}
            </span>
            <button type="button" className={styles.linkBtn} onClick={() => copyWithToast(state.lastBlob!)} data-invite-copy>c copy</button>
            {/* W10 verify minor: the blob carries the raw single-use token — an
             * explicit dismiss bounds its on-screen window instead of leaving it
             * rendered until the next generate (cmds is a module singleton that
             * survives unmount, so navigation alone never clears it). */}
            <button type="button" className={styles.linkBtn} onClick={() => cmds.clearBlob()} data-invite-dismiss>x dismiss</button>
          </div>
          <div className={styles.hintRow}>
            <span className={styles.rowLabel} />
            <span className={styles.faint}>
              single use · exp {state.lastBlobExp ? fmtExp(state.lastBlobExp, nowTick) : "—"} · grants nothing — peer starts read-only
            </span>
          </div>
        </>
      )}

      {/* ---- active invite list (created / expiry / used + revoke) ---- */}
      {inviteRows.length > 0 && (
        <div className={styles.inviteList} data-invite-list>
          {inviteRows.map((r) => (
            <div
              key={r.id}
              className={r.id === selectedInviteId ? styles.inviteListRowSel : styles.inviteListRow}
              onClick={() => setSelectedInviteId(r.id)}
              data-invite-row={r.id}
            >
              <span className={styles.faint}>created {r.createdLabel}</span>
              <span className={styles.muted}>exp {r.expLabel}</span>
              <span className={tone(r.tone)}>{r.state}</span>
              <span className={styles.spacer} />
              {r.revocable && (
                <button type="button" className={styles.linkBtn} onClick={(e) => { e.stopPropagation(); setConfirmRevoke(r); }} data-invite-revoke={r.id}>r revoke</button>
              )}
            </div>
          ))}
        </div>
      )}

      {confirmRevoke && (
        <ConfirmCard
          title="⚠ revoke invite"
          meta={confirmRevoke.createdLabel}
          body={CONFIRMS.revokeInvite(confirmRevoke.createdLabel).body}
          note={CONFIRMS.revokeInvite(confirmRevoke.createdLabel).note}
          confirmLabel="confirm revoke"
          onConfirm={() => {
            const id = confirmRevoke.id;
            setConfirmRevoke(null);
            void cmds.revokeInvite(id);
          }}
          onClose={() => setConfirmRevoke(null)}
        />
      )}

      {/* ---- join ---- */}
      <div className={styles.joinRow}>
        <span className={styles.rowLabel}>join</span>
        <textarea
          ref={joinRef}
          className={styles.joinInput}
          value={blob}
          rows={1}
          placeholder="paste the chimera-pair:v1;… blob from the other side"
          spellCheck={false}
          onChange={(e) => { setBlob(e.target.value); cmds.clearJoin(); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void doJoin(); } }}
          data-join-input
        />
        <button
          type="button"
          className={styles.ghostBtn}
          disabled={!blob.trim() || state.joining || (preview.ok === false)}
          onClick={() => void doJoin()}
          data-join-submit
        >join</button>
      </div>

      {blob.trim() !== "" && (
        preview.ok
          ? <div className={styles.previewRow}>
              <span className={styles.rowLabel} />
              <span className={styles.faint}>
                {preview.engineId} · {preview.endpointLabel} · exp {preview.expLabel}
                {preview.expired && <span className={styles.danger}> · expired</span>}
              </span>
            </div>
          : <div className={styles.previewRow}>
              <span className={styles.rowLabel} />
              <span className={styles.danger} data-blob-error>{preview.error}</span>
            </div>
      )}

      {(state.joining || state.joinResult) && (
        <>
          <div className={styles.stepRow} data-join-steps>
            <span className={styles.rowLabel} />
            {steps.map((s, i) => {
              const v = stepVisual(s.status);
              return (
                <span key={s.step} className={styles.step}>
                  <span className={`${tone(v.tone)} ${v.comet ? styles.comet : ""}`} data-step={s.step} data-step-status={s.status}>
                    {s.step} {v.glyph}
                  </span>
                  {i < FED_JOIN_STEPS.length - 1 && <span className={styles.arrow}>→</span>}
                </span>
              );
            })}
          </div>
          {stepErr && (
            <div className={styles.stepRow}>
              <span className={styles.rowLabel} />
              <span className={styles.danger} data-join-error>{stepErr}</span>
            </div>
          )}
        </>
      )}

      {/* ---- peers table ---- */}
      <div className={styles.peersTable}>
        <div className={styles.peersHead}>
          <div className={styles.colEngine}>engine</div>
          <div className={styles.colState}>state</div>
          <div className={styles.colIp}>ip</div>
          <div className={styles.colGrants}>grants</div>
        </div>
        {peerRows.length === 0 ? (
          <div className={styles.emptyHint}>no peers yet — generate an invite for the other engine, or paste one here to join</div>
        ) : peerRows.map((row) => (
          <div key={row.key}>
            <div
              className={row.key === selectedPeerKey ? styles.peerRowSel : styles.peerRow}
              onClick={() => setSelectedPeerKey(row.key)}
              data-peer-row={row.engineId ?? row.key}
              data-peer-state={row.state}
            >
              <div className={styles.colEngine}>
                {row.remote ? <span className={styles.ok}>⇅</span> : null} <span className={row.remote ? styles.value : styles.muted}>{row.displayName}</span>
              </div>
              <div className={styles.colState}>
                <span className={tone(row.stateTone)}>{row.glyph}</span>
                <span className={styles.muted}> {row.stateLabel}</span>
                {row.outboxPending > 0 && <span className={styles.faint}> · {row.outboxPending} out</span>}
              </div>
              <div className={`${styles.colIp} ${row.ip ? styles.muted : styles.faint}`}>{row.ip ?? "—"}</div>
              <div className={`${styles.colGrants} ${styles.muted}`}>
                {row.grantsLabel}
                {row.grantable && (
                  <button type="button" className={styles.grantBtn} onClick={(e) => { e.stopPropagation(); openGrant(row); }} data-peer-grant={row.engineId}>
                    space grant
                  </button>
                )}
              </div>
            </div>
            {grantOpenKey === row.key && row.grantable && row.grant && (
              <GrantMenu
                engineId={row.engineId!}
                initial={row.grant}
                accountNames={state.accountNames}
                onClose={() => setGrantOpenKey(null)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// The per-row grant menu (space → fed.peer.grant). {allowSpawn, accounts (auto
// or a names multi-pick), maxConcurrent}. A LOCAL config write — the peer's own
// policy stays on the peer (B15). Seeded from the row's current grant.
function GrantMenu({
  engineId,
  initial,
  accountNames,
  onClose,
}: {
  engineId: string;
  initial: { allowSpawn: boolean; accounts: "auto" | string[]; maxConcurrent: number };
  accountNames: readonly string[];
  onClose: () => void;
}) {
  const [form, setForm] = useState<GrantForm>({
    allowSpawn: initial.allowSpawn,
    accounts: initial.accounts,
    maxConcurrent: initial.maxConcurrent,
  });
  const [busy, setBusy] = useState(false);
  const autoMode = form.accounts === "auto";
  const picked = new Set(form.accounts === "auto" ? [] : form.accounts);

  const submit = async (): Promise<void> => {
    setBusy(true);
    const ok = await cmds.grant(engineId, form);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <div
      className={styles.grantMenu}
      data-grant-menu={engineId}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
    >
      <div className={styles.grantRow}>
        <span className={styles.grantLabel}>allow spawn</span>
        <button
          type="button"
          className={form.allowSpawn ? styles.toggleOn : styles.toggleOff}
          onClick={() => setForm((f) => ({ ...f, allowSpawn: !f.allowSpawn }))}
          data-grant-allowspawn={String(form.allowSpawn)}
        >{form.allowSpawn ? "on" : "off"}</button>
      </div>
      <div className={styles.grantRow}>
        <span className={styles.grantLabel}>accounts</span>
        <button
          type="button"
          className={autoMode ? styles.toggleOn : styles.toggleOff}
          onClick={() => setForm((f) => ({ ...f, accounts: autoMode ? [] : "auto" }))}
          data-grant-auto={String(autoMode)}
        >auto</button>
        {!autoMode && accountNames.map((name) => (
          <button
            key={name}
            type="button"
            className={picked.has(name) ? styles.pickOn : styles.pickOff}
            onClick={() => setForm((f) => ({ ...f, accounts: toggleGrantAccount(f.accounts, name) }))}
            data-grant-account={name}
          >{name}</button>
        ))}
        {!autoMode && accountNames.length === 0 && <span className={styles.faint}>no accounts to grant</span>}
      </div>
      <div className={styles.grantRow}>
        <span className={styles.grantLabel}>max concurrent</span>
        <input
          className={styles.grantNum}
          type="number"
          min={1}
          value={form.maxConcurrent}
          onChange={(e) => setForm((f) => ({ ...f, maxConcurrent: Math.max(1, Math.floor(Number(e.target.value) || 1)) }))}
          data-grant-max
        />
      </div>
      <div className={styles.grantActions}>
        <button type="button" className={styles.primaryBtn} disabled={busy} onClick={() => void submit()} data-grant-save>grant</button>
        <button type="button" className={styles.ghostBtn} onClick={onClose}>esc cancel</button>
        <span className={styles.faint}>a local config write — the peer's own policy stays on the peer</span>
      </div>
    </div>
  );
}
