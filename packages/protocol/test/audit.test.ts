import { describe, it, expect } from "vitest";
import {
  AuditActionSchema, AuditDecisionSchema, AuditLedgerRecordSchema, AuditVerifyResultSchema,
  AUDIT_GENESIS_HASH,
} from "@chimera/protocol";
import { RPC_CONTRACT, isContractMethod } from "@chimera/protocol/contract";

const VALID_RECORD = {
  seq: 1, ts: 1000, agentId: "agent-1", action: "host_tool", resource: "kubectl:prod",
  decision: "allow", reason: "host tool policy allows \"kubectl:prod\"",
  prevHash: AUDIT_GENESIS_HASH, hash: "a".repeat(64),
};

describe("audit ledger protocol schemas", () => {
  it("AuditActionSchema accepts the four known actions and rejects anything else", () => {
    for (const a of ["host_tool", "mcp_store_call", "destructive_bash_checkpoint", "credential_resolution"]) {
      expect(AuditActionSchema.safeParse(a).success).toBe(true);
    }
    expect(AuditActionSchema.safeParse("bogus_action").success).toBe(false);
  });

  it("AuditDecisionSchema accepts allow/deny/prompt/recorded only", () => {
    for (const d of ["allow", "deny", "prompt", "recorded"]) {
      expect(AuditDecisionSchema.safeParse(d).success).toBe(true);
    }
    expect(AuditDecisionSchema.safeParse("maybe").success).toBe(false);
  });

  it("AuditLedgerRecordSchema round-trips a valid record", () => {
    const parsed = AuditLedgerRecordSchema.parse(VALID_RECORD);
    expect(parsed).toEqual(VALID_RECORD);
  });

  it("AuditLedgerRecordSchema accepts an optional detail record", () => {
    const withDetail = { ...VALID_RECORD, detail: { tool: "kubectl", profile: "prod" } };
    expect(AuditLedgerRecordSchema.safeParse(withDetail).success).toBe(true);
  });

  it("AuditLedgerRecordSchema rejects a record missing hash", () => {
    const { hash: _hash, ...withoutHash } = VALID_RECORD;
    expect(AuditLedgerRecordSchema.safeParse(withoutHash).success).toBe(false);
  });

  it("AuditLedgerRecordSchema rejects an unknown action", () => {
    expect(AuditLedgerRecordSchema.safeParse({ ...VALID_RECORD, action: "delete_everything" }).success).toBe(false);
  });

  it("AuditLedgerRecordSchema rejects extra fields (.strict())", () => {
    expect(AuditLedgerRecordSchema.safeParse({ ...VALID_RECORD, extra: "nope" }).success).toBe(false);
  });

  it("AuditVerifyResultSchema round-trips a clean-chain result", () => {
    const result = {
      ok: true, recordCount: 3, headSeq: 3, headHash: "b".repeat(64),
      checkpoint: null, firstDivergence: null,
    };
    expect(AuditVerifyResultSchema.parse(result)).toEqual(result);
  });

  it("AuditVerifyResultSchema round-trips a divergent result with a checkpoint anchor", () => {
    const result = {
      ok: false, recordCount: 5, headSeq: 5, headHash: "c".repeat(64),
      checkpoint: { seq: 2, hash: "d".repeat(64), ts: 500 },
      firstDivergence: { seq: 3, kind: "hash_mismatch", detail: "record content does not match its own hash" },
    };
    expect(AuditVerifyResultSchema.parse(result)).toEqual(result);
  });

  it("audit.verify is registered in RPC_CONTRACT with an empty request and AuditVerifyResultSchema response", () => {
    expect(isContractMethod("audit.verify")).toBe(true);
    const { request, response } = RPC_CONTRACT["audit.verify"];
    expect(request.parse({})).toEqual({});
    expect(request.safeParse({ extra: 1 }).success).toBe(false);
    expect(response).toBe(AuditVerifyResultSchema);
  });
});
