import { writeFileSync } from "node:fs";
import { join } from "node:path";
// Production Liveboard and route-loading wrapper, with deterministic rejected/deferred RPC/import seams.
export async function probeWorkspaceRecovery({ check, show, evaluate, waitFor, click, key, viewport, screenshot, settleRender, artifactDir }) {
  await viewport(1440, 900); await show('qa-liveboard');
  await waitFor(`window.__QA_RECOVERY__.pending()===1`);
  check('ux26 qa liveboard loading is not empty', await evaluate(`!!document.querySelector('[data-load-status="loading"]') && !document.querySelector('[data-qa-recovery]').textContent.includes('no transcript yet')`));
  await evaluate(`window.__QA_RECOVERY__.settle(0)`);
  await waitFor(`document.querySelector('[data-load-retry]')`);
  check('ux26 qa liveboard error offers retry', await evaluate(`document.querySelector('[data-qa-recovery]').textContent.includes("couldn't load transcript") && !document.querySelector('[data-qa-recovery]').textContent.includes('no transcript yet')`));
  await evaluate(`document.querySelector('[data-load-retry]').click();document.querySelector('[data-load-retry]').click()`);
  await waitFor(`window.__QA_RECOVERY__.pending()===2`);
  check('ux26 qa liveboard pending retry deduplicates', await evaluate(`document.querySelector('[data-load-retry]').disabled && window.__QA_RECOVERY__.pending()===2`));
  await evaluate(`window.__QA_RECOVERY__.cycle()`); await waitFor(`window.__QA_RECOVERY__.pending()===3`);
  await evaluate(`window.__QA_RECOVERY__.settle(2,'Current recovered history');window.__QA_RECOVERY__.settle(1,'Obsolete pre-disconnect history')`);
  await waitFor(`document.querySelector('[data-qa-recovery]').textContent.includes('Current recovered history')`);
  check('ux26 qa liveboard late reply rejected', await evaluate(`!document.querySelector('[data-qa-recovery]').textContent.includes('Obsolete pre-disconnect history')`));
  await evaluate(`window.__QA_RECOVERY__.cycle()`); await waitFor(`window.__QA_RECOVERY__.pending()===4`); await evaluate(`window.__QA_RECOVERY__.settle(3)`);
  await waitFor(`document.querySelector('[data-load-status="stale"]')`);
  check('ux26 qa liveboard stale keeps transcript and draft', await evaluate(`document.querySelector('[data-qa-recovery]').textContent.includes('Current recovered history') && document.querySelector('[data-composer] textarea').value==='QA unsent recovery draft'`));
  let fits=true, readable=true;
  for (const w of [360,768,1440]) {
    await viewport(w,900);await settleRender();
    fits &&= await evaluate(`(() => {const e=document.querySelector('[data-composer] textarea'),r=e.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1 && !!document.elementFromPoint(r.x+Math.min(20,r.width/2),r.y+r.height/2)?.closest('[data-composer]');})()`);
    readable &&= await evaluate(`document.querySelector('[data-load-status="stale"] span').getBoundingClientRect().width > 150`);
    await screenshot(`ux26-qa-liveboard-${w}`);
  }
  check('ux26 qa liveboard no overflow composer reachable 360 768 1440',fits);
  check('ux26 qa liveboard recovery message readable',readable);
  await show('qa-recovery'); await waitFor(`document.querySelector('[data-composer] textarea')`);
  await evaluate(`window.__QA_RECOVERY__.select('projects')`);
  await waitFor(`document.querySelector('main').textContent.includes('screen could not load')`);
  check('ux26 qa route failure retains chrome', await evaluate(`!!document.querySelector('[data-qa-recovery]') && !!document.querySelector('footer') && document.querySelectorAll('[data-topbar-tab]').length>0`));
  let routeFits=true;
  for (const w of [360,768,1440]) {
    await viewport(w,900);await settleRender();
    routeFits &&= await evaluate(`(() => {const e=document.querySelector('main button'),r=e.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1 && r.left>=0 && r.right<=innerWidth+1 && document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e;})()`);
    await screenshot(`ux26-qa-route-error-${w}`);
  }
  check('ux26 qa route recovery reachable 360 768 1440',routeFits);
  await evaluate(`document.querySelector('main button').focus()`);await key('r');
  await waitFor(`window.__QA_RECOVERY__.attempts()===2 && document.querySelector('main').textContent.includes('Loading screen')`);
  check('ux26 qa route keyboard retry makes fresh attempt', await evaluate(`window.__QA_RECOVERY__.attempts()===2`));
  const started=performance.now();await evaluate(`window.__QA_RECOVERY__.release()`);
  await waitFor(`!document.querySelector('main').textContent.includes('Loading screen') && !document.querySelector('main').textContent.includes('screen could not load')`);
  const timing = { releaseToRenderedMs: Math.round(performance.now()-started), measurement: 'owned Chromium plus CDP wait overhead; synthetic failure, real ProjectsScreen' };
  if (artifactDir) writeFileSync(join(artifactDir, 'ux26-qa-responsiveness.json'), JSON.stringify(timing, null, 2));
  console.log('UX26_QA_RESPONSIVENESS=' + JSON.stringify(timing));
  check('ux26 qa route recovers actual projects', await evaluate(`document.querySelector('main').textContent.toLowerCase().includes('project') && window.__QA_RECOVERY__.attempts()===2`), timing);
  await evaluate(`window.__QA_RECOVERY__.select('agents')`);await waitFor(`document.querySelector('[data-composer] textarea')`);
  check('ux26 qa route navigation restores draft', await evaluate(`document.querySelector('[data-composer] textarea').value==='QA unsent recovery draft'`));
  await show('topbar');
}
