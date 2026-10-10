export async function probeHtmlPreview({ show, evaluate, waitFor, check, click, key, viewport, screenshot, call, sessionId }) {
  await show("html-preview");
  await waitFor(`document.querySelector('[data-html-preview] iframe')?.srcdoc.includes('Local page')`);
  check("local html preview resolves sibling CSS and images", await evaluate(`(() => {
    const html=document.querySelector('[data-html-preview] iframe').srcdoc;
    const calls=window.__UI_QA__.html.calls;
    return html.includes('rgb(17, 34, 51)') && html.includes('data:image/png;base64,') &&
      ['/html-fixture/styles/main.css','/html-fixture/images/bg.png','/html-fixture/images/a.png'].every(p=>calls.includes(p)) &&
      calls.every(p=>p.startsWith('/html-fixture/'));
  })()`));
  let frameId, frameSession = sessionId;
  for (let attempt = 0; attempt < 100 && !frameId; attempt++) {
    const tree = await call("Page.getFrameTree", {}, sessionId);
    frameId = tree.frameTree.childFrames?.find(child => child.frame.url === "about:srcdoc")?.frame.id;
    // Chromium may place an opaque sandbox in a separate renderer. Inspect
    // that target through CDP, never weaken the production iframe sandbox.
    if (!frameId) {
      const targets = await call("Target.getTargets", {});
      const target = targets.targetInfos.find(t => t.type === "iframe" && t.url === "about:srcdoc");
      if (target) {
        const attached = await call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
        frameSession = attached.sessionId;
        await call("Page.enable", {}, frameSession);
        frameId = (await call("Page.getFrameTree", {}, frameSession)).frameTree.frame.id;
      }
    }
    if (!frameId) await new Promise(resolve => setTimeout(resolve, 40));
  }
  if (!frameId) throw new Error("HTML preview frame did not attach");
  const world = await call("Page.createIsolatedWorld", { frameId, worldName: "local-html-verification" }, frameSession);
  const rendered = await call("Runtime.evaluate", { contextId: world.executionContextId, awaitPromise: true, returnByValue: true, expression: `(async () => {
    const image=document.querySelector('img[alt="local picture"]'); await image.decode();
    return { color:getComputedStyle(document.querySelector('h1')).color, width:image.naturalWidth, background:getComputedStyle(document.querySelector('.swatch')).backgroundImage };
  })()` }, frameSession);
  if (frameSession !== sessionId) await call("Target.detachFromTarget", { sessionId: frameSession });
  const value = rendered.result.value;
  check("local html renders stylesheet and raster in isolated frame", value?.color === "rgb(17, 34, 51)" && value?.width === 1 && value?.background.startsWith('url("data:image/png;base64,'), value);
  check("local html cannot execute scripts navigate or access native bridge", await evaluate(`(() => {
    const f=document.querySelector('[data-html-preview] iframe'); const s=f.srcdoc;
    return f.getAttribute('sandbox') === '' && f.contentDocument === null && !window.__HTML_ESCAPED__ &&
      !s.includes('<script') && !s.includes('<iframe') && !s.includes('href=') && !s.includes('action=') &&
      s.includes("script-src 'none'") && s.includes("connect-src 'none'") && s.includes('disabled');
  })()`));
  let fits = true;
  for (const width of [360, 768, 1440]) {
    await viewport(width, 900);
    fits &&= await evaluate(`(() => { const f=document.querySelector('[data-html-preview] iframe'); const r=f.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth; })()`);
  }
  check("local html preview fits narrow and wide screens", fits);
  await screenshot("local-html-preview");
  await click('[data-file-viewer-raw-toggle]');
  await waitFor(`!document.querySelector('[data-html-preview]')`);
  check("local html source toggle retains original markup", await evaluate(`document.querySelector('[data-file-viewer]').textContent.includes('../styles/main.css') && document.querySelector('[data-file-viewer-raw-toggle]').textContent === 'preview'`));
  await click('[data-file-viewer-raw-toggle]');
  await waitFor(`document.querySelector('[data-html-preview] iframe')`);
  await key("Escape");
  await waitFor(`!document.querySelector('[data-file-viewer]')`);
  await click('[data-html-line]');
  await waitFor(`document.querySelector('[data-file-viewer-raw-toggle]')`);
  check("local html line links keep source view", await evaluate(`!document.querySelector('[data-html-preview]') && document.querySelector('[data-file-viewer-raw-toggle]').disabled`));
  await key("Escape");
  const limits = await evaluate(`window.__UI_QA__.html.limits()`);
  check("local html bounds resource work and cancels closed previews", limits.count === 32 && limits.omitted === 48 && limits.cancelledReads === 0, limits);
}
