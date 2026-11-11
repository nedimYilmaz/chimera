import { describe, expect, it } from "vitest";
import { initialState, reduce, type AgentRecordLite } from "@chimera/ui-state";
const record = (extra: Record<string, unknown> = {}): AgentRecordLite => ({ agentId:"a", provider:"codex", accountName:"main", state:"running", costUsd:0, createdAt:1, ...extra } as AgentRecordLite);
const snapshot = (r: AgentRecordLite, state = initialState) => reduce(state, { type:"agentRecords", records:[r] });
describe("model and effort from reconnect snapshots", () => {
  it.each(["claude","codex","kimi","openai","custom-api"])("restores %s values without needing agent_started history", provider => {
    const s = snapshot(record({provider, actualModel:"resolved-model", spec:{model:"model-alias",effort:"high"}}));
    expect(s.agents.a?.model).toBe("resolved-model");
    expect(s.agents.a?.effort).toBe("high");
  });
  it("uses the configured model when no runtime model has been reported", () => {
    expect(snapshot(record({spec:{model:"configured-model",effort:"low"}})).agents.a).toMatchObject({model:"configured-model",effort:"low"});
  });
  it("refreshes values from a later authoritative snapshot", () => {
    const first = snapshot(record({actualModel:"old-model",spec:{effort:"low"}}));
    expect(snapshot(record({actualModel:"new-model",spec:{effort:"xhigh"}}),first).agents.a).toMatchObject({model:"new-model",effort:"xhigh"});
  });
  it("keeps valid known values when older or malformed records omit them", () => {
    let s = snapshot(record({actualModel:"known-model",spec:{effort:"high"}}));
    for (const extra of [{}, {actualModel:"<synthetic>",spec:{model:" ",effort:"invalid"}}, {actualModel:42,spec:{model:null,effort:null}}]) {
      s = snapshot(record(extra),s);
      expect(s.agents.a).toMatchObject({model:"known-model",effort:"high"});
    }
  });
  it("still follows a later provider model event", () => {
    const first = snapshot(record({actualModel:"old-model",spec:{effort:"high"}}));
    const s = reduce(first,{type:"event",event:{agentId:"a",seq:2,ts:2,kind:"message_complete",data:{model:"live-model",text:"hello"}}});
    expect(s.agents.a).toMatchObject({model:"live-model",effort:"high"});
  });
});
