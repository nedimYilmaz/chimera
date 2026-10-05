import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Inject a 500-task response through the existing browser RPC seam; production
// QueuesScreen still sorts, searches, selects and owns scrolling itself.
export async function probeWorkspaceScale({ check, show, evaluate, waitFor, click, key, viewport, screenshot, settleRender, artifactDir }) {
  await viewport(1440,900);
  await evaluate(`(() => {
    const original=window.__UI_QA_RPC__;
    window.__QA_SCALE_RESTORE__=()=>{window.__UI_QA_RPC__=original;};
    window.__QA_SCALE_DETAIL__={spec:{name:'qa-scale',retryLimit:2,paused:true,createdAt:1},counts:{pending:500,blocked:0,in_progress:0,done:0,failed:0},tasks:Array.from({length:500},(_,i)=>({taskId:'qa-task-'+String(i).padStart(3,'0'),queue:'qa-scale',state:'pending',prompt:'Synthetic large queue task '+i,priority:0,pushedAt:i+1,attempts:0,agentId:null,role:null}))};
    window.__UI_QA_RPC__=(method,params)=>method==='queue.list'?[window.__QA_SCALE_DETAIL__.spec]:method==='queue.status'?window.__QA_SCALE_DETAIL__:method==='job.list'?[]:original(method,params);
  })()`);
  try {
    const start=performance.now();await show('screen-queues');
    await evaluate(`import('/src/state/store.ts').then(({appStore})=>{appStore.dispatch({type:'queues',available:true,items:[window.__QA_SCALE_DETAIL__.spec]});appStore.dispatch({type:'queueDetail',detail:window.__QA_SCALE_DETAIL__});})`);
    await waitFor(`document.querySelectorAll('[data-task-row]').length===500`);
    const mountMs=Math.round(performance.now()-start);
    check('ux26 qa large queue renders 500 real task rows',await evaluate(`document.querySelectorAll('[data-task-row]').length===500`));
    let fits=true;
    for (const w of [360,768,1440]) {
      await viewport(w,900);await settleRender();
      await evaluate(`document.querySelector('[data-task-row="qa-task-000"]').scrollIntoView({block:'nearest'})`);await settleRender();
      fits &&= await evaluate(`(() => {const e=document.querySelector('[data-task-row="qa-task-000"]'),r=e.getBoundingClientRect(),f=document.querySelector('footer'),b=f.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1 && !!document.elementFromPoint(r.x+Math.min(r.width/2,150),r.y+r.height/2)?.closest('[data-task-row]') && !!document.elementFromPoint(b.x+10,b.y+b.height/2)?.closest('footer');})()`);
      await screenshot('ux26-qa-large-queue-'+w);
    }
    check('ux26 qa large queue contained scroll 360 768 1440',fits);
    await evaluate(`document.querySelector('[data-task-row="qa-task-000"]').focus()`);await key('Enter');
    check('ux26 qa large queue keyboard selects exact task', await evaluate(`import('/src/state/store.ts').then(({appStore})=>appStore.getState().queueDetail.tasks.slice().sort((a,b)=>b.pushedAt-a.pushedAt)[appStore.getState().taskCursor]?.taskId==='qa-task-000')`));
    const filterStart=performance.now();
    await evaluate(`(() => {const input=document.querySelector('input[data-tasks-search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'qa-task-499');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`document.querySelectorAll('[data-task-row]').length===1`);
    const filterMs=Math.round(performance.now()-filterStart);
    check('ux26 qa large queue search preserves task identity',await evaluate(`document.querySelector('[data-task-row]').dataset.taskRow==='qa-task-499'`));
    const data={tasks:500,mountMs,filterMs,limits:'Single owned Chromium run; includes CDP/request/render waits, synthetic RPC. No production fleet throughput claim.'};
    if(artifactDir)writeFileSync(join(artifactDir,'ux26-qa-queue-responsiveness.json'),JSON.stringify(data,null,2));
    console.log('UX26_QA_QUEUE_RESPONSIVENESS='+JSON.stringify(data));
  } finally { await evaluate(`window.__QA_SCALE_RESTORE__()`); await show('topbar'); }
}
