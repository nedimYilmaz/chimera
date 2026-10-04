import { useSyncExternalStore } from "react";
import type { AgentView, TranscriptItem, UiState } from "@chimera/ui-state";

import type { PendingImage } from "./commands.agents";

export type FleetFilter = { query: string; showDone: boolean; unseenOnly: boolean; needsOperatorOnly: boolean };
export type SavedFilter = FleetFilter & { id: string; name: string };
export type Snippet = { id: string; name: string; text: string };
export type Draft = Snippet & { agentId: string | null; images: PendingImage[]; nextImageNum: number; createdAt: number };
export type Bookmark = { id: string; agentId: string; seq: number; ts: number; text: string; role: string };
export type DisplayPreferences = { textSize: "standard" | "large" | "larger"; density: "compact" | "comfortable"; reduceMotion: boolean };
export type WorkspaceData = { version: 1; snippets: Snippet[]; drafts: Draft[]; bookmarks: Bookmark[]; notes: Record<string, string>; filters: SavedFilter[]; display: DisplayPreferences };
const STORAGE_KEY = "chimera.workspace-tools.v1";
const MAX_BYTES = 2_000_000;
export const EMPTY_WORKSPACE: WorkspaceData = { version: 1, snippets: [], drafts: [], bookmarks: [], notes: {}, filters: [], display: { textSize: "standard", density: "compact", reduceMotion: false } };
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const snippet = (v: unknown): v is Snippet & Record<string,unknown> => isRecord(v) && text(v.id, 100) && text(v.name, 100) && text(v.text, 50000);
const image = (v: unknown): v is PendingImage => isRecord(v) && Number.isInteger(v.num) && Number(v.num)>0 && text(v.name,1000) && text(v.data, 1500000) && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(v.mediaType));
export function parseWorkspace(raw: string | null): WorkspaceData {
  try {
    if (!raw || raw.length > MAX_BYTES) return structuredClone(EMPTY_WORKSPACE);
    const v: unknown = JSON.parse(raw);
    if (!isRecord(v) || v.version !== 1) return structuredClone(EMPTY_WORKSPACE);
    const list = <T>(key: string, valid: (item: unknown) => item is T): T[] => Array.isArray(v[key]) ? v[key].filter(valid).slice(0,100) : [];
    const notes: Record<string,string> = {};
    if(isRecord(v.notes)) for(const [id,note] of Object.entries(v.notes).slice(0,200)) if(/^[\w-]+$/.test(id) && !["__proto__","constructor","prototype"].includes(id) && text(note,50000)) notes[id]=note;
    const display=isRecord(v.display) ? v.display : {};
    return {
      version:1, snippets:list("snippets",snippet),
      drafts:list("drafts",(d): d is Draft => snippet(d) && isRecord(d) && (d.agentId===null || text(d.agentId,100)) && Array.isArray(d.images) && d.images.every(image) && finite(d.createdAt) && finite(d.nextImageNum)),
      bookmarks:list("bookmarks",(b): b is Bookmark => isRecord(b) && text(b.id,100) && text(b.agentId,100) && finite(b.seq) && finite(b.ts) && text(b.text,500) && text(b.role,30)),
      filters:list("filters",(f): f is SavedFilter => isRecord(f) && text(f.id,100) && text(f.name,100) && text(f.query,1000) && typeof f.showDone==="boolean" && typeof f.unseenOnly==="boolean" && typeof f.needsOperatorOnly==="boolean"), notes,
      display:{textSize:display.textSize==="large" || display.textSize==="larger" ? display.textSize : "standard",density:display.density==="comfortable" ? "comfortable" : "compact",reduceMotion:display.reduceMotion===true},
    };
  } catch { return structuredClone(EMPTY_WORKSPACE); }
}
export function createWorkspaceStore(storage?: Pick<Storage,"getItem"|"setItem">) {
  let state: WorkspaceData;
  try { state=parseWorkspace(storage?.getItem(STORAGE_KEY) ?? null); } catch { state=structuredClone(EMPTY_WORKSPACE); }
  const listeners=new Set<()=>void>();
  return {
    getState:()=>state,
    subscribe(fn:()=>void) {listeners.add(fn);return()=>{listeners.delete(fn);};},
    update(change:(current:WorkspaceData)=>WorkspaceData): string|null {
      const next=change(state);
      const raw=JSON.stringify(next);
      if(new TextEncoder().encode(raw).length > MAX_BYTES) return "Workspace storage is full (2 MB). Remove an old draft or use a smaller attachment.";
      if(next.snippets.length>100 || next.drafts.length>100 || next.bookmarks.length>100 || next.filters.length>100 || Object.keys(next.notes).length>200) return "This collection is full. Remove an older entry first.";
      if(next.snippets.some(s=>!snippet(s)) || next.drafts.some(d=>!snippet(d) || !d.images.every(image)) || next.filters.some(f=>f.query.length>1000 || f.name.length>100) || Object.values(next.notes).some(n=>n.length>50000)) return "This entry is too large to save. Shorten the text or use a smaller attachment.";
      try { storage?.setItem(STORAGE_KEY,raw); } catch { return "Could not save locally. Your current draft and saved entries are unchanged."; }
      state=next;listeners.forEach(fn=>fn());return null;
    },
  };
}
function browserStorage(): Storage|undefined { try { return typeof localStorage!=="undefined" && typeof localStorage.getItem==="function" ? localStorage : undefined; } catch { return undefined; } }
export const workspaceTools=createWorkspaceStore(browserStorage() ?? {getItem:()=>null,setItem:()=>{throw new Error("Local storage unavailable");}});
export const useWorkspaceTools=()=>useSyncExternalStore(workspaceTools.subscribe,workspaceTools.getState);

export function templateVariables(source:string):string[] { return [...new Set([...source.matchAll(/\{\{([a-zA-Z][\w-]*)\}\}/g)].map(m=>m[1]!))]; }
export function fillTemplate(source:string,values:Record<string,string>):string { return source.replace(/\{\{([a-zA-Z][\w-]*)\}\}/g,(whole,key:string)=>Object.hasOwn(values,key)?values[key]!:whole); }
export function transcriptText(item:TranscriptItem):string {
  if(item.role==="tool") return `${item.toolName} (${item.status})${item.result ? `\n${item.result}` : ""}`;
  if(item.role==="task") return `${item.description} (${item.status})${item.error ? `\n${item.error}` : ""}`;
  return item.text;
}
/** Explicitly exports the loaded window; never claims omitted history or images are present. */
export function exportTranscript(agent:AgentView,format:"md"|"json"):string {
  const messages=agent.transcript.map(item=>({role:item.role,seq:item.seq??null,ts:item.ts??null,text:transcriptText(item)}));
  const scope="Loaded transcript window; image binaries and tool inputs are excluded.";
  if(format==="json") return JSON.stringify({version:1,agentId:agent.agentId,scope,messages},null,2);
  return `# ${agent.displayLabel || agent.agentId}\n\n${scope}\n\n`+messages.map(item=>`## ${item.role}${item.ts ? ` · ${new Date(item.ts).toISOString()}` : ""}\n\n${item.text}`).join("\n\n---\n\n");
}
/** Allowlist only: raw errors, prompts, paths, tool payloads and credentials never enter this report. */
export function diagnosticReport(agent:AgentView,protocolVersion:number|null):string {
  return JSON.stringify({protocolVersion,agent:agent.agentId.slice(0,8),provider:agent.provider,model:agent.model,state:agent.state,busy:agent.busy,transport:agent.codexTransport??null,context:agent.ctxUsage??null,contextLimit:agent.effectiveContextLimit??null,sessionUsage:agent.sessionUsage??null,compactions:agent.compactions??0,compacting:agent.compacting??false,historyLoaded:agent.historyLoaded,historyState:agent.historyLoadState,loadedItems:agent.transcript.length},null,2);
}
export function compactionTimeline(state:Pick<UiState,"events">,agentId:string) {
  return state.events.filter(e=>e.agentId===agentId && e.kind==="compaction").map(e=>({seq:e.seq,ts:e.ts,phase:e.data["phase"]==="start"?"started":e.data["phase"]==="aborted"?"stopped":"completed",before:isRecord(e.data["before"]) && finite(e.data["before"].tokens)?e.data["before"].tokens:null,after:isRecord(e.data["after"]) && finite(e.data["after"].tokens)?e.data["after"].tokens:null})).reverse();
}

let pendingFilter:FleetFilter|null=null;
let currentFilter:FleetFilter={query:"",showDone:false,unseenOnly:false,needsOperatorOnly:false};
const filterListeners=new Set<(value:FleetFilter)=>void>();
export function rememberFleetFilter(value:FleetFilter):void {pendingFilter=null;currentFilter=value;}
export function initialFleetFilter():FleetFilter|null {return pendingFilter ? {...pendingFilter} : null;}
export function currentFleetFilter():FleetFilter {return {...currentFilter};}
export function applyFleetFilter(value:FleetFilter):void {pendingFilter=filterListeners.size===0 ? {...value} : null;currentFilter=value;filterListeners.forEach(fn=>fn(value));}
export function onFleetFilter(fn:(value:FleetFilter)=>void):()=>void {filterListeners.add(fn);return()=>{filterListeners.delete(fn);};}
export function applyWorkspaceDisplay():void {
  if(typeof document==="undefined")return;
  const prefs=workspaceTools.getState().display;
  const delta=prefs.textSize==="large"?2:prefs.textSize==="larger"?4:0;
  for(const [key,value] of Object.entries({"--fs-body":13,"--fs-meta":12,"--fs-small":12.5,"--fs-tiny":11,"--fs-title":14})) document.documentElement.style.setProperty(key,`${value+delta}px`);
  document.documentElement.style.setProperty("--control-h",prefs.density==="comfortable"?"36px":"28px");
  document.documentElement.style.setProperty("--row-h",prefs.density==="comfortable"?"36px":"28px");
  document.documentElement.dataset.reduceMotion=String(prefs.reduceMotion);
}

const bookmarkListeners=new Set<(bookmark:Bookmark)=>void>();
export function openBookmark(bookmark:Bookmark):void { bookmarkListeners.forEach(fn=>fn(bookmark)); }
export function onOpenBookmark(fn:(bookmark:Bookmark)=>void):()=>void {bookmarkListeners.add(fn);return()=>{bookmarkListeners.delete(fn);};}
