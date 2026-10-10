export async function probeMediaPreview({ evaluate, show, waitFor, check, click, viewport, screenshot, key }) {
  // Local synthetic WebM: exercises the real HTML video decoder and controls,
  // without shipping a binary fixture or fetching a movie from the network.
  await evaluate(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const ctx = canvas.getContext('2d'); const stream = canvas.captureStream(20);
    const recorder = new MediaRecorder(stream, {mimeType:'video/webm;codecs=vp8'});
    const parts = []; recorder.ondataavailable = e => parts.push(e.data);
    const stopped = new Promise(resolve => recorder.onstop = resolve);
    recorder.start(); let frame = 0;
    const draw = setInterval(() => { ctx.fillStyle = frame++ % 2 ? '#7766bb' : '#339988'; ctx.fillRect(0,0,160,90); }, 40);
    await new Promise(resolve => setTimeout(resolve, 1100)); recorder.stop(); await stopped;
    clearInterval(draw); stream.getTracks().forEach(track => track.stop());
    window.__MEDIA_FIXTURE_URL__ = URL.createObjectURL(new Blob(parts, {type:'video/webm'}));
    window.__MEDIA_OPEN_CALLS__ = [];
  })()`);
  await show("media-preview");
  try { await waitFor(`document.querySelector('video[data-file-media]')?.readyState >= 1`); }
  catch (error) {
    const state = await evaluate(`(() => { const v = document.querySelector('video'); return {url:window.__MEDIA_FIXTURE_URL__, video:v?.outerHTML, error:v?.error?.message, ready:v?.readyState, text:document.body.textContent.slice(-1800)}; })()`);
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
  await evaluate(`(async () => { const v=document.querySelector('video'); v.muted=true; await v.play(); })()`);
  await waitFor(`document.querySelector('video').currentTime > 0.2`);
  await evaluate(`document.querySelector('video').pause(); document.querySelector('video').currentTime = 0.1`);
  await waitFor(`!document.querySelector('video').seeking`);
  check("media video decodes plays and seeks", await evaluate(`(() => { const v=document.querySelector('video'); return v.videoWidth === 160 && v.videoHeight === 90 && v.controls && !v.autoplay && Math.abs(v.currentTime - 0.1) < 0.06; })()`));
  let fits = true;
  for (const width of [360, 768, 1440]) {
    await viewport(width, 900);
    fits &&= await evaluate(`(() => { const card=document.querySelector('[data-file-viewer] > div'); const video=document.querySelector('video'); return card.scrollWidth <= card.clientWidth + 1 && video.getBoundingClientRect().right <= innerWidth; })()`);
  }
  check("media preview fits 360 768 1440", fits);
  await screenshot("media-video-preview");
  await click('[data-media-audio]');
  await waitFor(`document.querySelector('audio[data-file-media]')`);
  check("media audio has controls without autoplay", await evaluate(`document.querySelector('audio').controls && !document.querySelector('audio').autoplay && !document.querySelector('video')`));
  await click('[data-media-pdf]');
  await waitFor(`document.body.textContent.includes('No built-in preview')`);
  await click('[data-file-open]');
  await waitFor(`window.__MEDIA_OPEN_CALLS__.length === 1`);
  await click('[data-file-reveal]');
  await waitFor(`window.__MEDIA_OPEN_CALLS__.length === 2`);
  check("media fallback opens exact file and reveals folder", await evaluate(`window.__MEDIA_OPEN_CALLS__.every(c => c.path === '/fixture/pdf') && window.__MEDIA_OPEN_CALLS__[0].reveal === false && window.__MEDIA_OPEN_CALLS__[1].reveal === true`));
  await click('[data-media-broken]');
  await waitFor(`document.querySelector('[data-media-fallback]')`);
  const recovery = await evaluate(`document.querySelector('[data-media-fallback]').textContent.includes('Open in default app') && !!document.querySelector('[data-file-reveal]')`);
  await key("Escape");
  await waitFor(`!document.querySelector('[data-file-viewer]')`);
  check("media missing file has recovery and escape closes", recovery);
  await evaluate(`URL.revokeObjectURL(window.__MEDIA_FIXTURE_URL__)`);
}
