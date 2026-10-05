export async function probeCompactHeader({ viewport, show, settleRender, waitFor, evaluate, check, screenshot, click, buttonKey, key, pointerPoint, call, sessionId, layoutAudit }) {
  for (const [width, baseline] of [[360,320], [768,176], [1440,112]]) {
    await viewport(width,800); await show("metrics"); await settleRender();
    await waitFor("document.querySelector('[data-resource-summary]').textContent.includes('300 MiB')");
    const headerHeight = await evaluate("document.querySelector('[data-transcript-header]').getBoundingClientRect().height");
    check(`compact header ${width}px reduces baseline height`, headerHeight < baseline * 0.8, { headerHeight, baseline });
    const remaining = await evaluate("document.querySelector('[data-metrics-body]').getBoundingClientRect().height");
    const baselineRemaining = remaining - (baseline - headerHeight);
    check(`compact header ${width}px increases remaining transcript viewport`, remaining > baselineRemaining && remaining >= 400, { remaining, baselineRemaining, gained: baseline - headerHeight });
    await screenshot(`header-after-${width}`);
    await click('[data-metrics-long-model]');
    const summary = '[data-transcript-metrics] summary';
    await evaluate(`document.querySelector(${JSON.stringify(summary)}).focus()`);
    await buttonKey("Enter", "Enter"); await waitFor("document.querySelector('[data-transcript-metrics]').open");
    await waitFor("document.querySelector('[data-transcript-metrics] [data-host-admission]')");
    await settleRender();
    check(`compact header ${width}px keyboard reveals bounded details`, await evaluate(`(() => { const d=document.querySelector('[data-transcript-metrics]'); const p=d.querySelector('[aria-label="Transcript metric details"]');return d.open && p.clientHeight <= 240 && d.textContent.includes('CPU uses two samples') && d.textContent.includes('Active session') && d.textContent.includes('cache read'); })()`));
    await evaluate("document.querySelector('[data-transcript-metrics] [aria-label=\"Transcript metric details\"]').focus()");
    await key("Escape"); await settleRender();
    check(`compact header ${width}px Escape restores summary focus`, await evaluate(`!document.querySelector('[data-transcript-metrics]').open && document.activeElement.matches('[data-transcript-metrics] summary')`));
    const touch = await pointerPoint(summary);
    await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touch.x, y: touch.y }] }, sessionId);
    await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sessionId);
    await waitFor("document.querySelector('[data-transcript-metrics]').open");
    check(`compact header ${width}px touch reveals details`, await evaluate(`document.querySelector('[data-transcript-metrics]').open`));
    await key("Escape");
    await evaluate(`(() => { const b=document.querySelector('[data-metrics-body]'); b.scrollTop=300; const c=document.querySelector('[data-metrics-composer]'); c.value='retained draft'; c.focus(); c.setSelectionRange(2,6); window.__headerScroll=b.scrollTop; })()`);
    await evaluate("document.querySelector('[data-metrics-update]').click()"); await settleRender();
    check(`compact header ${width}px live metrics preserve draft selection scroll`, await evaluate(`(() => { const c=document.querySelector('[data-metrics-composer]');return c.value==='retained draft' && c.selectionStart===2 && c.selectionEnd===6 && document.activeElement===c && document.querySelector('[data-metrics-body]').scrollTop===window.__headerScroll; })()`));
    await click(summary); await settleRender();
    const audit = await layoutAudit();
    const reach = await evaluate(`(() => { const c=document.querySelector('[data-metrics-composer]');const r=c.getBoundingClientRect();return r.top >= document.querySelector('[data-transcript-header]').getBoundingClientRect().bottom && r.bottom<=innerHeight && document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===c; })()`);
    check(`compact header ${width}px long model counters no overflow composer reachable`, audit.overflowing.length===0 && audit.pageWidth<=width && reach, audit);
    await screenshot(`header-details-${width}`);
    console.log(`Compact header ${width}px: ${headerHeight}px (baseline ${baseline}px), transcript ${remaining}px vs ${baselineRemaining}px with identical fixed chrome`);
  }

}
