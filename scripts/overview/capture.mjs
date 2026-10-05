// Local deterministic Canvas export. Uses owned headless Chromium; never the live app.
import { readFileSync,writeFileSync,mkdirSync,statSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve,join } from 'node:path';
import { execFileSync,spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { connectCdp,createScratchDirectory,launchChromium,terminateOwnedProcess,removeScratchDirectory,installLoopbackGuard } from '../browser-gate.mjs';
const root=resolve(import.meta.dirname,'../..');
const story=JSON.parse(readFileSync(join(import.meta.dirname,'story.json'),'utf8'));
const args=process.argv.slice(2),preview=args.includes('--preview');
const output=resolve(args.find(x=>x.startsWith('--out='))?.slice(6)??'/tmp/chimera-overview');mkdirSync(output,{recursive:true});
const git=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8'}).trim();
if(git('status','--porcelain'))throw Error('Capture requires committed clean source.');
const source=git('rev-parse','HEAD'),ffmpeg=process.env.FFMPEG??'/tmp/chimera-media-tools/ffmpeg',ffprobe=process.env.FFPROBE??'/tmp/chimera-media-tools/ffprobe';
const version=execFileSync(ffmpeg,['-version'],{encoding:'utf8'}).split('\n')[0];
const server=createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<html><meta charset="utf-8"><body style="margin:0;background:#14161a"><canvas id="film"></canvas><script type="module">import {createFilm} from '/scene.mjs';const logo=new Image();logo.src='/logo.svg';await logo.decode();window.story=${JSON.stringify(story)};window.film=createFilm(document.querySelector('canvas'),window.story,logo);window.film.draw(0);window.ready=true;</script></body></html>`);return;}
  const file={'/scene.mjs':join(import.meta.dirname,'scene.mjs'),'/logo.svg':join(root,'site/favicon.svg')}[req.url];if(!file){res.writeHead(404).end();return;}res.setHeader('Content-Type',req.url.endsWith('.svg')?'image/svg+xml':'text/javascript');res.end(readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const scratch=createScratchDirectory('chimera-overview-');let chrome,cdp;const encoders=[];
async function encode(name,start,end,formats){
  const jobs=formats.map(format=>{
    const file=join(output,`${name}.${format}`);
    const codec=format==='mp4'?['-c:v','libx264','-preset','medium','-crf','24','-pix_fmt','yuv420p','-movflags','+faststart']:['-c:v','libvpx','-b:v','0','-crf','16','-qmax','20','-g','60','-deadline','good','-cpu-used','2','-pix_fmt','yuv420p'];
    // Canvas JPEG is full range; explicit conversion avoids VP8's limited-range decode clipping.
    const proc=spawn(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','image2pipe','-vcodec','mjpeg','-framerate',String(story.fps),'-i','pipe:0','-an','-vf','scale=in_range=pc:out_range=tv,format=yuv420p','-color_range','tv','-colorspace','bt470bg',...codec,'-threads','4','-map_metadata','-1',file],{stdio:['pipe','ignore','pipe']});
    encoders.push(proc);let error='';proc.stderr.on('data',b=>error+=b);const closed=once(proc,'close');proc.stdin.on('error',()=>{});return {proc,closed,file,format,error:()=>error};
  });
  const hash=createHash('sha256');
  for(let n=Math.round(start*story.fps);n<Math.round(end*story.fps);n++){
    const data=await evaluate(`(()=>{film.draw(${n/story.fps});return document.querySelector('canvas').toDataURL('image/jpeg',.94).split(',')[1]})()`);
    const frame=Buffer.from(data,'base64');hash.update(frame);
    await Promise.all(jobs.map(async({proc})=>{if(!proc.stdin.write(frame))await once(proc.stdin,'drain');}));
    if(n%300===0)console.log(`${name}: ${n/story.fps}s`);
  }
  for(const j of jobs)j.proc.stdin.end();
  const files={};
  for(const j of jobs){const [code]=await j.closed;if(code)throw Error(j.error());const probe=JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',j.file],{encoding:'utf8'}));const v=probe.streams.find(s=>s.codec_type==='video');if(v.width!==story.width||v.height!==story.height||v.r_frame_rate!==`${story.fps}/1`||probe.streams.some(s=>s.codec_type==='audio'))throw Error('Invalid export');files[j.format]={file:j.file.split('/').at(-1),bytes:statSync(j.file).size,codec:v.codec_name};}
  return {files,contentHash:hash.digest('hex')};
}
let evaluate;
try{
  const launch=await launchChromium({args:['--headless=new','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${join(scratch,'chrome')}`,'about:blank']});chrome=launch.child;cdp=await connectCdp(launch.endpoint);
  const {targetId}=await cdp.call('Target.createTarget',{url:'about:blank'});const {sessionId}=await cdp.call('Target.attachToTarget',{targetId,flatten:true});const call=(m,p={})=>cdp.call(m,p,sessionId);
  await call('Page.enable');await call('Runtime.enable');await installLoopbackGuard(cdp,sessionId,origin);await call('Emulation.setDeviceMetricsOverride',{width:story.width,height:story.height,deviceScaleFactor:1,mobile:false});
  evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
  await call('Page.navigate',{url:origin});for(let i=0;i<100&&!await evaluate('Boolean(window.ready)');i++)await new Promise(r=>setTimeout(r,40));if(!await evaluate('Boolean(window.ready)'))throw Error('Scene not ready');
  if(await evaluate('document.characterSet')!=='UTF-8'||JSON.stringify(await evaluate('window.story'))!==JSON.stringify(story))throw Error('Capture document changed story text encoding');
  // Review every chapter hold and transition; these are original frames, not screenshots of UI.
  const reviewTimes=[0,.5,1.5,2,4,7.9,8,8.4,10,17,18.9,19,19.4,23,30,31.9,32,32.4,36,40,43.9,44,44.4,48,54,56.9,57,57.4,61,67,69.9,70,70.4,74,80,81.9,82,82.4,85,89.9];
  for(const t of reviewTimes){const data=await evaluate(`(()=>{film.draw(${t});return document.querySelector('canvas').toDataURL('image/png').split(',')[1]})()`);writeFileSync(join(output,`frame-${t.toFixed(1).padStart(4,'0')}.png`),Buffer.from(data,'base64'));}
  const posterData=await evaluate(`(()=>{film.draw(4);return document.querySelector('canvas').toDataURL('image/jpeg',.94).split(',')[1]})()`);writeFileSync(join(output,'chimera-product-overview.poster.jpg'),Buffer.from(posterData,'base64'));
  const names=preview?[['opening-preview',0,8],['memory-preview',32,44],['review-preview',57,70],['queue-preview',19,32]]:[['chimera-product-overview',0,90]];
  for(const [name,start,end] of names.filter(([name])=>!args.some(a=>a.startsWith('--clip='))||args.includes('--clip='+name))){const encoded=await encode(name,start,end,preview?['mp4']:['mp4','webm']);writeFileSync(join(output,`${name}.capture.json`),JSON.stringify({id:story.id,title:story.title,kind:'illustrated-animation',captureSourceRevision:source,captureSourceTree:git('rev-parse',`${source}^{tree}`),sourceTreeDirty:false,colorEncoding:{range:'limited',matrix:'bt470bg',input:'full-range Canvas JPEG'},width:story.width,height:story.height,fps:story.fps,frames:(end-start)*story.fps,durationSeconds:end-start,notice:story.limits,rendering:'Deterministic original Canvas motion graphics; no real product components or live workspace.',browser:(await cdp.call('Browser.getVersion')).product,ffmpeg:version,...encoded},null,2)+'\n');}
}finally{for(const proc of encoders)if(proc.exitCode===null)proc.kill('SIGTERM');await cdp?.close();await terminateOwnedProcess(chrome);await new Promise(r=>server.close(r));await removeScratchDirectory(scratch);}
