import { describe, it, expect } from "vitest";
import { ENGINE_HELP, ENGINE_TOOL_NAMES } from "../src/engine-help.js";
import { MCP_TOOL_TABLE } from "@chimera/protocol/mcp-tools";

// F07 drift guard (pure, no daemon): the shared engine-help catalog is the SINGLE
// source of truth the UI palettes generate from. This pins its integrity here;
// its parity with the tools server.ts actually REGISTERS is enforced separately by
// the stdio completeness guard in mcp.test.ts ("engine_help.tools is EXACTLY the
// set of registered tool names"). Together: registered tools === ENGINE_HELP.tools
// === ENGINE_TOOL_NAMES === each UI catalog — drift anywhere fails a test.
describe("engine-help — shared tool catalog", () => {
  it("ENGINE_HELP.tools is exactly ENGINE_TOOL_NAMES", () => {
    expect(ENGINE_HELP.tools).toEqual([...ENGINE_TOOL_NAMES]);
  });

  it("has no duplicate tool names", () => {
    expect(new Set(ENGINE_TOOL_NAMES).size).toBe(ENGINE_TOOL_NAMES.length);
  });

  // TOOL-CATALOG-IS-DERIVED: this pin used to be a hardcoded count with a twenty-entry ledger of
  // manual bumps above it — and that ledger twice records the same failure in its own words ("a
  // prior merge landed a tool without bumping this pin", "drift corrected here"). A number that
  // has to be edited by hand every time the thing it measures changes does not guard anything; it
  // just fails later, for whoever touches it next.
  //
  // ENGINE_TOOL_NAMES is now READ OFF MCP_TOOL_TABLE, so the count cannot drift from the table by
  // construction and asserting equality against a literal would be asserting nothing. What is
  // still worth guarding is the opposite direction: that the catalog has not been accidentally
  // gutted, and that the specific tools listed below — each added by a named piece of work — are
  // still there.
  it("carries the full tool surface, and every family that was deliberately added to it", () => {
    expect(ENGINE_TOOL_NAMES.length).toBe(MCP_TOOL_TABLE.length);
    expect(ENGINE_TOOL_NAMES.length).toBeGreaterThan(100);
    for (const t of [
      // CROSS-PROVIDER-HANDOFF
      "agent_handoff",
      // REBIND
      "agent_rebind",
      // AGENT-INITIATED-REMEDIATION
      "queue_request_remediation",
      // AGENT-LOOKUP-BY-NAME
      "agent_find",
      "memory_add", "memory_edit", "memory_search",
      // ROLE-TOOLS-FOR-AGENTS: define a role globally, bind it wherever needed
      "role_create", "role_list", "role_update",
      // MEM-3: 1-hop link/backlink recall
      "memory_get",
      // HOOK-3: the wait-elimination primitive
      "subscribe", "unsubscribe", "subscriptions_list",
      // TASK-EDIT-VERSIONING
      "queue_edit_task",
      // QUEUE-REORDER
      "queue_move_task", "queue_retry_task", "queue_add_dependency",
      // QUEUE-PAUSE
      "queue_pause", "queue_resume",
      // AGENT-RESUME-TOOLS
      "agent_resume",
      // REMOTE-CONTROL
      "agent_remote_control",
      // R2 EFFORT
      "agent_set_effort",
      // ACCOUNT-SWITCH-LIVE
      "agent_set_account",
      // F23-2B
      "providers_list",
      // SPAWN-PROVIDER-MODEL
      "providers_models",
      // PLAN-PROJECT-CONDUCTOR-ROUTING P2-T2
      "dispatch",
      // Cluster A
      "team_update", "queue_list", "queue_update", "queue_delete",
      "plugins_list", "plugins_toggle", "config_get", "config_patch", "memory_delete",
      // Cluster B
      "accounts_add", "accounts_remove", "accounts_set_key", "accounts_test",
      // F23-2A: subscription OAuth
      "accounts_oauth_start", "accounts_oauth_finish",
      // SUBSCRIPTION-CONNECT: subscription (CLI-subscription) accounts
      "accounts_add_subscription",
      "job_create", "job_list", "job_status", "job_update", "job_delete", "job_run_now",
      "peer_status",
      // Cluster C
      "project_create", "project_import", "project_list", "project_status",
      "project_assign_team", "project_archive",
      // PROJECT-DEFAULT-DIR-AND-DELETE
      "project_unarchive", "project_delete",
      // PLAN-PROJECT-CONDUCTOR-ROUTING P1-T2
      "project_conductor_start", "project_conductor_stop",
      "host_tools", "host_set_policy",
      "agent_interrupt", "agent_close", "events_replay",
      // D12 (+ FEATURE WORKFLOW-RUN-P1's workflow_run, P2's workflow_plan)
      "workflow_create", "workflow_list", "workflow_update", "workflow_delete", "workflow_run", "workflow_plan",
      // D13
      "artifact_add", "artifact_list", "artifact_get",
      // D14
      "notify_test",
      // D15
      "usage_query",
      // F11.2
      "journal_query",
      // F13.1
      "history_runs",
      // D16
      "checkpoint_status", "checkpoint_create", "checkpoint_list", "checkpoint_revert",
      // MCP-STORE
      "mcp_store_list", "mcp_store_add", "mcp_store_remove", "mcp_store_tools", "mcp_store_call",
      // CHIMERA-MCP-NATIVE-CONNECT
      "mcp_store_importables", "mcp_store_import",
      // MCP-STORE-DIRECT-TOGGLE
      "mcp_store_set_direct",
      // TOKEN-OPT-P2
      "chimera_tools", "chimera_call",
    ]) {
      expect(ENGINE_TOOL_NAMES).toContain(t);
    }
  });

  it("still exposes the depth/permission/ask rule strings", () => {
    expect(typeof ENGINE_HELP.depthRule).toBe("string");
    expect(typeof ENGINE_HELP.permissionRule).toBe("string");
    expect(typeof ENGINE_HELP.askRule).toBe("string");
  });
});
