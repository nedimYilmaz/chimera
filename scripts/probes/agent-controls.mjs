export async function probeAgentControls({ viewport, show, settleRender, evaluate, check, click, waitFor, screenshot, key }) {
  for (const width of [390, 768, 1440]) {
    await viewport(width, 900); await show("agent-controls"); await settleRender();
    await waitFor("document.querySelector('[data-agent-row=controls-a] [data-agent-action=\"agents.hold\"]')");
    check(`agent controls ${width}px snapshot model and effort visible`, await evaluate(`document.querySelector('[data-agent-control-bar] [data-transcript-action="system.model"]').textContent.includes('gpt-6-astra') && document.querySelector('[data-agent-control-bar] [data-transcript-action="system.effort"]').textContent.includes('high')`));
    await evaluate("window.__UI_QA__.agentControls.select('controls-b')"); await settleRender();
    check(`agent controls ${width}px selection updates model and effort`, await evaluate(`document.querySelector('[data-agent-control-bar] [data-transcript-action="system.model"]').textContent.includes('gpt-6.1-sol') && document.querySelector('[data-agent-control-bar] [data-transcript-action="system.effort"]').textContent.includes('low')`));
    await evaluate("window.__UI_QA__.agentControls.select('controls-a'); window.__UI_QA__.agentControls.records=window.__UI_QA__.agentControls.records.map(r=>r.agentId==='controls-a'?{...r,actualModel:'updated-model',spec:{...r.spec,effort:'xhigh'}}:r);window.__UI_QA__.agentControls.publish()"); await settleRender();
    check(`agent controls ${width}px refreshed model and effort visible`, await evaluate(`document.querySelector('[data-agent-control-bar] [data-transcript-action="system.model"]').textContent.includes('updated-model') && document.querySelector('[data-agent-control-bar] [data-transcript-action="system.effort"]').textContent.includes('xhigh')`));
    await evaluate("window.__UI_QA__.agentControls.records=window.__UI_QA__.agentControls.records.map(r=>r.agentId==='controls-a'?{...r,actualModel:'gpt-6-astra',spec:{...r.spec,effort:'high'}}:r);window.__UI_QA__.agentControls.publish()"); await settleRender();
    check(`inspector layout ${width}px compact resource search row`, await evaluate(`(() => {
      const h=document.querySelector('[data-transcript-header]'), search=h.querySelector('[data-transcript-search-bar]'), resources=h.querySelector('[data-resource-summary]');
      const a=search.getBoundingClientRect(), b=resources.getBoundingClientRect();
      return !h.querySelector('[data-execution-mode]') && !h.querySelector('[data-permission-tone]') && (h.clientWidth<600 || (a.top<b.bottom && b.top<a.bottom)) && a.right<=innerWidth;
    })()`));
    check(`agent controls ${width}px terminal follows composer`, await evaluate(`!!(document.querySelector('[data-composer]').compareDocumentPosition(document.querySelector('[data-terminal-dock]')) & Node.DOCUMENT_POSITION_FOLLOWING)`));
    await screenshot(`toolbar-before-${width}`);
    const barAudit = await evaluate(`(() => {
      const bar=document.querySelector('[data-agent-control-bar]'), input=document.querySelector('[data-composer]');
      const b=bar.getBoundingClientRect(), i=input.getBoundingClientRect();
      const h=document.querySelector('[data-transcript-header]').getBoundingClientRect();
      const buttons=Array.from(bar.querySelectorAll('[data-conversation-actions] > button'));
      const icons=buttons.map(x=>x.getBoundingClientRect());
      const sizes=buttons.every(x=>{
        const r=x.getBoundingClientRect(), picker=x.matches('[data-transcript-action="system.model"],[data-transcript-action="system.effort"]');
        const minimum=picker ? Math.max(28,parseFloat(getComputedStyle(x).getPropertyValue('--control-h'))) : 30;
        return r.width>=30 && r.height>=minimum;
      });
      return {above:b.bottom<=i.top, joined:i.top-b.bottom<24, headerAbove:h.bottom<b.top, belowTop:b.top>150, fits:b.right<=innerWidth, oneHeader:document.querySelectorAll('[data-transcript-header]').length===1, noHeader:!bar.querySelector('[data-transcript-header]'), noDetail:!bar.querySelector('[data-agent-detail-toggle]'), noLifecycle:!bar.querySelector('[data-agent-lifecycle]'), remote:!!bar.querySelector('[data-transcript-action="system.remoteControl"]'), sizes, left:icons[0].left<b.left+240};
    })()`);
    check(`agent controls ${width}px bar above input`, Object.values(barAudit).every(Boolean), barAudit);
    check(`agent controls ${width}px concise voice and draft`, await evaluate(`(() => {
      const bar=document.querySelector('[data-composer]');
      return Array.from(bar.querySelectorAll('button')).some(b=>b.textContent==='◉ Voice') && !bar.textContent.includes('hold to talk') && !document.body.textContent.includes('native Codex voice') && !document.body.textContent.includes('grows with content') && document.querySelector('[data-compose-input]').value==='Retained draft';
    })()`));
    await click('[data-agent-control-bar] [aria-label="Show voice history"]'); await settleRender();
    check(`agent controls ${width}px voice history opens from bar`, await evaluate(`!!document.querySelector('[data-agent-control-bar] [aria-label="Hide voice history"]')`));
    await click('[data-agent-control-bar] [aria-label="Hide voice history"]');
    await click('[data-agent-row=controls-a] [data-agent-action="agents.hold"]');
    await screenshot(`toolbar-after-hold-${width}`);
    await waitFor("document.querySelector('[data-agent-row=controls-a] [data-agent-action=\"agents.resume\"]')");
    check(`agent controls ${width}px hold targets selected and keeps draft`, await evaluate(`(() => {
      const s=window.__UI_QA__.agentControls.snapshot(), call=s.calls.at(-1);
      return call.method==='agent.hold' && JSON.stringify(call.params.agentIds)==='["controls-a"]' && s.draft==='Retained draft' && !document.querySelector('[data-screen-probe=agents]').textContent.includes('held by you — release to resume');
    })()`));
    await click('[data-agent-row=controls-a] [data-agent-action="agents.resume"]');
    await waitFor("document.querySelector('[data-agent-row=controls-a] [data-agent-action=\"agents.hold\"]')");
    check(`agent controls ${width}px resume releases same agent`, await evaluate(`window.__UI_QA__.agentControls.snapshot().calls.at(-1).method==='agent.release' && window.__UI_QA__.agentControls.snapshot().calls.length===2`));
    await evaluate("window.__UI_QA__.agentControls.connected(false)"); await settleRender();
    check(`agent controls ${width}px disconnected disables hold`, await evaluate("document.querySelector('[data-agent-row=controls-a] [data-agent-action=\"agents.hold\"]').disabled"));
    await evaluate("window.__UI_QA__.agentControls.connected(true); window.__UI_QA__.agentControls.select('controls-b')"); await settleRender();
    await click('[data-agent-row=controls-b] [data-agent-action="agents.hold"]');
    await waitFor("document.querySelector('[data-agent-row=controls-b] [data-agent-action=\"agents.resume\"]')");
    check(`agent controls ${width}px selection switches action target`, await evaluate(`JSON.stringify(window.__UI_QA__.agentControls.snapshot().calls.at(-1).params.agentIds)==='["controls-b"]'`));
    await screenshot(`agent-controls-${width}`);
    await show("agent-controls"); await settleRender();
    check(`composer commands ${width}px leading permission select`, await evaluate(`(() => {
      const h=document.querySelector('[data-agent-control-bar]');
      return h.querySelector('[data-conversation-actions]').firstElementChild.hasAttribute('data-agent-permission') && !!h.querySelector('select[aria-label="Execution mode"]');
    })()`));
    await evaluate(`(() => {const s=document.querySelector('[aria-label="Execution mode"]');s.value='auto';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor("document.querySelector('[aria-label=\"Execution mode\"]').value==='auto' && !document.querySelector('[aria-label=\"Execution mode\"]').disabled");
    check(`composer commands ${width}px mode applies only selected agent`, await evaluate(`(() => {
      const c=window.__UI_QA__.agentControls.snapshot().calls.at(-1);
      return c.method==='agent.reconfigure' && c.params.agentId==='controls-a' && JSON.stringify(c.params.live)==='{"executionMode":"auto"}' && !c.params.patch;
    })()`));
    await evaluate(`window.__UI_QA__.agentControls.failPermission=true; (()=>{const s=document.querySelector('[aria-label="Execution mode"]');s.value='plan';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor("document.querySelector('[data-agent-permission] [role=alert]')");
    check(`composer commands ${width}px rejected permission retains actual value`, await evaluate(`document.querySelector('[aria-label="Execution mode"]').value==='auto' && document.querySelector('[data-agent-permission]').textContent.includes('refused') && !document.querySelector('[data-agent-control-bar] [data-agent-detail-toggle]')`));
    await evaluate(`window.__UI_QA__.agentControls.draft('! printf synthetic');`); await settleRender();
    await click('[data-compose-input]'); await key('Enter');
    await waitFor("document.querySelector('[data-operator-shell]')?.textContent.includes('running')");
    check(`composer commands ${width}px bang executes without agent send`, await evaluate(`(() => {
      const s=window.__UI_QA__.agentControls.snapshot(), c=s.calls.at(-1);
      return c.method==='agent.shellStart' && c.params.command==='printf synthetic' && c.params.agentId==='controls-a' && s.draft==='' && !s.calls.some(x=>x.method==='agent.send');
    })()`));
    await evaluate(`window.__UI_QA__.agentControls.finishShell('controls-a')`);
    await waitFor("document.querySelector('[data-operator-shell]')?.textContent.includes('exit 0')");
    check(`composer commands ${width}px output stays in conversation`, await evaluate(`document.querySelector('[data-operator-shell]').textContent.includes('synthetic Bash output')`));
    await evaluate(`window.__UI_QA__.agentControls.failShellAck=true;window.__UI_QA__.agentControls.draft('! echo lost-ack');`); await settleRender();
    await click('[data-compose-input]'); await key('Enter'); await settleRender();
    check(`composer commands ${width}px lost ack preserves draft`, await evaluate(`window.__UI_QA__.agentControls.snapshot().draft==='! echo lost-ack'`));
    await key('Enter'); await settleRender();
    check(`composer commands ${width}px retry reuses command identity`, await evaluate(`(() => {const c=window.__UI_QA__.agentControls.snapshot().calls.filter(c=>c.method==='agent.shellStart');return c.length===3 && c[1].params.requestId===c[2].params.requestId;})()`));
    await evaluate(`Array.from(document.querySelectorAll('[data-operator-shell] button')).find(b=>b.textContent==='Cancel command').click()`);
    await waitFor("document.querySelector('[data-operator-shell]')?.textContent.includes('cancelled')");
    check(`composer commands ${width}px cancellation targets running command`, await evaluate(`window.__UI_QA__.agentControls.snapshot().calls.at(-1).method==='agent.shellCancel'`));
    await screenshot(`composer-shell-permission-${width}`);
    await show("agent-controls"); await settleRender();
    await evaluate("window.__UI_QA__.agentControls.claude()");
    await waitFor("document.querySelector('[aria-label=\"Execution mode\"]')?.value==='auto'");
    check(`composer commands ${width}px Claude exposes native modes`, await evaluate(`(() => {
      const s=document.querySelector('[aria-label="Execution mode"]');
      return JSON.stringify(Array.from(s.options).map(o=>o.value))==='["auto","plan","bypassPermissions"]';
    })()`));
    for (const mode of ["plan", "bypassPermissions", "auto"]) {
      await evaluate(`(() => {const s=document.querySelector('[aria-label="Execution mode"]');s.value=${JSON.stringify(mode)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await waitFor(`document.querySelector('[aria-label="Execution mode"]').value===${JSON.stringify(mode)} && !document.querySelector('[aria-label="Execution mode"]').disabled`);
    }
    check(`composer commands ${width}px Claude applies native mode only`, await evaluate(`(() => {
      const s=window.__UI_QA__.agentControls.snapshot();
      return s.calls.length===3 && s.calls.every((c,i)=>c.method==='agent.reconfigure' && c.params.agentId==='controls-a' && !c.params.patch && JSON.stringify(c.params.live)===JSON.stringify({executionMode:['plan','bypassPermissions','auto'][i]})) && s.draft==='Retained draft';
    })()`));
    await evaluate(`window.__UI_QA__.agentControls.failPermission=true; (() => {const s=document.querySelector('[aria-label="Execution mode"]');s.value='bypassPermissions';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor("document.querySelector('[data-agent-permission] [role=alert]')");
    check(`composer commands ${width}px Claude refusal preserves Auto`, await evaluate(`document.querySelector('[aria-label="Execution mode"]').value==='auto' && document.querySelector('[data-agent-permission]').textContent.includes('refused')`));
    await screenshot(`claude-native-mode-${width}`);
    for (const provider of ["kimi", "openai", "gemini", "custom-api"]) {
      await evaluate(`window.__UI_QA__.agentControls.failPermission=false; window.__UI_QA__.agentControls.provider(${JSON.stringify(provider)})`);
      await waitFor("document.querySelector('[aria-label=\"Execution mode\"]').value==='auto'");
      const mode = provider === "kimi" ? "bypassPermissions" : "plan";
      await evaluate(`(() => {const s=document.querySelector('[aria-label="Execution mode"]');s.value=${JSON.stringify(mode)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await waitFor(`!document.querySelector('[aria-label="Execution mode"]').disabled && document.querySelector('[aria-label="Execution mode"]').value===${JSON.stringify(mode)}`);
      check(`composer commands ${width}px ${provider} mode applies`, await evaluate(`(() => {
        const s=document.querySelector('[aria-label="Execution mode"]'), c=window.__UI_QA__.agentControls.snapshot().calls.at(-1);
        return c.params.live.executionMode===${JSON.stringify(mode)} && c.params.agentId==='controls-a' && !c.params.patch && (${JSON.stringify(provider)}!=='kimi' || !Array.from(s.options).some(o=>o.value==='plan'));
      })()`));
    }
    await evaluate("window.__UI_QA__.agentControls.provider('codex'); window.__UI_QA__.agentControls.deferMode=true");
    await waitFor("document.querySelector('[aria-label=\"Execution mode\"]').value==='auto'");
    await evaluate(`(() => {const s=document.querySelector('[aria-label="Execution mode"]');s.value='bypassPermissions';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor("document.querySelector('[data-agent-permission] [role=status]')");
    check(`composer commands ${width}px Codex pending grant visible`, await evaluate(`(() => {
      const c=window.__UI_QA__.agentControls.snapshot().calls.at(-1);
      return c.params.live.executionMode==='bypassPermissions' && c.params.patch.acknowledgeCodexFullAccessRisk===true && document.querySelector('[data-agent-permission] select').getAttribute('aria-busy')==='true';
    })()`));
    check(`composer commands ${width}px mode pending spinner only`, await evaluate(`(() => {
      const root=document.querySelector('[data-agent-permission]'), spinner=root.querySelector('[role=status]');
      return root.querySelector('select').getAttribute('aria-busy')==='true' && spinner.textContent==='' && spinner.getAttribute('aria-label')==='Applying execution mode' && getComputedStyle(spinner).animationName!=='none' && !root.textContent.includes('Next turn') && !root.textContent.includes('Applying');
    })()`));
    await screenshot(`provider-mode-pending-${width}`);
    await evaluate("window.__UI_QA__.agentControls.deferMode=false; window.__UI_QA__.agentControls.records=window.__UI_QA__.agentControls.records.map(r=>({...r,executionMode:'bypassPermissions',executionModePending:false}));window.__UI_QA__.agentControls.publish()");
    await waitFor("!document.querySelector('[data-agent-permission] [role=status]')");
    check(`composer commands ${width}px applied mode clears spinner`, await evaluate(`document.querySelector('[aria-label="Execution mode"]').getAttribute('aria-busy')==='false'`));
    for (const [mode, token] of [['auto','--mode-auto'],['plan','--info'],['bypassPermissions','--danger']]) {
      await evaluate(`window.__UI_QA__.agentControls.records=window.__UI_QA__.agentControls.records.map(r=>({...r,executionMode:${JSON.stringify(mode)},executionModePending:false}));window.__UI_QA__.agentControls.publish()`); await settleRender();
      check(`composer commands ${width}px ${mode} semantic color`, await evaluate(`(() => {
        const s=document.querySelector('[aria-label="Execution mode"]'), probe=document.createElement('span');probe.style.color='var(${token})';document.body.append(probe);const color=getComputedStyle(probe).color;probe.remove();
        return s.value==='${mode}' && getComputedStyle(s).color===color && !document.querySelector('[data-agent-permission] [role=status]');
      })()`));
    }
    await show("agent-controls"); await settleRender();
    await click('[data-agent-control-bar] [aria-label="Show voice history"]');
    await settleRender();
    check(`toolbar toggles ${width}px voice active styling`, await evaluate(`(() => {
      const b=document.querySelector('[aria-label="Hide voice history"]'), c=getComputedStyle(b);
      return b.getAttribute('aria-pressed')==='true' && c.boxShadow!=='none' && c.backgroundColor!==getComputedStyle(document.querySelector('[aria-label="toggle terminal"]')).backgroundColor;
    })()`));
    await evaluate("document.querySelector('[data-agent-control-bar]').scrollIntoView({block:'center'})");
    await screenshot(`toolbar-active-${width}`);
    await click('[aria-label="Hide voice history"]'); await settleRender();
    check(`toolbar toggles ${width}px voice closes and clears`, await evaluate(`(() => {
      const b=document.querySelector('[aria-label="Show voice history"]');
      return b.getAttribute('aria-pressed')==='false' && getComputedStyle(b).boxShadow==='none';
    })()`));
    await evaluate("window.__UI_QA__.agentControls.remote(false,'disabled')"); await settleRender();
    await click('[data-agent-control-bar] [aria-label="remote control"]'); await settleRender();
    check(`toolbar toggles ${width}px remote panel active`, await evaluate(`(() => {
      const b=document.querySelector('[data-agent-control-bar] [aria-label="remote control"]');
      const r=b.getBoundingClientRect(), hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
      return !b.hasAttribute('aria-expanded') && !document.querySelector('[data-remote-control-toggle]') && window.__UI_QA__.agentControls.snapshot().calls.at(-1).params.enable===true && b.getAttribute('aria-pressed')==='true' && getComputedStyle(b).boxShadow!=='none' && (hit===b || b.contains(hit));
    })()`));
    await click('[data-agent-control-bar] [aria-label="remote control"]'); await settleRender();
    check(`toolbar toggles ${width}px remote panel closes`, await evaluate(`document.querySelector('[data-agent-control-bar] [aria-label="remote control"]').getAttribute('aria-pressed')==='false'`));
    await evaluate("window.__UI_QA__.agentControls.failRemote=true");
    await click('[data-agent-control-bar] [aria-label="remote control"]'); await settleRender();
    check(`toolbar toggles ${width}px remote rejection preserves state`, await evaluate(`document.querySelector('[aria-label="remote control"]').getAttribute('aria-pressed')==='false' && document.querySelector('[aria-label="remote control"]').getAttribute('aria-busy')==='false' && !document.querySelector('[data-remote-control-toggle]')`));
    await evaluate("window.__UI_QA__.agentControls.failRemote=false");
    await evaluate("window.__UI_QA__.agentControls.remote(true,'connected')"); await settleRender();
    check(`toolbar toggles ${width}px remote connection stays visible`, await evaluate(`(() => {
      const b=document.querySelector('[data-agent-control-bar] [aria-label="remote control"]');
      return b.getAttribute('aria-pressed')==='true' && !b.hasAttribute('aria-expanded');
    })()`));
    await evaluate("window.__UI_QA__.agentControls.remote(true,'errored')"); await settleRender();
    check(`toolbar toggles ${width}px remote failure not active`, await evaluate(`document.querySelector('[data-agent-control-bar] [aria-label="remote control"]').getAttribute('aria-pressed')==='false'`));
    for (const [percent,tone] of [[40,'normal'],[75,'warning'],[95,'danger']]) {
      await evaluate(`window.__UI_QA__.agentControls.context(${percent})`); await settleRender();
      check(`inspector layout ${width}px context ${tone} excludes output`, await evaluate(`(() => {const r=document.querySelector('[data-context-ring]');return r.getAttribute('aria-valuenow')==='${percent}' && r.dataset.tone==='${tone}' && r.textContent.includes('${percent}%');})()`));
    }
    await click('[aria-label="compact context now"]'); await settleRender();
    check(`toolbar toggles ${width}px context ring triggers selected compaction`, await evaluate(`(() => {
      const b=document.querySelector('[aria-label="compact context now"]'), c=window.__UI_QA__.agentControls.snapshot().calls.at(-1);
      return !!b.querySelector('[data-context-ring]') && !document.querySelector('[data-conversation-actions] [data-transcript-action="system.compact"]') && c.method==='agent.compact' && c.params.agentId==='controls-a';
    })()`));
    check(`toolbar toggles ${width}px compact busy prevents repeat`, await evaluate(`(() => {
      const b=document.querySelector('[aria-label="compact context now"]');
      return b.disabled && b.getAttribute('aria-busy')==='true' && b.querySelector('[data-context-ring]').dataset.tone==='compacting' && getComputedStyle(b).opacity==='1';
    })()`));
    check(`inspector layout ${width}px compaction ring and green edge`, await evaluate(`(() => {
      const r=document.querySelector('[data-context-ring]'), glow=document.querySelector('[data-stream-glow][data-compacting=true]');
      const spinner=r.querySelector('svg circle:last-child');
      const green=getComputedStyle(document.documentElement).getPropertyValue('--success').trim();
      const sample=document.createElement('span');sample.style.color=green;document.body.append(sample);const rgb=getComputedStyle(sample).color;sample.remove();
      return r.getAttribute('aria-busy')==='true' && r.dataset.tone==='compacting' && getComputedStyle(spinner).animationName!=='none' && !!glow && getComputedStyle(glow.firstElementChild).backgroundImage.includes(rgb);
    })()`));
    await screenshot(`composer-compacting-${width}`);
    await evaluate("window.__UI_QA__.agentControls.compaction(false)"); await settleRender();
    check(`inspector layout ${width}px compaction ring settles`, await evaluate(`document.querySelector('[data-context-ring]').getAttribute('aria-busy')==='false' && !document.querySelector('[data-stream-glow][data-compacting=true]')`));
    check(`toolbar toggles ${width}px compact completion clears`, await evaluate(`(() => {
      const b=document.querySelector('[aria-label="compact context now"]');
      return !b.disabled && b.getAttribute('aria-busy')==='false' && getComputedStyle(b).boxShadow==='none';
    })()`));

    await show("agent-controls"); await settleRender();
    await waitFor("document.querySelector('[data-checkpoint-strip]')?.textContent.includes('cp-12')");
    check(`inspector layout ${width}px inline search and no duplicate state`, await evaluate(`(() => {
      const h=document.querySelector('[data-transcript-header]');
      return !!h.querySelector('[data-transcript-search]') && !h.querySelector('[class*="stateChip"]') && !document.querySelector('[data-transcript-search-toggle]');
    })()`));
    await evaluate(`(() => {const i=document.querySelector('[data-transcript-search]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'history query');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor("window.__UI_QA__.agentControls.snapshot().calls.some(c=>c.method==='events.search')");
    check(`inspector layout ${width}px search scopes current agent`, await evaluate(`(() => {
      const c=window.__UI_QA__.agentControls.snapshot().calls.find(c=>c.method==='events.search');
      return c.params.query==='history query' && JSON.stringify(c.params.scope.agentIds)==='["controls-a"]';
    })()`));
    await click('[aria-label="clear search"]');
    await click('#inspector-design-tab'); await settleRender();
    check(`inspector layout ${width}px design tab switches`, await evaluate(`document.querySelectorAll('[aria-label="Inspector view"] [role=tab]').length===2 && document.querySelector('#inspector-design-tab').getAttribute('aria-selected')==='true' && document.querySelector('#inspector-conversation').hidden`));
    await click('#inspector-conversation-tab'); await settleRender();
    check(`inspector layout ${width}px transcript and draft retained`, await evaluate(`document.querySelector('#inspector-conversation-tab').getAttribute('aria-selected')==='true' && !document.querySelector('#inspector-conversation').hidden && document.querySelector('[data-compose-input]').value==='Retained draft'`));
    await evaluate("document.querySelector('[data-agent-list-heading]').scrollIntoView({block:'center'})");
    check(`inspector layout ${width}px roster icon bar`, await evaluate(`(() => {
      const h=document.querySelector('[data-agent-list-heading]'), b=Array.from(h.querySelectorAll('button')), input=document.querySelector('[data-agents-search]');
      const toolbar=h.querySelector('[role=toolbar]'), summary=h.firstElementChild, spawn=h.querySelector('[data-agent-action="agents.spawnDefault"]');
      const options=h.querySelector('[data-agent-action="agents.spawn"]'), group=spawn.parentElement;
      return group===toolbar.lastElementChild && options.parentElement===group && Math.abs(group.getBoundingClientRect().right-(toolbar.getBoundingClientRect().right-parseFloat(getComputedStyle(toolbar).paddingRight)))<1 && toolbar.getBoundingClientRect().top>=summary.getBoundingClientRect().bottom && getComputedStyle(spawn).getPropertyValue('--action-tone').trim()===getComputedStyle(document.documentElement).getPropertyValue('--info').trim() && b.length>=3 && b.every(x=>x.querySelector('svg') && x.getBoundingClientRect().width>=30 && getComputedStyle(x).borderRadius==='50%') && !input.parentElement.querySelector('button') && h.getBoundingClientRect().right<=innerWidth;
    })()`));
    await screenshot(`inspector-roster-${width}`);
    await evaluate("document.querySelector('[data-agent-control-bar]').scrollIntoView({block:'center'})");
    check(`inspector layout ${width}px joined composer and checkpoint`, await evaluate(`(() => {
      const b=document.querySelector('[data-agent-control-bar]'), i=document.querySelector('[data-composer]'), cp=b.querySelector('[data-checkpoint-strip]');
      const mode=b.querySelector('[data-agent-permission] select').getBoundingClientRect(), target=i.querySelector('[data-target-chip]').getBoundingClientRect();
      return Math.abs(mode.left-target.left)<1 && Math.abs(mode.height-target.height)<1 && Math.abs(mode.width-target.width)<1 && !i.querySelector('[data-target-chip]').textContent.includes('→') && b.parentElement===i.parentElement && i.getBoundingClientRect().top-b.getBoundingClientRect().bottom<=1 && cp?.tagName==='BUTTON' && cp.textContent.includes('cp-12');
    })()`));
    await click('[data-checkpoint-strip]');
    await waitFor("document.querySelector('[data-checkpoints-card]')");
    check(`inspector layout ${width}px checkpoint opens panel`, await evaluate(`document.querySelector('[data-checkpoint-strip]').getAttribute('aria-expanded')==='true' && document.querySelector('[data-checkpoints-card]').textContent.includes('cp-12')`));
    await click('[data-checkpoint-strip]'); await settleRender();
    await evaluate("window.__UI_QA__.agentControls.checkpoint('13')");
    await waitFor("document.querySelector('[data-checkpoint-strip]')?.textContent.includes('cp-13')");
    check(`inspector layout ${width}px checkpoint updates live`, await evaluate(`!document.querySelector('[data-checkpoints-card]') && document.querySelector('[data-checkpoint-strip]').getAttribute('aria-expanded')==='false'`));
    await evaluate("window.__UI_QA__.agentControls.connected(true)"); await settleRender();
    check(`inspector layout ${width}px moved controls and ring alignment`, await evaluate(`(() => {
      const bar=document.querySelector('[data-agent-control-bar]'), header=document.querySelector('[data-transcript-header]'), ring=bar.querySelector('[data-context-ring]');
      const controls=bar.querySelector('[data-conversation-actions]');
      return !!controls.querySelector('[aria-label^="Change model"]') && !!controls.querySelector('[aria-label^="Change effort"]') && !!controls.querySelector('[aria-label="Agent settings"]') && !!controls.querySelector('[aria-label="Branch conversation"]') && !header.querySelector('[aria-label^="Change model"]') && !header.querySelector('[aria-label="Agent settings"]') && !header.querySelector('[data-context-meter]') && Math.abs(ring.getBoundingClientRect().right-(bar.getBoundingClientRect().right-parseFloat(getComputedStyle(bar).paddingRight)))<2;
    })()`));
    for (const [label, content] of [['Change model','change model'],['Change effort','change effort'],['Agent settings','settings']]) {
      await click(`[data-agent-control-bar] [aria-label^="${label}"]`); await settleRender();
      await screenshot(`composer-${content.replaceAll(' ','-')}-${width}`);
      check(`inspector layout ${width}px ${content} opens from composer`, await evaluate(`Array.from(document.querySelectorAll('[role=dialog]')).some(d=>d.textContent.toLowerCase().includes(${JSON.stringify(content)}))`));
      await click('[role=dialog] input');
      await key('Escape'); await waitFor("!document.querySelector('[role=dialog]')"); await settleRender();
    }
    check(`inspector layout ${width}px picker escape preserves draft`, await evaluate(`document.querySelector('[data-compose-input]').value==='Retained draft'`));
    await click('[data-agent-control-bar] [aria-label="Branch conversation"]'); await settleRender();
    check(`inspector layout ${width}px branch opens from composer`, await evaluate(`!!document.querySelector('[data-fork-form]') && document.querySelector('[data-fork-submit]').disabled`));
    await key('Escape'); await settleRender();
    check(`inspector layout ${width}px branch returns focus`, await evaluate(`!document.querySelector('[data-fork-form]') && document.activeElement?.getAttribute('aria-label')==='Branch conversation'`));
    await click('#inspector-conversation-tab'); await settleRender();
    check(`inspector layout ${width}px agent tab opens details`, await evaluate(`document.querySelector('#inspector-conversation-tab').textContent==='controls-a' && document.querySelector('#inspector-conversation-tab').getAttribute('aria-expanded')==='true' && document.body.textContent.includes('agent detail') && document.querySelectorAll('[aria-label="Branch conversation"]').length===1`));
    await click('#inspector-conversation-tab'); await settleRender();
    await click('#inspector-design-tab'); await settleRender();
    await click('#inspector-conversation-tab'); await settleRender();
    check(`inspector layout ${width}px agent tab switches without opening details`, await evaluate(`document.querySelector('#inspector-conversation-tab').getAttribute('aria-expanded')==='false' && document.querySelector('#inspector-conversation-tab').getAttribute('aria-selected')==='true'`));
    await screenshot(`inspector-composer-${width}`);

    await evaluate("window.__UI_QA__.agentControls.turn(); window.__UI_QA__.agentControls.draft('queued ordinary')");
    await settleRender(); await click('[data-compose-input]'); await key('Enter'); await settleRender();
    await evaluate("window.__UI_QA__.agentControls.draft('forced urgent')");
    await settleRender(); await key('Enter', 1); await settleRender();
    check(`agent controls ${width}px force preserves queued message`, await evaluate(`(() => {
      const s=window.__UI_QA__.agentControls.snapshot(), sends=s.calls.filter(c=>c.method==='agent.send');
      return s.outbox.some(o=>o.text==='queued ordinary') && sends.length===1 && sends[0].params.text==='forced urgent' && sends[0].params.force===true;
    })()`));
    await evaluate("window.__UI_QA__.agentControls.turn(true, true)"); await settleRender();
    check(`agent controls ${width}px steering keeps queue held`, await evaluate(`window.__UI_QA__.agentControls.snapshot().outbox.some(o=>o.text==='queued ordinary') && window.__UI_QA__.agentControls.snapshot().calls.filter(c=>c.method==='agent.send').length===1`));
    await evaluate("window.__UI_QA__.agentControls.turn(true)"); await settleRender();
    check(`agent controls ${width}px completion releases queued message`, await evaluate(`(() => {
      const s=window.__UI_QA__.agentControls.snapshot(), sends=s.calls.filter(c=>c.method==='agent.send');
      return !s.outbox.some(o=>o.text==='queued ordinary') && sends.length===2 && sends[1].params.text==='queued ordinary' && !sends[1].params.force;
    })()`));

    await evaluate("window.__UI_QA__.agentControls.select('controls-b')"); await settleRender();
    await evaluate("window.__UI_QA__.agentControls.stall()"); await settleRender();
    await waitFor("!!document.querySelector('[data-agent-row=\"controls-a\"] [data-agent-action=\"agents.resendPrompt\"]')");
    check(`agent controls ${width}px warning keeps agent readable`, await evaluate(`(() => {
      const row=document.querySelector('[data-agent-row="controls-a"]'), b=row.querySelector('[data-agent-action="agents.resendPrompt"]');
      const name=row.querySelector('[class*="name"]'), r=b.getBoundingClientRect();
      return b.textContent.trim()==='' && !!b.querySelector('svg') && r.width>=22 && r.width<=24 && name.getBoundingClientRect().width>=60 && row.getBoundingClientRect().height<36 && b.title.includes('no turn-start confirmation yet') && b.title.includes('resending can repeat') && b.getAttribute('aria-label').startsWith('Resend');
    })()`));
    await screenshot(`agent-warning-${width}`);
    await click('[data-agent-row="controls-a"] [data-agent-action="agents.resendPrompt"]'); await settleRender();
    check(`agent controls ${width}px warning resends only its agent`, await evaluate(`(() => {
      const s=window.__UI_QA__.agentControls.snapshot(), c=s.calls.filter(c=>c.method==='agent.send').at(-1);
      return c.params.agentId==='controls-a' && c.params.text==='synthetic resend' && s.selected==='controls-b';
    })()`));



  }
}
