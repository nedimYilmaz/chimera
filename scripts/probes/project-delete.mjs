export async function probeProjectDelete({ check, viewport, show, waitFor, evaluate, click, key, buttonKey, settleRender, screenshot }) {
  await viewport(1440, 900); await show('project-delete');
  await waitFor(`document.querySelector('[data-delete-project]')`);
  await click('[data-delete-project]');
  await waitFor(`document.querySelector('[data-delete-files-toggle]')`);
  check('project delete native labeled default off', await evaluate(`(() => { const e=document.querySelector('[data-delete-files-toggle]'); return e.tagName==='INPUT' && e.type==='checkbox' && !e.checked && e.labels[0].textContent.includes('also delete files on disk') && !document.querySelector('[data-delete-files-warning]'); })()`));
  // Traverse from the native Cancel button using Chromium's actual Tab default.
  await evaluate(`document.querySelector('[data-confirm-cancel]').focus()`);
  await key('Tab', 8); await key('Tab', 8);
  check('project delete native tab reaches checkbox', await evaluate(`document.activeElement===document.querySelector('[data-delete-files-toggle]')`));
  await buttonKey(' ', 'Space'); await settleRender();
  check('project delete native space opts in', await evaluate(`document.querySelector('[data-delete-files-toggle]').checked && window.__UI_QA__.projectDelete.snapshot().calls.length===0 && document.querySelector('[data-delete-files-warning]').textContent.includes('permanently removed')`));
  for (const width of [360,768,1440]) {
    await viewport(width,900); await settleRender();
    check(`project delete exact path fits ${width}px`, await evaluate(`(() => { const e=document.querySelector('[data-delete-files-path]'), r=e.getBoundingClientRect(), d=e.closest('[role=dialog]'), b=d.getBoundingClientRect(); return e.textContent===window.__UI_QA__.projectDelete.snapshot().path && e.scrollWidth<=e.clientWidth+1 && r.left>=0 && r.right<=innerWidth+1 && b.left>=0 && b.right<=innerWidth+1; })()`));
    await screenshot(`project-delete-${width}`);
  }
  await viewport(1440,900);
  await key('Escape'); await settleRender(); await click('[data-delete-project]');
  await waitFor(`document.querySelector('[data-delete-files-toggle]')`);
  check('project delete dismiss reopen resets choice', await evaluate(`!document.querySelector('[data-delete-files-toggle]').checked && !window.__UI_QA__.projectDelete.snapshot().selection`));
  await click('[data-confirm]'); await settleRender();
  check('project delete registration only payload closes', await evaluate(`(() => {const s=window.__UI_QA__.projectDelete.snapshot(); return JSON.stringify(s.calls)==='[{"name":"delete-fixture"}]' && !document.querySelector('[data-confirm]');})()`));
  await show('screen-help'); await show('project-delete'); await waitFor(`document.querySelector('[data-delete-project]')`);
  await click('[data-delete-project]'); await waitFor(`document.querySelector('[data-delete-files-toggle]')`);
  await click('[data-delete-files-toggle]');
  await evaluate(`window.__UI_QA__.projectDelete.reject=true`);
  await click('[data-confirm]'); await waitFor(`document.querySelector('[data-delete-error]')`);
  check('project delete rejected retains dialog error selection', await evaluate(`(() => { const s=window.__UI_QA__.projectDelete.snapshot(); return s.calls.length===1 && s.calls[0].deleteFiles===true && s.target==='delete-fixture' && s.selection && document.querySelector('[data-delete-files-toggle]').checked && document.querySelector('[data-delete-error]').textContent.includes('live cwd refusal'); })()`));
  await evaluate(`window.__UI_QA__.projectDelete.reject=false`);
  await click('[data-confirm]'); await settleRender();
  check('project delete opt in payload success closes', await evaluate(`(() => { const s=window.__UI_QA__.projectDelete.snapshot(); return s.calls.length===2 && JSON.stringify(s.calls[1])==='{"name":"delete-fixture","deleteFiles":true}' && !document.querySelector('[data-confirm]') && !s.selection; })()`));
  await show('screen-help'); await show('project-delete'); await waitFor(`document.querySelector('[data-delete-project]')`);
  await click('[data-delete-project]'); await waitFor(`document.querySelector('[data-delete-files-toggle]')`); await click('[data-delete-files-toggle]');
  await evaluate(`window.__UI_QA__.projectDelete.selectSecond()`); await settleRender();
  await waitFor(`document.querySelector('[data-delete-project]')`);
  await click('[data-delete-project]'); await waitFor(`document.querySelector('[data-delete-files-toggle]')`);
  check('project delete changing project resets choice', await evaluate(`window.__UI_QA__.projectDelete.snapshot().target==='second-fixture' && !document.querySelector('[data-delete-files-toggle]').checked`));
  for (const target of ['same', 'different']) {
    for (const outcome of ['resolve', 'reject']) {
      await show('screen-help'); await show('project-delete');
      await waitFor(`document.querySelector('[data-delete-project]')`);
      await click('[data-delete-project]'); await waitFor(`document.querySelector('[data-delete-files-toggle]')`);
      await evaluate(`window.__UI_QA__.projectDelete.defer=true`);
      await click('[data-confirm]'); await waitFor(`window.__UI_QA__.projectDelete.snapshot().pending`);
      await click('[data-confirm-cancel]'); await settleRender();
      if (target === 'different') {
        await evaluate(`window.__UI_QA__.projectDelete.selectSecond()`); await settleRender();
        await waitFor(`document.querySelector('[data-delete-project]')`);
      }
      await click('[data-delete-project]'); await waitFor(`document.querySelector('[data-delete-files-toggle]')`);
      await click('[data-delete-files-toggle]');
      await evaluate(`window.__UI_QA__.projectDelete.settle(${JSON.stringify(outcome)})`); await settleRender();
      const name = target === 'same' ? 'delete-fixture' : 'second-fixture';
      check(`project delete stale ${outcome} ${target} target keeps focus identity path`, await evaluate(`(() => {
        const s=window.__UI_QA__.projectDelete.snapshot(), e=document.querySelector('[data-delete-files-toggle]');
        return s.calls.length===1 && s.target===${JSON.stringify(name)} && s.selected===${JSON.stringify(name)} && s.selection
          && !!e && e.checked && document.activeElement===e && !document.querySelector('[data-delete-error]')
          && document.querySelector('[data-delete-files-path]').textContent===${target === 'same' ? 's.path' : JSON.stringify('/synthetic/second-project')};
      })()`));
      // The new dialog still owns a subsequent response; settling A never retries it.
      await click('[data-confirm]'); await waitFor(`window.__UI_QA__.projectDelete.snapshot().pending`);
      await evaluate(`window.__UI_QA__.projectDelete.settle(${JSON.stringify(outcome)})`); await settleRender();
      check(`project delete latest ${outcome} ${target} target owns response`, await evaluate(`(() => {
        const s=window.__UI_QA__.projectDelete.snapshot();
        return s.calls.length===2 && s.calls[1].name===${JSON.stringify(name)} && s.calls[1].deleteFiles===true
          && ${outcome === 'resolve' ? "!document.querySelector('[data-confirm]') && !s.selection" : "s.selection && document.querySelector('[data-delete-error]').textContent.includes('deferred live cwd refusal')"};
      })()`));
    }
  }

}
