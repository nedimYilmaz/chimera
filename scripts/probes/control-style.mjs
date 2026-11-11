// Actual forms exercise the shared control defaults alongside their CSS modules.
export async function probeControlStyle({ viewport, show, settleRender, evaluate, check, screenshot, key }) {
  for (const width of [390, 768, 1440]) {
    await viewport(width, 900);
    for (const fixture of ['settings', 'spawn', 'native-mcp-settings', 'schedule-command', 'agent-controls']) {
      await show(fixture); await settleRender();
      if (fixture==='settings') { await evaluate("document.querySelector('[data-add-custom-provider]').click()"); await settleRender(); }
      const style = await evaluate(`(() => {
        const visible = el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
        const selects = [...document.querySelectorAll('select:not([multiple]):not([size])')].filter(visible);
        const bad = selects.filter(el => { const s=getComputedStyle(el); return s.appearance!=='none' || !s.backgroundImage.includes('svg') || parseFloat(s.paddingRight)<28 || !s.fontFamily.includes('Mono'); });
        const controls = [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]),select,textarea,button')].filter(visible);
        return { selects:selects.length, controls:controls.length, bad:bad.map(el=>({label:el.getAttribute('aria-label'),style:getComputedStyle(el).cssText})), white:controls.filter(el=>getComputedStyle(el).backgroundColor==='rgb(255, 255, 255)').length };
      })()`);
      check(`control style ${width}px ${fixture} native fields`, style.controls>0 && style.bad.length===0 && style.white===0, style);
      await key('Tab');
      const focus = await evaluate(`(() => {
        const el=[...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]),select,textarea,button')].find(el=>!el.disabled && el.getBoundingClientRect().width>0 && el.getBoundingClientRect().height>0);
        el.focus(); const s=getComputedStyle(el); return {visible:el.matches(':focus-visible'),outline:s.outlineStyle,width:s.outlineWidth,field:el.matches('input,select,textarea'),color:s.outlineColor,offset:s.outlineOffset};
      })()`);
      check(`control style ${width}px ${fixture} keyboard focus`, focus.visible && focus.outline==='solid' && focus.width===(focus.field?'1px':'2px') && (!focus.field || (focus.offset==='0px' && focus.color==='rgb(58, 65, 85)')), focus);
      await screenshot(`control-style-${fixture}-${width}`);
    }
  }
}
