// TOGGLE-DETAIL: shared click semantics for "click a row to open its detail,
// click the SAME row again to close it" — every master-detail screen
// (Teams/Queues/Memory/Projects) and every inline per-row inspector
// (TeamsScreen's AgentInspector, QueuesScreen's TaskInspector) wants this.
//
// Two shapes, because the underlying cursor storage differs:
//  - toggleCollapsed: for a cursor that's shared ui-state reducer state
//    (teamCursor/queueCursor/memoryCursor — clampCursor in reducer.ts clamps
//    it to [0, len-1], it can never go negative), so "closed" has to be a
//    SEPARATE screen-local boolean flag layered on top of the cursor.
//  - toggleIndex: for a screen-local cursor that ISN'T clamped anywhere
//    (TeamsScreen's agentIdx, EventsScreen's selSeq, ProjectsScreen's own
//    zustand cursor) — "closed" can just be the sentinel -1/null.

export function toggleCollapsed(clickedIndex: number, currentIndex: number, collapsed: boolean): boolean {
  return clickedIndex === currentIndex ? !collapsed : false;
}

export function toggleIndex(clickedIndex: number, currentIndex: number): number {
  return clickedIndex === currentIndex ? -1 : clickedIndex;
}
