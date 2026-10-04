import { useEffect, useMemo, useSyncExternalStore } from "react";
import { telemetryStore } from "../state/telemetryStore";
import { rates, sparkPath } from "../state/selectors.telemetry";
import { fmtCost, fmtTokens } from "../state/selectors";
import styles from "./FleetTelemetry.module.css";

// FLEET-TELEMETRY: the live panel above the fleet table. Every number comes from
// selectors.telemetry (pure, unit-tested); this file only draws.
//
// No chart library on purpose. The repo's own discipline is self-contained assets, and a
// dependency that ships its own canvas/DOM layer to draw six sparklines would cost more than it
// saves — inline SVG paths take the theme's colour tokens directly and animate with plain CSS.

// Kept beside the panel that shows it: the one place an operator asks "default meaning what?".
const DEFAULT_EFFORT_HINT =
  "no effort set on the spawn — the provider picks. Claude's SDK documents its default as 'high' "
  + "(xhigh and max sit above it); other providers choose their own. Set one per agent in ⚙ settings.";

const SPARK_W = 220;
const SPARK_H = 34;

function Spark({ values, tone }: { values: readonly number[]; tone: "accent" | "warn" }) {
  const d = useMemo(() => sparkPath(values, SPARK_W, SPARK_H), [values]);
  // A single sample is a dot, not a line — draw nothing until there is a shape to draw rather
  // than a misleading flat baseline that looks like "measured zero".
  if (values.length < 2) return <div className={styles.sparkEmpty}>gathering…</div>;
  return (
    <svg className={styles.spark} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden>
      <path className={tone === "warn" ? styles.sparkLineWarn : styles.sparkLine} d={d} />
      <path className={tone === "warn" ? styles.sparkFillWarn : styles.sparkFill} d={`${d} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z`} />
    </svg>
  );
}

function Ring({ pct }: { pct: number }) {
  const r = 26, c = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(1, pct)) * c;
  return (
    <svg className={styles.ring} viewBox="0 0 64 64" aria-hidden>
      <circle className={styles.ringTrack} cx="32" cy="32" r={r} />
      {/* The dash offset is what animates: a CSS transition on it makes the ring sweep to its new
          value instead of jumping, which is what makes a 1Hz sample read as continuous. */}
      <circle
        className={styles.ringValue}
        cx="32" cy="32" r={r}
        strokeDasharray={`${filled} ${c}`}
        transform="rotate(-90 32 32)"
      />
    </svg>
  );
}

function Bars({ rows, total, unit }: { rows: ReadonlyArray<{ key: string; agents: number; tokens: number }>; total: number; unit?: "call" }) {
  if (rows.length === 0) return <div className={styles.empty}>{unit === "call" ? "nothing used yet" : "no live agents"}</div>;
  return (
    <div className={styles.bars}>
      {rows.slice(0, 6).map((r) => (
        <div key={r.key} className={styles.barRow}>
          {/* "default" is a real bucket — chimera set no effort, so the PROVIDER chose. Naming the
              level it chose belongs here rather than in the operator's head: the bar otherwise
              raises the question "default meaning what?" and answers nothing. Only claude's
              default is documented (its SDK states 'high' on EffortLevel itself), so the title
              says whose default it is instead of asserting one number across providers. */}
          <span className={styles.barLabel} title={r.key === "default" ? DEFAULT_EFFORT_HINT : r.key}>{r.key}</span>
          <span className={styles.barTrack}>
            <span className={styles.barFill} style={{ width: `${total > 0 ? (r.tokens / total) * 100 : 0}%` }} />
          </span>
          <span className={styles.barMeta}>
            {unit === "call" ? `${r.tokens} · ${r.agents} agent${r.agents === 1 ? "" : "s"}` : `${r.agents}× · ${fmtTokens(r.tokens)}`}
          </span>
        </div>
      ))}
    </div>
  );
}

export function FleetTelemetry({ onOpen }: { onOpen: (id: string) => void }) {
  // Refcounted start/stop: sampling runs only while this panel is mounted, so a session that
  // never opens the dashboard pays nothing for it.
  useEffect(() => telemetryStore.start(), []);
  const { now: t, series } = useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getState, telemetryStore.getState);
  const r = useMemo(() => rates(series), [series]);
  const tokenRate = useMemo(() => r.map((x) => x.tokensPerSec), [r]);
  const costRate = useMemo(() => r.map((x) => x.costPerSec), [r]);
  const liveRate = useMemo(() => series.map((s) => s.busy), [series]);
  const aggregateContextKnown = t.ctxLimit > 0;
  const ctxPct = aggregateContextKnown ? (t.ctxUsed / t.ctxLimit) * 100 : 0;
  const perSec = tokenRate.length > 0 ? tokenRate[tokenRate.length - 1]! : 0;

  return (
    <div className={styles.wrap} data-fleet-telemetry>
      <div className={styles.headline}>
        <div className={styles.ringCell}>
          <Ring pct={t.busyRatio} />
          <div className={styles.ringText}>
            <span className={styles.ringPct}>{Math.round(t.busyRatio * 100)}%</span>
            <span className={styles.ringCaption}>busy</span>
          </div>
        </div>
        <div className={styles.statGrid}>
          <Stat label="live" value={String(t.live)} sub={`${t.busy} working · ${t.paused} paused`} />
          <Stat label="queued" value={String(t.queued)} sub="pending + blocked" />
          <Stat label="tokens/s" value={fmtTokens(Math.round(perSec))} sub={`${fmtTokens(t.tokens)} total`} pulse={perSec > 0} />
          <Stat label="spend" value={fmtCost(t.costUsd)} sub="live agents" />
          <Stat label="context" value={aggregateContextKnown ? `${Math.round(ctxPct)}%` : "unknown"} sub={aggregateContextKnown ? `${fmtTokens(t.ctxUsed)} / ${fmtTokens(t.ctxLimit)}` : "waiting for context usage"} />
          {/* COMPACTION-VISIBLE-STATE: answers "is compaction actually happening?" without
              scrolling a transcript to find the banner. */}
          <Stat
            label="compactions"
            value={String(t.compactions)}
            sub={t.compactions === 0 ? "none yet" : `${t.compactedAgents} agent${t.compactedAgents === 1 ? "" : "s"}`}
          />
        </div>
      </div>

      <div className={styles.row}>
        <Panel title="token rate" meta={`${fmtTokens(Math.round(perSec))}/s`}>
          <Spark values={tokenRate} tone="accent" />
        </Panel>
        <Panel title="spend rate" meta={`${fmtCost(costRate[costRate.length - 1] ?? 0)}/s`}>
          <Spark values={costRate} tone="warn" />
        </Panel>
        <Panel title="agents working" meta={`${t.busy} of ${t.live}`}>
          <Spark values={liveRate} tone="accent" />
        </Panel>
      </div>

      <div className={styles.row}>
        <Panel title="context pressure" meta="closest to compaction first">
          {t.ctxPressure.length === 0 ? <div className={styles.empty}>no live agents</div> : (
            <div className={styles.bars}>
              {t.ctxPressure.map((a) => (
                <div key={a.agentId} className={styles.barRow} onClick={() => onOpen(a.agentId)} role="button" tabIndex={0}
                     onKeyDown={(e) => { if (e.key === "Enter") onOpen(a.agentId); }}>
                  <span className={styles.barLabel} title={a.label}>{a.label}</span>
                  <span className={styles.barTrack}>
                    <span className={a.known && a.pct >= 80 ? styles.barFillWarn : styles.barFill} style={{ width: `${a.known ? a.pct : 0}%` }} />
                  </span>
                  <span className={styles.barMeta}>
                    {a.known ? `${Math.round(a.pct)}%` : "unknown"}{a.compactions > 0 ? ` · ⇥${a.compactions}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="models" meta={`${t.byModel.length} in play`}>
          <Bars rows={t.byModel} total={t.tokens} />
        </Panel>
        <Panel title="reasoning effort" meta={`${t.byEffort.length} level${t.byEffort.length === 1 ? "" : "s"}`}>
          <Bars rows={t.byEffort} total={t.tokens} />
        </Panel>
      </div>

      {/* TOOL-METRICS: what the fleet is actually DOING. The bars here are proportional to CALL
          counts, not tokens, so they get their own total rather than borrowing the token one. */}
      <div className={styles.row}>
        <Panel title="tools used" meta={`${t.toolCalls} call${t.toolCalls === 1 ? "" : "s"}`}>
          <Bars rows={t.tools} total={t.toolCalls} unit="call" />
        </Panel>
        <Panel title="MCP servers" meta={t.mcpServers.length === 0 ? "none in use" : `${t.mcpCalls} call${t.mcpCalls === 1 ? "" : "s"}`}>
          <Bars rows={t.mcpServers} total={t.mcpCalls} unit="call" />
        </Panel>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, pulse }: { label: string; value: string; sub?: string; pulse?: boolean }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={pulse ? styles.statValuePulse : styles.statValue}>{value}</span>
      {sub ? <span className={styles.statSub}>{sub}</span> : null}
    </div>
  );
}

function Panel({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <section className={styles.panel}>
      <header className={styles.panelHead}>
        <span className={styles.panelTitle}>{title}</span>
        {meta ? <span className={styles.panelMeta}>{meta}</span> : null}
      </header>
      {children}
    </section>
  );
}
