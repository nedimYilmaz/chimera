import { it, expect } from "vitest";
import type { DialogRequest, PermissionRequest } from "@chimera/core/backend";
import { makeSupervisor } from "./helpers.js";

it("cancels native dialogs and approvals without leaving pending UI cards", async () => {
  const { sup, events } = makeSupervisor([[{ awaitSend: true }]]);
  const record = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", on: { permissionRequest: "tui" } });
  const internal = sup as unknown as {
    decideDialog(record: unknown, request: DialogRequest): Promise<unknown>;
    decidePermission(record: unknown, request: PermissionRequest): Promise<unknown>;
  };
  try {
    const dialogController = new AbortController();
    const dialog = internal.decideDialog(record, { dialogId: "native-dialog", dialogKind: "permission_ask_user_question", payload: {}, signal: dialogController.signal });
    dialogController.abort();
    await expect(dialog).resolves.toEqual({ behavior: "cancelled" });
    expect(sup.answerDialog("native-dialog", { behavior: "completed", result: {} })).toBe(false);
    const permissionController = new AbortController();
    const permission = internal.decidePermission(record, { requestId: "native-permission", toolName: "Bash", input: { command: "ls" }, signal: permissionController.signal });
    permissionController.abort();
    await expect(permission).resolves.toBe(false);
    expect(sup.respondPermission("native-permission", true)).toBe(false);
    const statuses = events.tail(record.agentId, 50).filter((event) => event.kind === "status").map((event) => event.data);
    expect(statuses).toContainEqual({ dialogResolved: true, dialogId: "native-dialog" });
    const approvalId = String(events.tail(record.agentId, 50).find((event) => event.kind === "permission_request")?.data["requestId"]);
    expect(statuses).toContainEqual({ permissionResolved: true, requestId: approvalId, allow: false });
  } finally { await sup.kill(record.agentId); }
});
