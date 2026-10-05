import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Real TeamsScreen in its existing split pane, including native Tab and the
// shared overlay lifecycle. All RPC rows are fictional fixture data.
export async function probeTeamsForms({ viewport, show, waitFor, click, evaluate, settleRender, key, call, sessionId, check, screenshot, artifactDir }) {
  const tab = async () => {
    for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, sessionId);
    await settleRender();
  };
  const measure = async (selector) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}), r = el.getBoundingClientRect(), s = getComputedStyle(el);
    const ancestors = [];
    let visible = r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ps = getComputedStyle(p), b = p.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(ps.overflowX + ps.overflowY)) {
        const bounds = {left: b.left + p.clientLeft, right: b.left + p.clientLeft + p.clientWidth, top: b.top + p.clientTop, bottom: b.top + p.clientTop + p.clientHeight};
        if (/(auto|scroll|hidden|clip)/.test(ps.overflowX)) visible &&= r.left >= bounds.left - 1 && r.right <= bounds.right + 1;
        if (/(auto|scroll|hidden|clip)/.test(ps.overflowY)) visible &&= r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1;
        ancestors.push({className: p.className, bounds, scrollTop: p.scrollTop, clientHeight: p.clientHeight, scrollHeight: p.scrollHeight, overflowX: ps.overflowX, overflowY: ps.overflowY});
      }
    }
    return {selector: ${JSON.stringify(selector)}, rect: r.toJSON(), visible, text: el.textContent, lineHeight: parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2, ancestors};
  })()`);
  for (const mode of ['create', 'edit']) for (const width of [360, 768, 1440]) {
    const prefix = `ux26 teams form ${mode} ${width}px`;
    await viewport(width, 900);
    await show('teams-stability');
    await waitFor('window.__UI_QA__.teamStability.pending().length === 1');
    await evaluate("window.__UI_QA__.teamStability.settle(1, 'rows')");
    await waitFor("document.querySelector('[data-team-row]')");
    const opener = `[data-screen-probe] [data-action-chip]:nth-child(${mode === 'create' ? 1 : 2})`;
    await evaluate(`window.__teamsFormOpener = document.querySelector(${JSON.stringify(opener)}); window.__teamsFormOpener.focus()`);
    await click(opener);
    await waitFor("document.querySelector('[data-team-role-advanced]')");
    const card = await measure('[role="dialog"]');
    const controls = await evaluate(`Array.from(document.querySelector('[role="dialog"]').querySelectorAll('input,select,button')).map((el, i) => {el.dataset.teamsProbeControl = String(i); return {selector: '[data-teams-probe-control="' + i + '"]', disabled: el.disabled, field: el.dataset.field || (el.dataset.pathPicker ? 'cwd' : null)};})`);
    const evidence = {mode, width, card, controls: [], labels: []};
    for (const control of controls) {
      await evaluate(`document.querySelector(${JSON.stringify(control.selector)}).scrollIntoView({block:'nearest', inline:'nearest'})`);
      await settleRender();
      evidence.controls.push({...control, ...await measure(control.selector)});
    }
    const labels = await evaluate(`Array.from(document.querySelector('[role="dialog"]').querySelectorAll('[class*="label"],[data-team-role-advanced]')).map((el, i) => {el.dataset.teamsProbeLabel = String(i); return '[data-teams-probe-label="' + i + '"]';})`);
    for (const label of labels) {
      await evaluate(`document.querySelector(${JSON.stringify(label)}).scrollIntoView({block:'nearest', inline:'nearest'})`);
      await settleRender();
      evidence.labels.push(await measure(label));
    }
    check(`${prefix} labels fields and actions are readable`, evidence.controls.every(c => c.visible && (!c.field || c.rect.width >= 100)) && evidence.labels.every(l => l.visible && l.rect.height <= l.lineHeight * 2 + 2) && await evaluate('document.documentElement.scrollWidth <= innerWidth'), evidence);
    // The bounds audit scrolled without moving focus. Enter the form with a
    // native Tab so Chromium actually reveals the first field, even if that
    // input retained autofocus while the audit inspected the lower labels.
    await evaluate("document.querySelector('[role=dialog]').focus()");
    await tab();
    const reached = [], keyboardBounds = [];
    for (let i = 0; i < controls.length + 2; i++) {
      const active = await evaluate("document.activeElement?.dataset.teamsProbeControl ?? null");
      if (active !== null && !reached.includes(active)) {
        reached.push(active);
        keyboardBounds.push(await measure(`[data-teams-probe-control="${active}"]`));
      }
      await tab();
    }
    evidence.keyboardBounds = keyboardBounds;
    check(`${prefix} all enabled fields are keyboard reachable`, controls.filter(c => !c.disabled).every(c => reached.includes(c.selector.match(/"(\d+)"/)[1])) && keyboardBounds.every(c => c.visible), {reached, keyboardBounds, controls});
    await evaluate("window.__teamsFormDraft = document.querySelector('[data-field=purpose]'); window.__teamsFormDraft.focus()");
    await call('Input.insertText', {text: 'preserved-fictional-draft'}, sessionId);
    const draft = await evaluate('window.__teamsFormDraft.value');
    await viewport(width === 768 ? 360 : 768, 900);
    await viewport(width, 900);
    await evaluate('window.__UI_QA__.teamStability.refresh()');
    await waitFor('window.__UI_QA__.teamStability.pending().length === 1');
    const pending = await evaluate('window.__UI_QA__.teamStability.pending()[0]');
    await evaluate(`window.__UI_QA__.teamStability.settle(${pending}, 'large')`);
    await settleRender();
    check(`${prefix} resize and refresh preserve draft identity`, await evaluate(`window.__teamsFormDraft === document.querySelector('[data-field=purpose]') && window.__teamsFormDraft.value === ${JSON.stringify(draft)}`));
    await evaluate("document.querySelector('[data-team-role-advanced]').scrollIntoView({block:'center'})");
    await screenshot(`ux26-teams-form-${mode}-${width}`);
    if (artifactDir) writeFileSync(join(artifactDir, `ux26-teams-form-${mode}-${width}.json`), JSON.stringify(evidence, null, 2));
    await evaluate('window.__teamsFormDraft.focus()');
    await key('Escape');
    await waitFor("document.querySelectorAll('[role=dialog]').length === 2");
    await key('Escape');
    await waitFor("document.querySelectorAll('[role=dialog]').length === 1");
    check(`${prefix} escape dismisses topmost confirmation and keeps draft`, await evaluate(`window.__teamsFormDraft.value === ${JSON.stringify(draft)} && document.activeElement === window.__teamsFormDraft`));
    await key('Escape');
    await waitFor("document.querySelector('[data-confirm]')");
    await click('[data-confirm]');
    await waitFor("!document.querySelector('[role=dialog]')");
    await settleRender();
    check(`${prefix} close restores connected opener`, await evaluate('document.activeElement === window.__teamsFormOpener'));
    await click(opener);
    await waitFor("document.querySelector('[data-team-submit]')");
    await evaluate('window.__UI_QA__.stability.overlay()');
    await waitFor("!document.querySelector('[data-team-submit]')");
    check(`${prefix} reducer overlay dismisses registered form`, await evaluate("!document.querySelector('[data-team-submit]')"));
    await evaluate("window.__UI_QA__.teamStability.dismissForm()");
    await settleRender();
  }
}
