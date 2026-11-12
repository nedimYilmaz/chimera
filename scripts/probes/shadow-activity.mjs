export async function probeShadowActivity({ viewport, show, waitFor, check, evaluate, click, screenshot }) {
  for (const width of [390, 768, 1440]) {
    await viewport(width, 900); await show("shadow-activity");
    await waitFor(`document.querySelector('[data-shadow-inspector]')?.textContent.includes('context (judgment)')`);
    check(`shadow activity ${width}px shows CLI phases and metrics`, await evaluate(`document.body.textContent.includes('1/3 agents complete') && document.body.textContent.includes('55.6k tok') && document.querySelector('[aria-label="workflow phases"]')?.textContent.includes('Context')`));
    await click('[aria-label="workflow phases"] button:nth-child(2)');
    check(`shadow activity ${width}px filters phase members`, await evaluate(`document.querySelector('[data-shadow-inspector]').textContent.includes('pre-gather') && !document.querySelector('[data-shadow-inspector]').textContent.includes('security-review')`));
    await evaluate(`[...document.querySelectorAll('[data-shadow-inspector] button')].find(b=>b.textContent.includes('context (judgment)')).click()`);
    await waitFor(`document.querySelector('[aria-label="shadow transcript"]')?.textContent.includes('judge private output')`);
    check(`shadow activity ${width}px drills into exact agent`, await evaluate(`document.querySelector('[aria-label="shadow transcript"]').textContent.includes('judge private output') && document.body.textContent.includes('Inspect staged changes')`));
    check(`shadow activity ${width}px fits viewport`, await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('[data-shadow-inspector]').getBoundingClientRect().right <= innerWidth + 1`));
    await screenshot(`shadow-activity-${width}`);
  }
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Complete phase').click()`);
  await waitFor(`document.body.textContent.includes('2/3 agents complete')`);
  check("shadow activity polling updates progress", await evaluate(`document.body.textContent.includes('2/3 agents complete')`));
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Toggle failure').click()`);
  await waitFor(`document.body.textContent.includes('Refresh failed')`);
  check("shadow activity refresh failure labels stale data", await evaluate(`document.body.textContent.includes('last successful snapshot') && document.body.textContent.includes('context (judgment)')`));
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Toggle failure').click(); [...document.querySelectorAll('button')].find(b=>b.textContent==='Switch shadow').click()`);
  await waitFor(`document.querySelector('[aria-label="shadow transcript"]')?.textContent.includes('native task output')`);
  check("shadow activity selection isolates native transcript", await evaluate(`!document.body.textContent.includes('judge private output') && !document.body.textContent.includes('context (judgment)') && document.body.textContent.includes('native task output')`));

}
