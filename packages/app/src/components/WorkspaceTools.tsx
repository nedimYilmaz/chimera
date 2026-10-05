import { ownContextActivation } from "./contextKeys";
import { ContextLinkShareForm } from "./ContextLinkShareOverlay";
import { useState } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { useStore } from "../state/useStore";
import { composerLocal } from "../state/commands.agents";

import { exportCsv } from "../rpc/bridge";
import { applyFleetFilter, currentFleetFilter, compactionTimeline, diagnosticReport, exportTranscript, fillTemplate, openBookmark, templateVariables, transcriptText, useWorkspaceTools, workspaceTools, type WorkspaceData } from "../state/workspaceTools";
import styles from "./WorkspaceTools.module.css";

const sections = ["Prompts", "Drafts", "Notes", "Bookmarks", "Views", "Display", "Export", "Compaction"] as const;
type Section = typeof sections[number];
export function WorkspaceTools({onClose}:{onClose:()=>void}) {
  const data=useWorkspaceTools();
  const state=useStore(s=>s);
  const agent=state.selectedAgentId ? state.agents[state.selectedAgentId] : undefined;
  const [section,setSection]=useState<Section>("Prompts");
  const [name,setName]=useState("");
  const [source,setSource]=useState("");
  const [values,setValues]=useState<Record<string,string>>({});
  const [message,setMessage]=useState("");
  const [note,setNote]=useState<string|null>(null);
  const [sharing,setSharing]=useState<{agentId:string;text:string}|null>(null);
  const [noteAgent,setNoteAgent]=useState(agent?.agentId);
  if(noteAgent!==agent?.agentId) {setNoteAgent(agent?.agentId);setNote(null);setSharing(null);}
  const save=(change:(d:WorkspaceData)=>WorkspaceData,success="Saved locally."):boolean=>{
    const error=workspaceTools.update(change);setMessage(error??success);return !error;
  };
  const id=()=>crypto.randomUUID();
  const insert=(text:string)=>{
    const local=composerLocal.getState();
    composerLocal.set({composeText:local.composeText ? `${local.composeText}\n\n${text}` : text});
    setMessage("Inserted into the composer. Review before sending.");
  };
  const variables=templateVariables(source);
  return <OverlayCard width={880} onClose={onClose} ariaLabel="Workspace tools">
    <OverlayCardHeader title="Workspace tools" meta={agent?.displayLabel ?? "Select an agent for agent tools"} hint={<button onClick={onClose}>Close</button>}/>
    <div className={styles.body} onKeyDown={ownContextActivation}>
      <nav className={styles.tabs} aria-label="Workspace tool categories">{sections.map(s=><button key={s} aria-pressed={section===s} onClick={()=>{setSection(s);setMessage("");}}>{s}</button>)}</nav>
      <p className={styles.hint}>Personal tools saved on this device. Notes, drafts and templates are not sent to agents automatically.</p>
      {section==="Prompts" && <div className={styles.grid}>
        <section><h3>Reusable prompts</h3>{data.snippets.length===0&&<p>No saved prompts yet.</p>}{data.snippets.map(s=><div className={styles.entry} key={s.id}><button onClick={()=>{setSource(s.text);setName(s.name);setValues({});}}>{s.name}</button><button aria-label={`Delete prompt ${s.name}`} onClick={()=>save(d=>({...d,snippets:d.snippets.filter(x=>x.id!==s.id)}))}>Delete</button></div>)}</section>
        <section><label>Name<input aria-label="Prompt name" maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label><label>Prompt template<textarea aria-label="Prompt template" maxLength={50000} value={source} onChange={e=>setSource(e.target.value)} placeholder="Review {{branch}} for {{focus}}"/></label>
          {variables.map(v=><label key={v}>{v}<input aria-label={`Variable ${v}`} value={values[v]??""} onChange={e=>setValues({...values,[v]:e.target.value})}/></label>)}
          <div className={styles.actions}><button disabled={!name.trim()||!source.trim()} onClick={()=>save(d=>({...d,snippets:[...d.snippets,{id:id(),name:name.trim(),text:source}]}))}>Save prompt</button><button disabled={!source.trim()||variables.some(v=>!values[v]?.trim())} onClick={()=>insert(fillTemplate(source,values))}>Insert prompt</button></div>
        </section></div>}
      {section==="Drafts" && <section><h3>Named draft stash</h3><p>Save multiple versions, including attachments. Saving leaves the composer intact. Restore requires an empty composer.</p><label>Draft name<input aria-label="Draft name" maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label><button disabled={!name.trim()} onClick={()=>{
        const c=composerLocal.getState();if(!c.composeText && !c.pendingImages.length){setMessage("The composer is empty.");return;}
        save(d=>({...d,drafts:[...d.drafts,{id:id(),name:name.trim(),text:c.composeText,agentId:agent?.agentId??null,images:structuredClone(c.pendingImages),nextImageNum:c.nextImageNum,createdAt:Date.now()}]}));
      }}>Stash current draft</button>{data.drafts.map(draft=><article className={styles.entry} key={draft.id}><div><strong>{draft.name}</strong><p>{draft.text.slice(0,140)} · {draft.images.length} attachments</p></div><button onClick={()=>{
        const c=composerLocal.getState();if(c.composeText || c.pendingImages.length){setMessage("Save or clear the current composer before restoring a draft.");return;}
        composerLocal.set({composeText:draft.text,pendingImages:structuredClone(draft.images),nextImageNum:draft.nextImageNum});setMessage("Restored to the current composer. Review the recipient before sending.");
      }}>Restore</button><button aria-label={`Delete draft ${draft.name}`} onClick={()=>save(d=>({...d,drafts:d.drafts.filter(x=>x.id!==draft.id)}))}>Delete</button></article>)}</section>}
      {section==="Notes" && <section><h3>Private operator notes</h3><p>Local notes for the selected agent, separate from its conversation.</p><textarea aria-label="Operator notes" disabled={!agent} maxLength={50000} value={note??(agent?data.notes[agent.agentId]??"":"")} onChange={e=>setNote(e.target.value)}/><button disabled={!agent} onClick={()=>agent&&save(d=>({...d,notes:{...d.notes,[agent.agentId]:note??d.notes[agent.agentId]??""}}))}>Save notes</button><button type="button" data-note-share disabled={!agent||!(note??(agent?data.notes[agent.agentId]:"")??"")} onClick={()=>agent&&setSharing({agentId:agent.agentId,text:note??data.notes[agent.agentId]??""})}>Share with agent…</button>{sharing&&<ContextLinkShareForm initial={{consumer:sharing.agentId,from:{kind:"note-snapshot",ref:sharing.agentId},text:sharing.text}} onClose={()=>setSharing(null)} onShared={()=>setMessage("Immutable snapshot shared; your private note draft is preserved.")}/>}</section>}
      {section==="Bookmarks" && <section><h3>Transcript bookmarks</h3><p>Save a turn from the loaded transcript; open retrieves older pages when needed.</p>{!agent&&<p>Select an agent first.</p>}{data.bookmarks.filter(b=>b.agentId===agent?.agentId).map(b=><div className={styles.entry} key={b.id}><button onClick={()=>{openBookmark(b);onClose();}}>{b.role}: {b.text.slice(0,100)}</button><button aria-label="Delete bookmark" onClick={()=>save(d=>({...d,bookmarks:d.bookmarks.filter(x=>x.id!==b.id)}))}>Delete</button></div>)}<label>Bookmark a loaded turn<select aria-label="Bookmark turn" defaultValue="" onChange={e=>{
        const item=agent?.transcript[Number(e.target.value)];if(!agent||!item||item.seq===undefined)return;
        if(data.bookmarks.some(b=>b.agentId===agent.agentId&&b.seq===item.seq&&b.role===item.role)){setMessage("This turn is already bookmarked.");return;}
        save(d=>({...d,bookmarks:[...d.bookmarks,{id:id(),agentId:agent.agentId,seq:item.seq!,ts:item.ts??0,role:item.role,text:transcriptText(item).slice(0,500)}]}));e.target.value="";
      }}><option value="" disabled>Select a turn…</option>{agent?.transcript.map((item,i)=>(item.role==="user"||item.role==="assistant")&&item.seq!==undefined?<option key={i} value={i}>{item.role}: {transcriptText(item).slice(0,90)}</option>:null)}</select></label></section>}
      {section==="Views" && <section><h3>Saved fleet views</h3><p>Save the current agent search and done, unread and needs-you filters.</p><label>View name<input aria-label="View name" maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label><button disabled={!name.trim()} onClick={()=>save(d=>({...d,filters:[...d.filters,{...currentFleetFilter(),id:id(),name:name.trim()}]}))}>Save current view</button>{data.filters.map(f=><div className={styles.entry} key={f.id}><button onClick={()=>{applyFleetFilter(f);onClose();}}>{f.name} {f.query&&`· ${f.query}`}</button><button aria-label={`Delete view ${f.name}`} onClick={()=>save(d=>({...d,filters:d.filters.filter(x=>x.id!==f.id)}))}>Delete</button></div>)}</section>}
      {section==="Display" && <section><h3>Application readability</h3><label>Text size<select aria-label="Text size" value={data.display.textSize} onChange={e=>save(d=>({...d,display:{...d.display,textSize:e.target.value as WorkspaceData["display"]["textSize"]}}))}><option value="standard">Standard</option><option value="large">Large</option><option value="larger">Larger</option></select></label><label>Control density<select aria-label="Control density" value={data.display.density} onChange={e=>save(d=>({...d,display:{...d.display,density:e.target.value as WorkspaceData["display"]["density"]}}))}><option value="compact">Compact</option><option value="comfortable">Comfortable</option></select></label><label className={styles.check}><input type="checkbox" checked={data.display.reduceMotion} onChange={e=>save(d=>({...d,display:{...d.display,reduceMotion:e.target.checked}}))}/>Reduce motion</label><p>Focus workspace is available beside the agent view tabs. Toggle it again to restore the fleet pane.</p></section>}
      {section==="Export" && <section><h3>Transcript export</h3><p>Exports the currently loaded transcript window, excluding image binaries and tool inputs. Load older history before exporting if needed.</p><div className={styles.actions}>{(["md","json"] as const).map(format=><button disabled={!agent} key={format} onClick={()=>{
        if(!agent)return;void exportCsv(`chimera-${agent.agentId.slice(0,8)}-${Date.now()}.${format}`,exportTranscript(agent,format)).then(path=>setMessage(`Saved: ${path}`)).catch(()=>setMessage("Export failed. Your transcript is unchanged."));
      }}>Export {format==="md"?"Markdown":"JSON"}</button>)}</div><h3>Diagnostic report</h3><p>Copies provider, model, state, context and usage counters. Excludes prompts, file paths, tool payloads and credentials.</p><button disabled={!agent} onClick={()=>{
        if(!agent)return;void (async()=>{try {await navigator.clipboard.writeText(diagnosticReport(agent,state.protocolVersion));setMessage("Diagnostic report copied.");} catch {setMessage("Clipboard unavailable. The report was not copied.");}})();
      }}>Copy diagnostics</button></section>}
      {section==="Compaction" && <section><h3>Compaction timeline</h3><p>{agent?`${agent.compactions??0} completed · ${agent.compacting?"in progress":"idle"}`:"Select an agent first."}</p><p>Recent events retained by this app. Older events may be absent; the completed total is tracked separately.</p>{agent&&compactionTimeline(state,agent.agentId).map(e=><div className={styles.entry} key={e.seq}><time>{new Date(e.ts).toLocaleString()}</time><strong>{e.phase}</strong>{e.before!==null&&<span>{e.before} → {e.after??"unknown"} tokens</span>}</div>)}{agent&&compactionTimeline(state,agent.agentId).length===0&&<p>No compaction events in the current event window.</p>}</section>}
      <p role="status" className={styles.status}>{message}</p>
    </div>
  </OverlayCard>;
}
