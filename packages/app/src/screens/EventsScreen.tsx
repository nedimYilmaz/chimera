import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChronicleSearchHit, ChronicleSearchResponse, ChronicleExportResponse, NormalizedEvent } from "@chimera/protocol";
import { qualifiedAgentId, type UiState } from "@chimera/ui-state";
import { registerActionHandler, runAction } from "../keymap";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { getCoordCommands } from "../state/commands.coord";
import { systemCommands, olderPageRequest, useSystemLocal, type Pin } from "../state/commands.system";
import { copiedNotice, installCopyOnSelect, writeClipboard } from "../state/copyOnSelect";
import { fmtClock, shortId } from "../state/selectors";
import { eventSummaryOverride, eventRowTone, isRemoteEvent, nextKindFilter, summarizeEventData } from "../state/selectors.coord";
import { chronicleLanes } from "../state/selectors.chronicle";
import { Panel, PanelFooter } from "../components/Panel";
import { OverlayOutlet } from "../components/OverlayOutlet";
import { SearchBox } from "../components/SearchBox";
import { errorText } from "../state/errorText";
import styles from "./EventsScreen.module.css";

// F05: how many older events one events.replay page pulls (mirrors the
// ReplayBar's window). A page is fetched when the user scrolls near the top.
// Also the initial-connect backfill's tail-seed page size (exported for tests).
export const OLDER_PAGE = 500;

/** The pin an events row targets: a task pin when the event carries a taskId
 * (the queue-row semantics), otherwise the row's agent (qualified when known,
 * so PinnedBar.agentPinView resolves live fields). */
function eventPinTarget(e: NormalizedEvent, agents: UiState["agents"]): Pin {
  const taskId = e.data["taskId"];
  if (typeof taskId === "string" && taskId.length > 0) return { type: "task", id: taskId };
  const key = qualifiedAgentId(e);
  return { type: "agent", id: agents[key] !== undefined ? key : e.agentId };
}

// W5 — the Events screen (mock s_events, coverage B10): one full-width table
// time/agent/kind/data over the live NormalizedEvent ring. Kind colors:
// permission_request --human, error --danger, result --info (others plain);
// data = top-level primitive k=v summary ≤60 chars; remote rows wear a ⇅
// prefix (engineId ≠ local); clicking a known agent id jumps to the Agents
// tab with it selected (the SAME selectTab+selectAgent path). Follow-tail
// unless scrolled (the transcript's hold pattern, re-applied — not the
// component); `f` cycles a kind filter over the kinds present.

const coord = getCoordCommands(appStore, rpcCall);

// SEARCH-STORM (see runSearch below): sized to what the operation actually costs — a whole-log
// scan measured in seconds, not the instant filter these numbers are usually chosen for.
const SEARCH_MIN_CHARS = 3;
const SEARCH_DEBOUNCE_MS = 500;

export function EventsScreen() {
  const events = useStore((s: UiState) => s.events);
  const agents = useStore((s: UiState) => s.agents);
  const connected = useStore((s: UiState) => s.connected);
  const pins = useSystemLocal((s) => s.pins);
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<ChronicleSearchHit[]>([]);
  const [searchNext, setSearchNext] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [retained, setRetained] = useState<{ firstSeq: number | null; lastSeq: number | null } | null>(null);
  // Selected row (by seq — stable across prepends/appends); null = follow the
  // newest row. `p` pins whatever this points at (F01 row-level pin).
  const [selSeq, setSelSeq] = useState<number | null>(null);

  // F05 jsonl paging: events older than the 5k live ring, fetched on demand
  // from events.replay and cached page-locally keyed by seq (NEVER mutating the
  // shared ui-state ring). A version counter re-renders on cache growth.
  const olderRef = useRef<Map<number, NormalizedEvent>>(new Map());
  const [olderVersion, setOlderVersion] = useState(0);
  const fetchingRef = useRef(false); // guards double-fetch while a page is in flight
  const exhaustedRef = useRef(false); // reached seq 1 (or the log has no more)
  const pendingScrollRef = useRef<{ prevH: number; prevTop: number } | null>(null);
  // Initial-connect backfill: true only while the very first tail fetch (fetchSeed,
  // below) is in flight over an otherwise-empty tab — drives the empty-state hint,
  // since (unlike fetchOlder's scroll-triggered fetches) nothing else re-renders
  // while a genuinely empty tab awaits its first page.
  const [seeding, setSeeding] = useState(false);

  // merged = cached-older (seq < the live ring's oldest) ++ the live ring.
  const merged = useMemo(() => {
    if (olderRef.current.size === 0) return events;
    const liveOldest = events.length > 0 ? events[0]!.seq : Number.POSITIVE_INFINITY;
    const older = [...olderRef.current.values()]
      .filter((e) => e.seq < liveOldest)
      .sort((a, b) => a.seq - b.seq);
    return older.length > 0 ? [...older, ...events] : events;
    // olderVersion drives re-derivation when the cache grows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, olderVersion]);

  // Filter by the `f` kind cycle AND the free-text search (matches kind, agent
  // id, and the row's data summary — "search everything in it").
  const shown = useMemo(() => {
    let list = kindFilter === null ? merged : merged.filter((e) => e.kind === kindFilter);
    return list;
  }, [merged, kindFilter]);

  // SEARCH-STORM: events.search scans the WHOLE log — measured at 3503 ms against this operator's
  // 575 MB of segments, and 26476 ms when the ten prefixes of a ten-character word are in flight
  // together, which is four seconds short of the bridge's own 30 s timeout. Typing therefore built
  // a backlog of multi-second scans whose replies landed out of order and overwrote each other:
  // results flickering between the query you typed and one you had already moved past. Reported as
  // the search box "going into a loop".
  //
  // Three things, each fixing a different half of it:
  //   * a request SEQUENCE, so a reply for a query that is no longer the current one is dropped
  //     rather than painted. This is the correctness half — without it a slower earlier search
  //     wins over a faster later one, whatever the debounce is.
  //   * a MINIMUM length, because "c" matches almost every event in the log and costs a full scan
  //     to say so.
  //   * a debounce sized to the operation. 180 ms suits a search that answers instantly; for one
  //     that takes seconds it just guarantees the backlog.
  const searchSeq = useRef(0);
  const runSearch = useCallback((cursor?: string): void => {
    const q = query.trim();
    if (q.length < SEARCH_MIN_CHARS) return;
    const seq = ++searchSeq.current;
    setSearching(true); setSearchError(null);
    void rpcCall<ChronicleSearchResponse>("events.search", { query: q, limit: 50, ...(cursor ? { cursor } : {}) })
      .then((response) => {
        if (seq !== searchSeq.current) return;   // a newer query has since been asked — this one is stale
        setSearchHits((old) => cursor ? [...old, ...response.hits] : response.hits);
        setSearchNext(response.nextCursor); setRetained(response.retained);
      })
      .catch((error: unknown) => { if (seq === searchSeq.current) setSearchError(errorText(error)); })
      .finally(() => { if (seq === searchSeq.current) setSearching(false); });
  }, [query]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < SEARCH_MIN_CHARS) {
      // Also bump the sequence: anything already in flight for a longer query must not repaint
      // the results the operator just cleared.
      searchSeq.current++;
      setSearchHits([]); setSearchNext(null); setRetained(null); setSearchError(null); setSearching(false);
      return undefined;
    }
    const timer = setTimeout(() => runSearch(), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, runSearch]);
  // B10 follow-tail key: the NEWEST event's seq, not shown.length. Once the 5k
  // ring is full, appends keep length constant, so a length-keyed effect never
  // re-fires and the feed stops following the tail — key on the newest identity
  // instead (a new append always changes lastSeq).
  const lastSeq = shown.length > 0 ? shown[shown.length - 1]!.seq : null;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const selSeqRef = useRef(selSeq);
  selSeqRef.current = selSeq;

  // `f` — cycle the kind filter across the kinds PRESENT in the buffer.
  useEffect(() => registerActionHandler("events.filterCycle", () => {
    setKindFilter((cur) => nextKindFilter(cur, appStore.getState().events));
  }), []);

  // up/down — move the row cursor over the currently-shown rows (F01).
  const moveSel = useCallback((delta: number): void => {
    const list = shownRef.current;
    if (list.length === 0) return;
    const curSeq = selSeqRef.current;
    const curIdx = curSeq === null ? list.length - 1 : list.findIndex((e) => e.seq === curSeq);
    const base = curIdx < 0 ? list.length - 1 : curIdx;
    const next = Math.min(list.length - 1, Math.max(0, base + delta));
    setSelSeq(list[next]!.seq);
  }, []);
  useEffect(() => registerActionHandler("events.up", () => moveSel(-1)), [moveSel]);
  useEffect(() => registerActionHandler("events.down", () => moveSel(1)), [moveSel]);

  // `p` — pin/unpin the selected row (or the newest when none is selected).
  useEffect(() => registerActionHandler("events.pin", () => {
    const list = shownRef.current;
    const seq = selSeqRef.current;
    const e = seq !== null ? list.find((x) => x.seq === seq) : list[list.length - 1];
    if (!e) return;
    systemCommands(appStore, rpcCall).togglePin(eventPinTarget(e, appStore.getState().agents));
  }), []);

  // Follow the live tail while at bottom; HOLD the scroll position when the
  // user scrolled up (appends grow below the viewport). Same anchor semantics
  // as the transcript pane (A7-4), re-implemented over this table.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  // F05: page older history when the user scrolls near the top. Guarded so a
  // single page is in flight at a time and exhaustion stops further fetches.
  const fetchOlder = useCallback((): void => {
    if (fetchingRef.current || exhaustedRef.current) return;
    const live = appStore.getState().events;
    const liveOldest = live.length > 0 ? live[0]!.seq : undefined;
    const olderOldest = olderRef.current.size > 0 ? Math.min(...olderRef.current.keys()) : undefined;
    const oldestSeq = olderOldest ?? liveOldest;
    if (oldestSeq === undefined) return; // nothing loaded yet
    const req = olderPageRequest(oldestSeq, OLDER_PAGE);
    if (req === null) { exhaustedRef.current = true; return; }
    fetchingRef.current = true;
    const el = bodyRef.current;
    const prevH = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;
    void rpcCall<NormalizedEvent[]>("events.replay", req)
      .then((batch) => {
        let added = 0;
        for (const e of batch) {
          if (e.seq < oldestSeq && !olderRef.current.has(e.seq)) { olderRef.current.set(e.seq, e); added++; }
        }
        if (added > 0) pendingScrollRef.current = { prevH, prevTop };
        if (added === 0 || req.fromSeq <= 1) exhaustedRef.current = true;
        // re-render on growth OR on exhaustion (the "older" hint depends on both).
        if (added > 0 || exhaustedRef.current) setOlderVersion((v) => v + 1);
      })
      .catch(() => { /* transient — a later scroll retries (not exhausted) */ })
      .finally(() => { fetchingRef.current = false; });
  }, []);

  // Initial-connect backfill: a fresh connect/reconnect starts with an EMPTY
  // live ring (events.replay's tail semantics — an omitted fromSeq returns the
  // newest `limit` events, see EventLog.replay) and no scroll-up has happened
  // yet to seed olderRef, so the tab would otherwise show "no events yet"
  // forever. Shares fetchOlder's fetchingRef/exhaustedRef guards so a manual
  // scroll during the seed can't double-fetch, and writes into the SAME
  // olderRef cache so the seed's oldest seq chains directly into fetchOlder's
  // scroll-up paging with no extra plumbing. Deliberately does NOT go through
  // the ui-state "event" action / state.lastSeq — that watermark drops any
  // event at or below it, so a backfill of strictly OLDER events dispatched
  // that way would race any live event and be silently discarded whole.
  const fetchSeed = useCallback((): void => {
    if (fetchingRef.current || exhaustedRef.current) return;
    fetchingRef.current = true;
    setSeeding(true);
    void rpcCall<NormalizedEvent[]>("events.replay", { limit: OLDER_PAGE })
      .then((batch) => {
        let added = 0;
        for (const e of batch) {
          if (!olderRef.current.has(e.seq)) { olderRef.current.set(e.seq, e); added++; }
        }
        if (batch.length < OLDER_PAGE) exhaustedRef.current = true; // whole log fit in one page
        if (added > 0 || exhaustedRef.current) setOlderVersion((v) => v + 1);
      })
      .catch(() => { /* transient — a later reconnect (or scroll) retries */ })
      .finally(() => { fetchingRef.current = false; setSeeding(false); });
  }, []);

  // Fires on mount and on every reconnect while the tab stays mounted, but only
  // when nothing is loaded yet (the live ring AND olderRef both empty) — never
  // fights a tab that's already populated, whether from live traffic or a prior
  // seed this session.
  const seededConnRef = useRef(false);
  useEffect(() => {
    if (!connected) { seededConnRef.current = false; return; } // a later reconnect can re-seed
    if (seededConnRef.current) return;
    seededConnRef.current = true;
    if (appStore.getState().events.length > 0 || olderRef.current.size > 0) return; // already have something
    fetchSeed();
  }, [connected, fetchSeed]);

  const onScroll = (): void => {
    const el = bodyRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
    if (el.scrollTop <= 24) fetchOlder();
  };

  useLayoutEffect(() => {
    // Prepend of an older page: keep the viewport anchored on the same rows by
    // adding the height that appeared above (takes precedence over follow-tail,
    // which no-ops here because the user is scrolled up).
    const pending = pendingScrollRef.current;
    const el = bodyRef.current;
    if (pending && el) {
      el.scrollTop = pending.prevTop + (el.scrollHeight - pending.prevH);
      pendingScrollRef.current = null;
      return;
    }
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, lastSeq, kindFilter, olderVersion]);

  // Keep the selected row in view when the cursor moves (nearest — never yanks
  // the feed to the bottom).
  useLayoutEffect(() => {
    if (selSeq === null) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-event-seq="${selSeq}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selSeq]);

  // Final-acceptance MAJOR 2 (coverage A7-3): the events table shares the
  // transcript pane's copy-on-select — drag-select rows, release, clipboard +
  // "note: N characters copied to clipboard" toast (copyOnSelect.ts gates).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    return installCopyOnSelect(el, (chars) => appStore.dispatch({ type: "notice", message: copiedNotice(chars) }));
  }, []);

  const agentCell = (e: NormalizedEvent) => {
    const key = qualifiedAgentId(e);
    const known = agents[key] !== undefined;
    // qualified addresses are "<engineId>/<localId>" (protocol parseAgentAddress) —
    // W5 review: the old ":" probe never matched a real qualified id.
    const label = e.agentId.includes("/") ? e.agentId : shortId(e.agentId);
    return (
      <div
        className={known ? styles.agentLink : styles.agentCell}
        onClick={known ? () => coord.openAgent(key) : undefined}
        data-agent-cell={key}
      >
        {isRemoteEvent(e) && <span className={styles.remoteGlyph}>⇅ </span>}
        {label}
      </div>
    );
  };

  const pinEvent = (e: NormalizedEvent): void => {
    selSeqRef.current = e.seq;
    setSelSeq(e.seq);
    runAction("events.pin", appStore);
  };

  return (
    <div data-screen-layout="single" className={styles.row}>
      <Panel
        label={<>events <span className={styles.labelMeta}>· live feed</span></>}
        className={styles.pane}
      >
        <SearchBox
          value={query}
          onChange={setQuery}
          // A minimum that is not SAID is indistinguishable from a search that found nothing —
          // the operator types two characters, sees an empty list, and concludes the log is empty.
          placeholder={`search events (kind · agent · data) — ${SEARCH_MIN_CHARS}+ chars`}
          count={{ shown: query.trim() ? searchHits.length : shown.length, total: query.trim() ? searchHits.length : merged.length, noun: query.trim() ? "hits" : "events" }}
          dataAttr="events-search"
        />
        <div className={styles.colHead}>
          <div className={styles.colPin} />
          <div className={styles.colTime}>time</div>
          <div className={styles.colAgent}>agent</div>
          <div className={styles.colKind}>kind</div>
          <div className={styles.colData}>data</div>
        </div>
        <div className={styles.body} ref={bodyRef} onScroll={onScroll} data-events-body>
          {!query.trim() && !exhaustedRef.current && shown.length > 0 && (
            <div className={styles.olderHint} data-events-older-hint>
              {fetchingRef.current ? "loading older events…" : "scroll up for older events"}
            </div>
          )}
          {query.trim() ? (
            <>
              {retained && <div className={styles.olderHint}>daemon Chronicle · retained seq {retained.firstSeq ?? "–"}–{retained.lastSeq ?? "–"}</div>}
              {searchError && <div className={styles.emptyHint}>{searchError}</div>}
              {!searching && searchHits.length === 0 && !searchError && <div className={styles.emptyHint}>no Chronicle matches</div>}
              {searchHits.map((hit) => (
                <div key={`${hit.engineId}:${hit.seq}`} className={styles.eventRow} data-event-seq={hit.seq}
                  onClick={() => systemCommands(appStore, rpcCall).openReplayAt(hit.seq)}>
                  <div className={styles.colPin} />
                  <div className={styles.colTime}>{fmtClock(hit.ts)}</div>
                  <div className={styles.agentLink}>{shortId(hit.agentId)}</div>
                  <div className={styles.colKind}>{hit.kind}<br /><small>{chronicleLanes(hit).join(" → ")}</small></div>
                  <div className={styles.colData}>{hit.snippet}</div>
                </div>
              ))}
              {searchNext && <button onClick={() => runSearch(searchNext)} disabled={searching}>load more results</button>}
            </>
          ) : shown.length === 0 ? (
            <div className={styles.emptyHint}>
              {query.trim() ? "no events match" : seeding ? "loading recent events…" : kindFilter === null ? "no events yet" : `no ${kindFilter} events`}
            </div>
          ) : (
            shown.map((e) => {
              const tone = eventRowTone(e.kind, e.data);
              const isSel = selSeq !== null && e.seq === selSeq;
              const target = eventPinTarget(e, agents);
              const pinned = pins.some((pin) => pin.type === target.type && pin.id === target.id);
              return (
                <div
                  key={`${e.engineId}:${e.seq}`}
                  className={isSel ? `${styles.eventRow} ${styles.selected}` : styles.eventRow}
                  data-event-seq={e.seq}
                  onClick={() => setSelSeq((cur) => (cur === e.seq ? null : e.seq))}
                >
                  <div className={styles.colPin}>
                    <button
                      type="button"
                      className={styles.pinButton}
                      aria-label={pinned ? "unpin event target" : "pin event target"}
                      title="pin row"
                      data-event-action="events.pin"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        pinEvent(e);
                      }}
                    >
                      {pinned ? "★" : "☆"}
                    </button>
                  </div>
                  <div className={styles.colTime}>{fmtClock(e.ts)}</div>
                  {agentCell(e)}
                  <div className={styles.colKind}>
                    <span className={tone !== null ? styles[`tone_${tone}`] : undefined}>{e.kind}</span>
                  </div>
                  <div className={styles.colData}>{eventSummaryOverride(e.kind, e.data) ?? summarizeEventData(e.data)}</div>
                </div>
              );
            })
          )}
        </div>
        <PanelFooter>
          ↑↓ select · p pin row · wheel scroll · click agent id → agents tab · f filter by kind
          {kindFilter !== null && <span className={styles.filterMeta}> · kind: {kindFilter}</span>}
          {query.trim() && (
            <button
              onClick={() => {
                void rpcCall<ChronicleExportResponse>("events.searchExport", { query: query.trim(), limit: 100, maxResults: 200 })
                  .then((out) =>
                    writeClipboard(out.content).then((ok) => {
                      if (ok) appStore.dispatch({ type: "notice", message: copiedNotice(out.content.length) });
                      else appStore.dispatch({ type: "notice", message: "copy failed: clipboard unavailable" });
                    }),
                  )
                  .catch((error: unknown) => appStore.dispatch({ type: "notice", message: errorText(error) }));
              }}
            >
              share sanitized results
            </button>
          )}
        </PanelFooter>
        <OverlayOutlet host="events" />
      </Panel>
    </div>
  );
}
