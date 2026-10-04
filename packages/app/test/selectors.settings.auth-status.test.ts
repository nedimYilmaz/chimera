// MCP-AUTH-STATUS (app half): the store page's per-server auth chip, and the at-rest signal
// that finally makes the Authorize control's label honest.
//
// The bug this closes: before mcpstore.authStatus, `connected` was derived ONLY from a flow
// that ran in THIS session or a tools fetch triggered by expanding the row. On a cold page
// open every installed server therefore read as not-connected, the button said "Authorize"
// when it meant "Re-authorize", and a silently-revoked grant looked identical to a healthy one.
import { describe, expect, it } from "vitest";
import { mcpAuthChipView, mcpStoreAuthRowView } from "../src/state/selectors.settings";

const NOW = 1_760_000_000_000;

describe("MCP-AUTH-STATUS: mcpAuthChipView", () => {
  it("renders no chip at all for a server with nothing to authorize", () => {
    expect(mcpAuthChipView({ state: "none", detail: "no authorization configured" }, NOW).label).toBeNull();
    expect(mcpAuthChipView(undefined, NOW).label).toBeNull();
  });

  it("gives the loud tone to the ONE state that asks for action", () => {
    const warn = mcpAuthChipView({ state: "needs-reauth", detail: "the grant was revoked" }, NOW);
    expect(warn).toMatchObject({ label: "needs re-auth", tone: "warn" });
    expect(warn.title).toBe("the grant was revoked");

    // Everything else is informational, so nothing else may claim the operator's attention.
    for (const state of ["authorized", "never", "bearer"] as const) {
      expect(mcpAuthChipView({ state }, NOW).tone).not.toBe("warn");
    }
  });

  it("shows the grant's age on an authorized chip", () => {
    expect(mcpAuthChipView({ state: "authorized", authorizedAt: NOW - 30_000 }, NOW).label).toBe("authorized (just now)");
    expect(mcpAuthChipView({ state: "authorized", authorizedAt: NOW - 20 * 60_000 }, NOW).label).toBe("authorized (20m ago)");
    expect(mcpAuthChipView({ state: "authorized", authorizedAt: NOW - 5 * 3600_000 }, NOW).label).toBe("authorized (5h ago)");
    expect(mcpAuthChipView({ state: "authorized", authorizedAt: NOW - 3 * 24 * 3600_000 }, NOW).label).toBe("authorized (3d ago)");
  });

  // A grant minted before `authorizedAt` existed has no stamp. It must still read as
  // authorized rather than showing a bogus age or dropping to a lesser state.
  it("omits the age when the stored grant predates the timestamp field", () => {
    expect(mcpAuthChipView({ state: "authorized" }, NOW).label).toBe("authorized");
  });

  it("distinguishes never-authorized from a static token", () => {
    expect(mcpAuthChipView({ state: "never" }, NOW).label).toBe("not authorized");
    expect(mcpAuthChipView({ state: "bearer" }, NOW).label).toBe("token");
  });
});

describe("MCP-AUTH-STATUS: mcpStoreAuthRowView at-rest signal", () => {
  const cold = { type: "http" as const, authKind: "oauth" as const, toolsConnected: false, toolsStatus: "idle" as const };

  it("reads a stored grant as connected with no live flow and no tools fetch", () => {
    const view = mcpStoreAuthRowView({ ...cold, authState: "authorized" });
    expect(view.connected).toBe(true);
    expect(view.authorizeLabel).toBe("Re-authorize");
  });

  // The regression this replaces: identical inputs, no authState -> "Authorize" on a server
  // that has been authorized for weeks.
  it("still says Authorize when nothing anywhere says the server is authorized", () => {
    expect(mcpStoreAuthRowView(cold).authorizeLabel).toBe("Authorize");
    expect(mcpStoreAuthRowView({ ...cold, authState: "never" }).authorizeLabel).toBe("Authorize");
  });

  it("offers Re-authorize on a dead grant without pretending it is connected", () => {
    const view = mcpStoreAuthRowView({ ...cold, authState: "needs-reauth" });
    expect(view.connected).toBe(false);
    expect(view.showAuthorize).toBe(true);
  });

  // A live flow is a stronger, fresher signal than the at-rest row, and must keep winning.
  it("lets a just-completed flow override a stale needs-reauth row", () => {
    const view = mcpStoreAuthRowView({ ...cold, authState: "needs-reauth", oauth: { status: "connected" } });
    expect(view.connected).toBe(true);
  });

  it("leaves a stdio server without an authorize control regardless of auth state", () => {
    expect(mcpStoreAuthRowView({ type: "stdio", toolsConnected: false, toolsStatus: "idle", authState: "none" }).showAuthorize).toBe(false);
  });
});
