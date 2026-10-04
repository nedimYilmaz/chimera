import { describe, expect, it } from "vitest";
import { initialState, type AgentView, type TranscriptItem } from "@chimera/ui-state";
import { compactionTimeline, createWorkspaceStore, diagnosticReport, EMPTY_WORKSPACE, exportTranscript, fillTemplate, parseWorkspace, templateVariables } from "../src/state/workspaceTools";
const agent={agentId:"agent-123",displayLabel:"QA",provider:"codex",model:"test",state:"running",busy:false,transcript:[{role:"user",text:"PRIVATE PROMPT",seq:1,ts:1000},{role:"tool",toolName:"shell",status:"done",input:"SECRET TOKEN",result:"result",seq:2,ts:2000}] as TranscriptItem[],historyLoaded:true,historyLoadState:"loaded",compactions:2} as AgentView;
describe("personal workspace persistence",()=>{
  it("preserves named draft attachments across reloads",()=>{
    let raw:string|null=null;const storage={getItem:()=>raw,setItem:(_k:string,v:string)=>{raw=v;}};
    const store=createWorkspaceStore(storage);
    expect(store.update(d=>({...d,drafts:[{id:"d",name:"v1",text:"Review image",agentId:"a",images:[{mediaType:"image/png",data:"abc",num:1,name:"image.png"}],nextImageNum:2,createdAt:1}]}))).toBeNull();
    expect(createWorkspaceStore(storage).getState().drafts[0]?.images[0]).toEqual({mediaType:"image/png",data:"abc",num:1,name:"image.png"});
  });
  it("leaves previous state intact after a quota error",()=>{
    const store=createWorkspaceStore({getItem:()=>null,setItem:()=>{throw Error("quota");}});
    expect(store.update(d=>({...d,notes:{a:"secret"}}))).toContain("Could not save");
    expect(store.getState().notes).toEqual({});
  });
  it("bounds storage without silently truncating the current draft",()=>{
    const store=createWorkspaceStore();const before=store.getState();
    expect(store.update(d=>({...d,notes:{a:"x".repeat(2_000_001)}}))).toContain("full");expect(store.getState()).toBe(before);
  });
  it("rejects malformed saved data and prototype keys",()=>{
    expect(parseWorkspace("invalid")).toEqual(EMPTY_WORKSPACE);
    expect(parseWorkspace('{"version":9}')).toEqual(EMPTY_WORKSPACE);
    const data=parseWorkspace('{"version":1,"notes":{"__proto__":"bad","ok":"note"},"drafts":[{"id":"a","name":"n","text":"t","agentId":null,"images":[{"data":"x","mediaType":"image/png"}],"createdAt":1,"nextImageNum":2}]}');
    expect(Object.keys(data.notes)).toEqual(["ok"]);expect(data.drafts).toEqual([]);
  });
});
it("fills only explicit template variables and preserves literal code",()=>{
  const source="Review {{branch}} for {{focus}}: {{branch}} $() <tag>";
  expect(templateVariables(source)).toEqual(["branch","focus"]);
  expect(fillTemplate(source,{branch:"main",focus:"bugs"})).toBe("Review main for bugs: main $() <tag>");
});
it("exports a labelled loaded window without tool inputs or attachment bytes",()=>{
  const json=JSON.parse(exportTranscript(agent,"json"));expect(json.scope).toContain("Loaded transcript window");
  expect(json.messages[0].text).toBe("PRIVATE PROMPT");expect(exportTranscript(agent,"md")).toContain("## user");
  expect(exportTranscript(agent,"json")).not.toContain("SECRET TOKEN");
});
it("diagnostics excludes conversational and tool content",()=>{
  const report=diagnosticReport(agent,1);expect(report).toContain('"provider": "codex"');
  expect(report).not.toContain("PRIVATE PROMPT");expect(report).not.toContain("SECRET TOKEN");
});
it("distinguishes aborted compactions and reads nested provider counters",()=>{
  const events=[{seq:1,ts:1,agentId:"agent-123",kind:"compaction",data:{phase:"start"}},{seq:2,ts:2,agentId:"agent-123",kind:"compaction",data:{phase:"aborted"}},{seq:3,ts:3,agentId:"other",kind:"compaction",data:{}},{seq:4,ts:4,agentId:"agent-123",kind:"compaction",data:{before:{tokens:120000},after:{tokens:20000}}}];
  expect(compactionTimeline({...initialState,events:events as never},agent.agentId)).toEqual([{seq:4,ts:4,phase:"completed",before:120000,after:20000},{seq:2,ts:2,phase:"stopped",before:null,after:null},{seq:1,ts:1,phase:"started",before:null,after:null}]);
});
it("refuses entries that could not survive reloading",()=>{
  const store=createWorkspaceStore();
  expect(store.update(d=>({...d,snippets:[{id:"a",name:"large",text:"x".repeat(50001)}]}))).toContain("too large");
  expect(store.getState().snippets).toEqual([]);
});
