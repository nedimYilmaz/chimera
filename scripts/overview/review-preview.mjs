// Decode preview exports and inspect native controls at desktop/phone widths.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,basename} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {createCaptions} from './captions.mjs';
import {connectCdp,createScratchDirectory,launchChromium,terminateOwnedProcess,removeScratchDirectory,installLoopbackGuard} from '../browser-gate.mjs';
const dir=resolve(process.argv[2]),out=join(dir,'review');mkdirSync(out,{recursive:true});
const ffmpeg=process.env.FFMPEG??'/tmp/chimera-media-tools/ffmpeg';
const story=JSON.parse(readFileSync(join(import.meta.dirname,'story.json'),'utf8'));
const items=[['opening-preview',0,[1.5,3.99,4,4.01,7]],['memory-preview',32,[4,8,11]],['review-preview',57,[4,10,12]]].filter(([name])=>existsSync(join(dir,`${name}.mp4`)));
for(const [name,start,times] of items){
 const ch=story.chapters.find(x=>x.start===start);
 writeFileSync(join(dir,name+'.vtt'),createCaptions([ch],start));
 for(const t of times)for(const width of [1600,390])execFileSync(ffmpeg,['-v','error','-y','-ss',String(t),'-i',join(dir,`${name}.mp4`),'-frames:v','1','-vf',`scale=${width}:-1`,join(out,`${name}-${start+t}-${width}.png`)]);
}
const server=createServer((req,res)=>{const path=basename(new URL(req.url,'http://localhost').pathname);
 if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<html><meta name="viewport" content="width=device-width"><body style="margin:0;background:#14161a"><video id="v" controls playsinline style="width:100%;display:block" preload="none"></video></body></html>');return;}
 try{const bytes=readFileSync(join(dir,path));res.setHeader('Content-Type',path.endsWith('.vtt')?'text/vtt':'video/mp4');res.setHeader('Accept-Ranges','bytes');const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range??'');if(range){const a=+range[1],b=range[2]?Math.min(+range[2],bytes.length-1):bytes.length-1;res.writeHead(206,{'Content-Range':`bytes ${a}-${b}/${bytes.length}`,'Content-Length':b-a+1});res.end(bytes.subarray(a,b+1));}else res.end(bytes);}catch{res.writeHead(404).end();}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,scratch=createScratchDirectory('chimera-preview-review-');let chrome,cdp;
try{
 const launch=await launchChromium({args:['--headless=new','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${join(scratch,'chrome')}`,'about:blank']});chrome=launch.child;cdp=await connectCdp(launch.endpoint);const {targetId}=await cdp.call('Target.createTarget',{url:'about:blank'});const {sessionId}=await cdp.call('Target.attachToTarget',{targetId,flatten:true}),call=(m,p={})=>cdp.call(m,p,sessionId);
 await call('Page.enable');await call('Runtime.enable');await installLoopbackGuard(cdp,sessionId,origin);const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);return r.result.value;};await call('Page.navigate',{url:origin});for(let i=0;i<100&&!await ev('Boolean(document.querySelector("video"))');i++)await new Promise(r=>setTimeout(r,30));
 const checks=[];
 for(const [name,start,times] of items){await ev(`(async()=>{const v=document.querySelector('video');v.pause();v.innerHTML='<track kind="captions" src="/${name}.vtt" srclang="en" default>';v.src='/${name}.mp4';v.load();await new Promise((r,j)=>{v.onloadeddata=r;v.onerror=()=>j(Error('preview decode'));setTimeout(()=>j(Error('preview load timeout')),12000)});v.textTracks[0].mode='showing';const track=v.querySelector('track');await new Promise((r,j)=>{if(track.readyState===2)r();else{track.onload=r;track.onerror=()=>j(Error('preview captions'));setTimeout(()=>j(Error('caption timeout')),12000)}});})()`);
  for(const t of times)for(const width of [1600,390]){
   await call('Emulation.setDeviceMetricsOverride',{width,height:Math.ceil(width*1000/1600),deviceScaleFactor:1,mobile:false});await ev(`(async()=>{const v=document.querySelector('video');v.pause();await new Promise(r=>{v.onseeked=r;v.currentTime=${t};if(!v.seeking)r();setTimeout(r,2000)});})()`);
   await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:width/2,y:Math.ceil(width*1000/1600)-20});await new Promise(r=>setTimeout(r,120));const shot=await call('Page.captureScreenshot',{format:'png'});writeFileSync(join(out,`${name}-${start+t}-player-${width}.png`),Buffer.from(shot.data,'base64'));
   checks.push({name,time:start+t,width,...await ev(`(()=>{const v=document.querySelector('video');return {controls:v.controls,videoWidth:v.videoWidth,videoHeight:v.videoHeight,paused:v.paused,error:v.error?.message??null,activeCaption:v.textTracks[0]?.activeCues?.[0]?.text??null,activeCueCount:v.textTracks[0]?.activeCues?.length??0,overflow:document.documentElement.scrollWidth>innerWidth+1}})()`)});
   const check=checks.at(-1),ch=story.chapters.find(x=>x.start===start),expected=ch.beats.filter(b=>t>=b.at).at(-1).text;
   assert.equal(check.activeCueCount,1,`${name}/${t}/${width}: exactly one beat`);assert.equal(check.activeCaption,expected);assert.equal(check.error,null);assert.equal(check.overflow,false);
  }
 }
 writeFileSync(join(out,'preview-verification.json'),JSON.stringify({source:JSON.parse(readFileSync(join(dir,'opening-preview.capture.json'),'utf8')).captureSourceRevision,captionPxAt390:58*390/1600,diagramClipBottom:story.safeRegions.diagram.bottom,captionBaselineY:story.safeRegions.caption.centerY,captionMaxBottomY:story.safeRegions.caption.maxBottomY,nativeCaptionLinePercent:71,checks},null,2)+'\n');
}finally{await cdp?.close();await terminateOwnedProcess(chrome);await new Promise(r=>server.close(r));await removeScratchDirectory(scratch);}
console.log(out);
