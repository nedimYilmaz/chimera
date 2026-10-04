import { useEffect, useMemo, useState } from "react";
import { type UiState, updateWorkflowGraphNode } from "@chimera/ui-state";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { getWorkflowsCommands } from "../state/commands.workflows";
import { rpcCall } from "../rpc/bridge";
import { workflowExecutionOverlay, workflowGraphLayout, workflowGraphValidation } from "../state/selectors.workflows";
import { isEditableTarget } from "../keymap";
import { ConfirmCard } from "./ConfirmCard";
import styles from "./WorkflowStudio.module.css";

const cmd = getWorkflowsCommands(appStore, rpcCall);

export function WorkflowStudio() {
  const studio = useStore((s: UiState) => s.workflowStudio);
  const agents = useStore((s: UiState) => s.agents);
  const detail = useStore((s: UiState) => s.queueDetail);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = (): void => {
    if (studio.dirty) setConfirmClose(true);
    else appStore.dispatch({ type: "workflowStudioClose" });
  };
  const doc = studio.draft;
  const task = studio.taskId ? detail?.tasks.find((t) => t["taskId"] === studio.taskId) ?? null : null;
  const layout = useMemo(() => doc ? workflowGraphLayout(doc) : null, [doc]);
  const issues = useMemo(() => doc ? workflowGraphValidation(doc) : [], [doc]);
  const runtime = useMemo(() => doc && task ? workflowExecutionOverlay(doc, task, agents) : {}, [doc, task, agents]);
  useEffect(() => {
    if (!studio.open) { setConnectFrom(null); setConfirmClose(false); }
  }, [studio.open]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!studio.open || isEditableTarget(event.target)) return;
      if (event.key === "Escape") {
        if (confirmClose) return; // ConfirmCard owns this Escape
        event.preventDefault();
        connectFrom ? setConnectFrom(null) : requestClose();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!issues.length && studio.mode === "author") void cmd.saveStudio().catch(() => {}); }
      if (event.key.toLowerCase() === "n" && studio.mode === "author" && doc) {
        event.preventDefault();
        let n = doc.nodeOrder.length + 1; while (doc.nodesById[`step-${n}`]) n++;
        const id = `step-${n}`;
        const step = { id, title: `Step ${n}`, gate: { kind: "none" as const }, context: "handoff" as const };
        appStore.dispatch({ type: "workflowStudioDraft", document: { ...doc, nodeOrder: [...doc.nodeOrder, id], nodesById: { ...doc.nodesById, [id]: { id, step } } } });
        appStore.dispatch({ type: "workflowStudioSelect", nodeId: id });
      }
    };
    window.addEventListener("keydown", onKey, true); return () => window.removeEventListener("keydown", onKey, true);
  }, [studio.open, studio.mode, connectFrom, doc, issues.length, confirmClose]);
  if (!studio.open || !doc || !layout) return null;
  const selected = studio.selectedNodeId ? doc.nodesById[studio.selectedNodeId] : null;
  const update = (patch: Parameters<typeof updateWorkflowGraphNode>[2]): void => { if (selected) appStore.dispatch({ type: "workflowStudioDraft", document: updateWorkflowGraphNode(doc, selected.id, patch) }); };
  return <div className={styles.studio} data-workflow-studio>
    <header className={styles.header}><div><strong>Workflow Studio</strong>{studio.mode === "author" ? <input aria-label="workflow name" value={doc.name} onChange={(e)=>appStore.dispatch({type:"workflowStudioDraft",document:{...doc,name:e.target.value}})}/> : <span>{doc.name}</span>}<span>{studio.version ? `v${studio.version}` : "new"}</span></div><div className={styles.actions}><span className={issues.length ? styles.invalid : styles.valid}>{issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}` : "valid topology"}</span>{studio.mode === "author" && studio.error && <span className={styles.invalid}>{studio.error}</span>}{studio.mode === "author" && <button disabled={!studio.dirty || !!issues.length || studio.saving} onClick={() => { void cmd.saveStudio().catch(() => {}); }}>{studio.saving ? "Saving…" : "Save ⌘S"}</button>}<button onClick={requestClose}>Close Esc</button></div></header>
    <div className={styles.body}>
      <div className={styles.canvas} style={{ minWidth: layout.width, minHeight: layout.height }}>
        <svg className={styles.edges} width={layout.width} height={layout.height}>{Object.values(doc.edgesById).map((edge) => { const a = layout.nodes[edge.from], b = layout.nodes[edge.to]; if (!a || !b) return null; const x1=a.x+a.width,y1=a.y+a.height/2,x2=b.x,y2=b.y+b.height/2; return <g key={edge.id}><path d={`M${x1},${y1} C${x1+70},${y1} ${x2-70},${y2} ${x2},${y2}`} /><text x={(x1+x2)/2} y={(y1+y2)/2-7}>{edge.kind === "route" ? "route" : edge.kind === "fanOutJoin" ? "join" : ""}</text></g>; })}</svg>
        {doc.nodeOrder.filter((id) => !studio.failedOnly || runtime[id]?.state === "failed").map((id) => { const box=layout.nodes[id]!, node=doc.nodesById[id]!, run=runtime[id]; return <button key={id} className={`${styles.node} ${studio.selectedNodeId===id?styles.selected:""} ${run && styles[run.state] ? styles[run.state] : ""}`} style={{left:box.x,top:box.y,width:box.width,height:box.height}} onClick={() => { if (connectFrom && connectFrom !== id) { const source=doc.nodesById[connectFrom]; if(source && !source.step.fanOut && source.step.gate.kind!=="plan") appStore.dispatch({type:"workflowStudioDraft",document:updateWorkflowGraphNode(doc,connectFrom,{next:[...(source.step.next??[]),{to:id}]})}); setConnectFrom(null); } appStore.dispatch({type:"workflowStudioSelect",nodeId:id}); }}><small>{node.step.gate.kind}{node.step.fanOut ? " · fan-out" : ""}</small><strong>{node.step.title}</strong>{run && <span>{run.state}{run.attempts>1?` · ${run.attempts} attempts`:""}</span>}</button>; })}
      </div>
      <aside className={styles.inspector}>{selected ? <><h2>{selected.step.title}</h2><label>Title<input value={selected.step.title} disabled={studio.mode==="inspect"} onChange={(e)=>update({title:e.target.value})}/></label><label>Instructions<textarea value={selected.step.instructions??""} disabled={studio.mode==="inspect"} onChange={(e)=>update({instructions:e.target.value||undefined})}/></label><label>Role<input value={selected.step.role??""} disabled={studio.mode==="inspect"} onChange={(e)=>update({role:e.target.value||undefined})}/></label>{studio.mode==="author"&&<button onClick={()=>setConnectFrom(selected.id)}>{connectFrom===selected.id?"Choose target…":"Connect edge"}</button>}{runtime[selected.id]?.agentId&&<button onClick={()=>appStore.dispatch({type:"navigate",target:{kind:"agent",agentId:runtime[selected.id]!.agentId!}})}>Open transcript</button>}{studio.taskId&&<button onClick={()=>appStore.dispatch({type:"navigate",target:{kind:"task",taskId:studio.taskId!,queue:studio.queue??undefined}})}>Open task</button>}{issues.filter(i=>!i.nodeId||i.nodeId===selected.id).map((i,n)=><p className={styles.invalid} key={n}>{i.message}</p>)}</>:<p>Select a node. N adds a step; choose Connect edge then a target.</p>}</aside>
    </div>
    {confirmClose && <ConfirmCard
      title="⚠ discard changes"
      body="This workflow has unsaved edits. Closing now discards them."
      note="This cannot be undone."
      confirmLabel="confirm discard"
      onConfirm={() => { setConfirmClose(false); appStore.dispatch({ type: "workflowStudioClose" }); }}
      onClose={() => setConfirmClose(false)}
    />}
  </div>;
}
