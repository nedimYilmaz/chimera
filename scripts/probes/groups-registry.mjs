// Mounted AgentsScreen + Inspector; external events use the real Engine event shape.
// The companion mounted MCP regression produces these events through an isolated Engine.
export async function probeInspectorRegistry({ viewport, show, waitFor, evaluate, check }) {
  await viewport(768, 900);
  await show("inspector-registry");
  await waitFor(`document.querySelector('[data-agent-detail-panel]') && window.__UI_QA__.groupRegistry.snapshot().calls >= 1`);
  await evaluate(`window.__UI_QA__.groupRegistry.mutate('create')`);
  await waitFor(`document.querySelector('[data-group-box="external"]') && [...document.querySelectorAll('[data-agent-group-select] option')].some(o=>o.textContent==='External created')`);
  check("inspector registry external create", await evaluate(`document.querySelector('[data-group-box="external"]').textContent.includes('External created')`));
  await evaluate(`window.__UI_QA__.groupRegistry.mutate('rename')`);
  await waitFor(`document.querySelector('[data-group-box="external"]').textContent.includes('External renamed') && [...document.querySelectorAll('[data-agent-group-select] option')].some(o=>o.textContent==='External renamed')`);
  check("inspector registry external rename color", await evaluate(`window.__UI_QA__.groupRegistry.snapshot().groups[0].color === 'teal'`));
  await evaluate(`window.__UI_QA__.groupRegistry.mutate('delete')`);
  await waitFor(`window.__UI_QA__.groupRegistry.snapshot().groups.length === 0 && !document.querySelector('[data-agent-group-select]')`);
  check("inspector registry external delete stale membership", await evaluate(`window.__UI_QA__.groupRegistry.snapshot().memberships[0] === 'external' && document.querySelector('[data-group-box="external"]').textContent.includes('external') && !document.querySelector('[data-group-box="external"]').textContent.includes('External renamed')`));
  await evaluate(`window.__UI_QA__.groupRegistry.mutate('reconnect')`);
  await waitFor(`document.querySelector('[data-group-box="external"]')?.textContent.includes('Reconnected registry') && [...document.querySelectorAll('[data-agent-group-select] option')].some(o=>o.textContent==='Reconnected registry')`);
  check("inspector registry reconnect missed crud", true);
  check("inspector registry selection draft panel preserved", await evaluate(`(() => {const s=window.__UI_QA__.groupRegistry.snapshot();return s.selected === s.inspector && s.draft === 'Preserve registry draft' && !!document.querySelector('[data-agent-detail-panel]')})()`));
}
