// Browser playback and static Pages-path portability checks. No live app/daemon is used.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, basename, sep } from 'node:path';
import assert from 'node:assert/strict';
import { connectCdp, createScratchDirectory, launchChromium, terminateOwnedProcess, removeScratchDirectory, installLoopbackGuard } from './browser-gate.mjs';

const args = process.argv.slice(2);
const compare = args.indexOf('--compare');
if (compare >= 0) {
  const [dirA, dirB] = args.slice(compare + 1);
  const [a, b] = [dirA, dirB].map(p => JSON.parse(readFileSync(join(p, 'provenance.json'), 'utf8')));
  const checks = [];
  assert.equal(a.timeline.clockFrozenAt, b.timeline.clockFrozenAt);
  assert.equal(a.timeline.fps, b.timeline.fps);
  for (const clip of a.clips) {
    const other = b.clips.find(c => c.id === clip.id);
    assert.ok(other, clip.id);
    assert.equal(clip.frames, other.frames, clip.id);
    assert.deepEqual(clip.hashes.webmSampledFrames, other.hashes.webmSampledFrames, `${clip.id}: decoded start/middle/end hashes`);
    const fullSequenceMatches = clip.hashes.webmDecodedHash === other.hashes.webmDecodedHash;
    console.log(`${clip.id}: full decoded sequence ${fullSequenceMatches ? 'matches' : 'differs; sampled decoded frames match'}`);
    // H.264 hardware encoding can vary between runs; decode is required, byte identity is not.
    const mp4Comparison = !clip.hashes.mp4DecodedHash || !other.hashes.mp4DecodedHash ? 'not compared (one capture has no MP4)' : clip.hashes.mp4DecodedHash === other.hashes.mp4DecodedHash ? 'match' : 'differ';
    checks.push({id:clip.id,sampledDecodedFramesMatch:true,fullDecodedSequenceMatches:fullSequenceMatches,capturedSequenceMatches:clip.hashes.contentHash===other.hashes.contentHash,mp4Comparison,sampledFrames:clip.hashes.webmSampledFrames});
    console.log(`${clip.id}: decoded start/middle/end hashes match; MP4 ${mp4Comparison}`);
  }
  writeFileSync(join(dirA,'determinism.json'),JSON.stringify({sourceRevisions:[a.sourceRevision,b.sourceRevision],clockFrozenAt:a.timeline.clockFrozenAt,fps:a.timeline.fps,notice:'Exact decoded representative-frame hashes match. Full-sequence equality is reported separately; tiny transient raster differences can remain. Container byte identity is not promised.',checks},null,2)+'\n');
  process.exit(0);
}
const dir = resolve(args.find(a => !a.startsWith('--')) ?? 'site/assets/videos');
const out = resolve(args.find(a => a.startsWith('--frames='))?.slice(9) ?? '/tmp/chimera-video-review');
mkdirSync(out, { recursive: true });
const provenance = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8'));
// FFprobe is a required final check, supplied by PATH or an explicit temporary tool path.
const ffprobe = process.env.FFPROBE ?? 'ffprobe';
const ffprobeVersion = execFileSync(ffprobe,['-version'],{encoding:'utf8'}).split('\n')[0];
const mediaChecks = [];
for (const clip of provenance.clips) for (const format of ['mp4','webm']) {
  assert.ok(clip.files[format], `${clip.id}: ${format} required`);
  const probe = JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',join(dir,clip.files[format].file)],{encoding:'utf8'}));
  const video = probe.streams.find(s=>s.codec_type==='video');
  assert.equal(video.codec_name,format==='mp4'?'h264':'vp8');
  assert.equal(video.width,1280); assert.equal(video.height,800);
  assert.equal(video.r_frame_rate,'15/1');
  assert.ok(Math.abs(Number(probe.format.duration)-clip.durationSeconds)<.15);
  assert.equal(Number(probe.format.size),clip.files[format].bytes);
  assert.ok(Number(probe.format.size)<15*1024*1024);
  assert.ok(!probe.streams.some(s=>s.codec_type==='audio'));
  delete probe.format.filename;
  for (const tags of [probe.format.tags,...probe.streams.map(s=>s.tags)].filter(Boolean)) {
    assert.ok(!Object.keys(tags).some(k=>/creation|location|artist|author/i.test(k)),`${clip.id}: personal metadata`);
  }
  mediaChecks.push({id:`${clip.id}/${format}`,status:'passed',...probe});
}
const siteRoot=resolve(import.meta.dirname,'../site');
const siteRequests=[];
const types = { webm: 'video/webm', mp4: 'video/mp4', vtt: 'text/vtt', jpg: 'image/jpeg', js: 'text/javascript' };
const server = createServer((req, res) => {
  const name = basename(new URL(req.url, 'http://localhost').pathname);
  if (req.url === '/chimera/review') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body style="margin:0;background:#111;color:white"><video id="v" muted controls playsinline style="width:100%"></video></body></html>');
    return;
  }
  siteRequests.push(req.url);
  if (!req.url.startsWith('/chimera/assets/videos/')) {
    const path=resolve(siteRoot,new URL(req.url,'http://localhost').pathname.replace(/^\/chimera\//,''));
    if (!path.startsWith(siteRoot+sep)) { res.writeHead(404).end(); return; }
    try { const bytes=readFileSync(path); res.setHeader('Content-Type',path.endsWith('.html')?'text/html':path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.js')?'text/javascript':'application/octet-stream'); res.end(bytes); } catch {res.writeHead(404).end();}
    return;
  }
  try {
    const bytes = readFileSync(join(dir, name));
    res.setHeader('Content-Type', types[name.split('.').at(-1)] ?? 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
      res.end(bytes.subarray(start, end + 1));
    } else { res.setHeader('Content-Length', bytes.length); res.end(bytes); }
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const scratch = createScratchDirectory('chimera-video-playback-');
let chrome, cdp;
try {
  const launch = await launchChromium({ args: ['--headless=new', '--no-first-run', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', `--user-data-dir=${join(scratch,'chrome')}`, 'about:blank'] });
  chrome = launch.child;
  cdp = await connectCdp(launch.endpoint);
  const {targetId} = await cdp.call('Target.createTarget', {url:'about:blank'});
  const {sessionId} = await cdp.call('Target.attachToTarget', {targetId,flatten:true});
  const call = (m,p={}) => cdp.call(m,p,sessionId);
  await call('Page.enable'); await call('Runtime.enable');
  await installLoopbackGuard(cdp,sessionId,origin);
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await call('Page.navigate',{url:`${origin}/chimera/review`});
  for(let i=0;i<100 && !await evaluate('Boolean(document.getElementById("v"))');i++) await new Promise(r=>setTimeout(r,50));
  const checks=[];
  for(const clip of provenance.clips) {
    assert.ok(clip.durationSeconds>=15 && clip.durationSeconds<=40, `${clip.id}: pacing`);
    const vtt=readFileSync(join(dir,clip.files.captions),'utf8');
    const cues=[...vtt.matchAll(/(\d\d):(\d\d):(\d\d\.\d+) --> (\d\d):(\d\d):(\d\d\.\d+)/g)].map(m=>[Number(m[1])*3600+Number(m[2])*60+Number(m[3]),Number(m[4])*3600+Number(m[5])*60+Number(m[6])]);
    assert.ok(cues.length>0);
    for(let i=0;i<cues.length;i++) assert.ok(cues[i][0]<cues[i][1] && cues[i][1]<=clip.durationSeconds+.001 && (!i || cues[i][0]>=cues[i-1][1]), `${clip.id}: caption timing`);
    for(const format of ['webm','mp4']) {
      if(!clip.files[format]) continue;
      const src=`assets/videos/${clip.files[format].file}`;
      const result=await evaluate(`(async()=>{
        const v=document.getElementById('v'); v.pause(); v.innerHTML='<track kind="captions" src="assets/videos/${clip.files.captions}" srclang="en" default>'; v.src=${JSON.stringify(src)};
        await new Promise((resolve,reject)=>{v.onloadeddata=resolve;v.onerror=()=>reject(new Error('video decode failed'));setTimeout(()=>reject(new Error('load timeout')),15000)});
        v.textTracks[0].mode='hidden';
        await new Promise((resolve,reject)=>{const track=v.querySelector('track');if(track.readyState===2)resolve();else {track.onload=resolve;track.onerror=()=>reject(new Error('captions failed'));setTimeout(()=>reject(new Error('caption timeout')),10000)}});
        const captionCount=v.textTracks[0].cues.length;
        await v.play(); const before=v.currentTime;
        await new Promise(r=>setTimeout(r,650)); v.pause();
        return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,advanced:v.currentTime>before+.1,decoded:v.getVideoPlaybackQuality().totalVideoFrames,captionCount,src:v.currentSrc};
      })()`);
      assert.equal(result.captionCount,cues.length);
      assert.equal(result.width,1280); assert.equal(result.height,800);
      assert.ok(Math.abs(result.duration-clip.durationSeconds)<.15 && result.advanced && result.decoded>0, `${clip.id}/${format}: playback`);
      const samples=[['start',0],['middle',clip.durationSeconds/2],['end',clip.durationSeconds-.15]];
      if(format==='webm') {
        samples.push(['opening-motion',.333],['chapter-motion',(clip.steps[0]?.atSeconds??2)+.133],['closing-motion',clip.durationSeconds-1.667]);
        const camera=clip.motion?.[0];
        if(camera) samples.push(['camera-mid',camera.atSeconds+.333],['camera-settled',camera.atSeconds+.733]);
      }
      for(const [label,t] of (args.includes('--skip-frame-review')?[]:samples)) {
        await evaluate(`(async()=>{const v=document.getElementById('v');await new Promise((resolve,reject)=>{v.onseeked=()=>requestAnimationFrame(()=>requestAnimationFrame(resolve));v.currentTime=${t};if(!v.seeking && v.readyState>=2)requestAnimationFrame(resolve);setTimeout(()=>reject(new Error('seek timeout')),10000)});})()`);
        for(const width of [1280,390]) {
          await call('Emulation.setDeviceMetricsOverride',{width,height:Math.round(width*800/1280),deviceScaleFactor:1,mobile:false});
          await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
          const shot=await call('Page.captureScreenshot',{format:'png'});
          writeFileSync(join(out,`${clip.id}-${format}-${label}-${width}.png`),Buffer.from(shot.data,'base64'));
        }
      }
      checks.push({id:`${clip.id}/${format}`,status:'passed',...result,captions:cues.length});
      console.log(`${clip.id}/${format}: decoded, played, sought start/middle/end through /chimera/ relative asset paths`);
    }
  }
  // Exercise the actual homepage players, not just a full-size decoding fixture.
  const homepageChecks=[];
  for(const width of [360,390,768,1440]) {
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<768});
    const requestStart=siteRequests.length;
    await call('Page.navigate',{url:`${origin}/chimera/index.html`});
    for(let i=0;i<100 && !await evaluate(`Boolean(document.querySelector('#demos video'))`);i++) await new Promise(r=>setTimeout(r,50));
    await evaluate(`document.fonts.ready`);
    const layout=await evaluate(`(() => ({count:document.querySelectorAll('video').length, overflow:document.documentElement.scrollWidth>innerWidth+1, screenshotLinks:document.querySelectorAll('[data-zoom]').length, controls:[...document.querySelectorAll('video')].every(v=>v.controls && !v.autoplay && v.preload==='none' && v.playsInline), sources:[...document.querySelectorAll('source,track')].map(s=>s.src) }))()`);
    const darkTextContrast=await evaluate(`(() => {
      const linear=n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;};
      const luminance=rgb=>rgb.map(linear).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
      const bg=getComputedStyle(document.documentElement).getPropertyValue('--graphite').trim().slice(1);
      const background=luminance([0,2,4].map(i=>parseInt(bg.slice(i,i+2),16)));
      return Math.min(...[...document.querySelectorAll('.demo-card--hero figcaption,.demo-card--hero .demo-links a,.demo-card--dark figcaption,.demo-card--dark .demo-links a')].map(el=>{
        const foreground=luminance(getComputedStyle(el).color.match(/[\\d.]+/g).slice(0,3).map(Number));
        return (Math.max(background,foreground)+.05)/(Math.min(background,foreground)+.05);
      }));
    })()`);
    assert.ok(darkTextContrast>=4.5,`homepage ${width}: caption/alternative contrast ${darkTextContrast}`);
    assert.equal(layout.count,provenance.clips.length); assert.equal(layout.screenshotLinks,0);
    assert.ok(layout.controls && !layout.overflow,`homepage ${width}: layout/controls`);
    assert.ok(!siteRequests.slice(requestStart).some(r=>/\.(mp4|webm)(?:$|\?)/.test(r)),`homepage ${width}: eager video download`);
    for(const src of layout.sources) assert.ok((await fetch(src)).ok,src);
    for(const clip of provenance.clips) {
      const result=await evaluate(`(async()=>{
        const v=document.querySelector('#${clip.id} video'); v.scrollIntoView({block:'center'});
        v.load(); await new Promise((resolve,reject)=>{if(v.readyState>=2)resolve();else {v.onloadeddata=resolve;v.onerror=()=>reject(Error('decode'));setTimeout(()=>reject(Error('load timeout')),15000)}});
        v.textTracks[0].mode='showing';
        await new Promise((resolve,reject)=>{const t=v.querySelector('track');if(t.readyState===2)resolve();else {t.onload=resolve;t.onerror=()=>reject(Error('captions'));setTimeout(()=>reject(Error('caption timeout')),10000)}});
        await v.play(); const before=v.currentTime; await new Promise(r=>setTimeout(r,170)); const advanced=v.currentTime>before;
        v.pause(); await new Promise((resolve,reject)=>{v.onseeked=resolve;v.currentTime=v.duration/2;setTimeout(()=>reject(Error('seek')),10000)});
        return {advanced,seeked:Math.abs(v.currentTime-v.duration/2)<.15,captions:v.textTracks[0].cues.length,visibleCues:v.textTracks[0].activeCues.length};
      })()`);
      assert.ok(result.advanced && result.seeked && result.captions>0 && result.visibleCues>0,`${width}/${clip.id}: inline playback/captions/seek`);
    }
    const oneAtATime=await evaluate(`(async()=>{const [a,b]=document.querySelectorAll('video');await a.play();await b.play();await new Promise(r=>setTimeout(r,60));const ok=a.paused&&!b.paused;b.pause();return ok;})()`);
    assert.ok(oneAtATime);
    await evaluate(`scrollTo(0,0)`);
    const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    writeFileSync(join(out,`homepage-${width}.png`),Buffer.from(shot.data,'base64'));
    homepageChecks.push({width,status:'passed',players:layout.count,oneAtATime,noEagerLoads:true,darkTextContrast});
    console.log(`homepage ${width}: all ${layout.count} inline players played, sought and loaded captions; no overflow or eager media`);
  }
  console.log('homepage responsive playback complete; checking keyboard and compatibility fragments');
  // Keyboard focus can reach the native controls and alternatives.
  await evaluate(`document.activeElement?.blur();scrollTo(0,0)`);
  let keyboardPlayer=false;
  for(let i=0;i<35 && !keyboardPlayer;i++) {
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    keyboardPlayer=await evaluate(`document.activeElement?.tagName==='VIDEO'`);
  }
  assert.ok(keyboardPlayer,'native video keyboard focus');
  for(const clip of provenance.clips) {
    await call('Page.navigate',{url:`${origin}/chimera/videos.html#${clip.id}`});
    for(let i=0;i<100 && !await evaluate(`location.pathname.endsWith('/index.html') && location.hash==='#${clip.id}'`);i++) await new Promise(r=>setTimeout(r,30));
    assert.ok(await evaluate(`location.pathname.endsWith('/index.html') && location.hash==='#${clip.id}' && Boolean(document.querySelector('#${clip.id} video'))`),'legacy fragment redirect');
  }
  console.log('legacy fragments passed; checking reduced-motion and noJS');
  for(const nojs of [false,true]) {
    await call('Emulation.setScriptExecutionDisabled',{value:nojs});
    await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    const beforeRequests=siteRequests.length;
    await call('Page.navigate',{url:`${origin}/chimera/index.html#demos`});
    for(let i=0;i<100 && !await evaluate(`Boolean(document.querySelector('#demos video'))`);i++) await new Promise(r=>setTimeout(r,50));
    const alternatives=await evaluate(`(() => ({count:document.querySelectorAll('video').length,reduced:matchMedia('(prefers-reduced-motion:reduce)').matches,controls:[...document.querySelectorAll('video')].every(v=>v.controls&&!v.autoplay&&v.preload==='none'),links:document.querySelectorAll('.demo-links').length}))()`);
    assert.equal(alternatives.count,provenance.clips.length);assert.equal(alternatives.links,alternatives.count);assert.ok(alternatives.controls&&alternatives.reduced);
    assert.ok(!siteRequests.slice(beforeRequests).some(r=>/\.(mp4|webm)(?:$|\?)/.test(r)),'reduced-motion eager media');
    assert.ok(await evaluate(`!/(demo data|scripted daemon|capture source)/i.test(document.body.innerText)`),'repeated fixture labels');
    if(nojs) {
      // Disabling page scripts also suppresses their timer callbacks. Keep the wait in
      // this runner, while Chromium's native media pipeline advances independently.
      await evaluate(`(() => {const v=document.querySelector('video');v.muted=true;v.play();return true;})()`);
      await new Promise(r=>setTimeout(r,500));
      const native=await evaluate(`(() => {const v=document.querySelector('video');const advanced=v.currentTime>.1;v.pause();return advanced;})()`);
      assert.ok(native,'noJS native player');
      await call('Page.navigate',{url:`${origin}/chimera/videos.html#context-handoff`});
      for(let i=0;i<100 && !await evaluate(`Boolean(document.querySelector('main a'))`);i++) await new Promise(r=>setTimeout(r,30));
      assert.ok(await evaluate(`!document.querySelector('video') && Boolean(document.querySelector('a[href="index.html#context-handoff"]'))`),'noJS compatibility fallback');
    }
    checks.push({id:`homepage/reduced-motion/nojs-${nojs}`,status:'passed',...alternatives});
  }
  checks.push({id:'homepage/responsive/inline-playback/keyboard/legacy-fragments',status:'passed',widths:homepageChecks,keyboardPlayer});
  const report={frameReview:args.includes('--skip-frame-review')?'Retained prior start/middle/end and transition review; media bytes unchanged':'Start/middle/end and transition screenshots generated this run',browser:(await cdp.call('Browser.getVersion')).product,ffprobe:{version:ffprobeVersion,checks:mediaChecks},scope:'Local static server under /chimera/ project Pages prefix; deployed Pages not exercised',checks};
  writeFileSync(join(dir,'verification.json'),JSON.stringify(report,null,2)+'\n');
} finally {
  await cdp?.close(); await terminateOwnedProcess(chrome); await new Promise(r=>server.close(r)); await removeScratchDirectory(scratch);
}
