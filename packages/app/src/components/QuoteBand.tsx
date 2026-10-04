import type { AgentView } from "@chimera/ui-state";
import type { QuoteSlot } from "../state/commands.agents";
import { derivedState, displayName, shortId, stateVisual, toneVar } from "../state/selectors";
import styles from "./QuoteBand.module.css";

// F22 (W24) — the composer's quote band (mock showQuoting, line 720-726):
// "↳ quoting @name  result · "excerpt…"  drag an agent row here · q on a
// message  ×". Mirrors QueuedBar.tsx's shape (bar → chip → spacer → hint →
// close), one active slot at a time (Composer.tsx owns the state; this is a
// pure render of it).
export function QuoteBand({ quote, agent, onClear }: { quote: QuoteSlot; agent: AgentView | undefined; onClear: () => void }) {
  const name = agent ? displayName(agent) : shortId(quote.agentId);
  const dotStyle = agent ? { background: toneVar(stateVisual(derivedState(agent)).tone) } : undefined;
  return (
    <div className={styles.band} data-quote-band>
      <span className={styles.label}>↳ quoting</span>
      <span className={styles.chip}>
        <span className={styles.dot} style={dotStyle} />@{name}
      </span>
      <span className={styles.excerpt}>{quote.kind} · &quot;{quote.excerpt}&quot;</span>
      <span className={styles.spacer} />
      <span className={styles.hint}>drag an agent row here · q on a message</span>
      <button type="button" className={styles.close} title="clear quote" onClick={onClear}>
        ×
      </button>
    </div>
  );
}
