import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { paneMinWidth } from "../src/state/panes";

// SCHEDULE-NAME-INVISIBLE: the schedules list showed each job by cron expression only. The names
// were there all along (JobSpecSchema requires one, and they were good: "overnight-janitor",
// "evetle-worktree-janitor", "infra10230-pr-and-jira") — the NAME COLUMN was simply resolving to
// zero width. It was `flex: 1; min-width: 0` sitting behind three FIXED columns that already
// overflowed the 430px left rail on their own, so no window size could ever reveal it.
//
// A render test cannot catch this: react-test-renderer applies no CSS, so the name is "present"
// in the tree either way. The invariant is arithmetic, so it is asserted as arithmetic — read the
// real stylesheet and prove the columns FIT, with room left for the name.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/screens/QueuesScreen.module.css"), "utf8");

function block(selector: string): string {
  const m = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no CSS block for ${selector}`);
  return m[1]!;
}
function px(selector: string, prop: string): number {
  // PANE-RESIZE: a width may now be `var(--pane-w, 430px)` — read the FALLBACK, which is the
  // shipped default. The narrowest the rail can actually get is asserted separately below.
  const decl = new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;\\n]+)`).exec(block(selector));
  if (!decl) throw new Error(`no ${prop} in ${selector}`);
  const m = /(\d+)px/.exec(decl[1]!);
  if (!m) throw new Error(`no px value in ${selector} ${prop}: ${decl[1]}`);
  return Number(m[1]);
}

describe("schedules panel column budget", () => {
  const RAIL_PADDING = 14 * 2;   // .jobColHead / row padding: 0 14px

  it("leaves the job-name column real width inside the left rail — it must never collapse", () => {
    const rail = px(".leftCol", "width") - RAIL_PADDING;
    const fixed = px(".colLead", "width")
      + px(".colSchedule", "width") + px(".colNextRun", "width") + px(".colLastResult", "width");
    const nameFloor = px(".colJob", "min-width");
    // The bug in one line: fixed columns alone (410 + 20 lead) exceeded the rail, so `flex: 1`
    // had nothing to distribute and the name got 0px.
    expect(fixed).toBeLessThan(rail);
    expect(rail - fixed).toBeGreaterThanOrEqual(nameFloor);
  });

  it("still fits at the NARROWEST the rail can be dragged — resizing must not re-hide the name", () => {
    // PANE-RESIZE made this rail draggable, which turns the original bug back into a live risk:
    // the budget used to hold only at the fixed 430px. It has to hold at the floor too, or the
    // name column silently collapses again as soon as someone narrows the pane — the exact
    // failure SCHEDULE-NAME-INVISIBLE was about, reachable now by dragging instead of by
    // never being reachable at all.
    const narrowest = paneMinWidth("queues") - RAIL_PADDING;
    const fixed = px(".colLead", "width")
      + px(".colSchedule", "min-width") + px(".colNextRun", "min-width") + px(".colLastResult", "min-width");
    expect(fixed).toBeLessThan(narrowest);
    expect(narrowest - fixed).toBeGreaterThanOrEqual(px(".colJob", "min-width"));
  });

  it("gives the name column a non-zero floor — `min-width: 0` is what let it vanish", () => {
    expect(px(".colJob", "min-width")).toBeGreaterThanOrEqual(100);
  });

  it("lets the trailing columns shrink instead of the name, at narrower widths", () => {
    for (const col of [".colSchedule", ".colNextRun", ".colLastResult"]) {
      expect(block(col)).toMatch(/flex-shrink:\s*1/);
      expect(block(col)).toMatch(/min-width:\s*\d+px/);
    }
  });
});
