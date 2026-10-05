// Compare decoded flat regions against the captured Canvas PNG, across both codecs.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const dir=resolve(process.argv[2]),ffmpeg=process.env.FFMPEG??'/tmp/chimera-media-tools/ffmpeg',ffprobe=process.env.FFPROBE??'/tmp/chimera-media-tools/ffprobe';
const capture=JSON.parse(readFileSync(join(dir,'chimera-product-overview.capture.json'),'utf8'));
const metadata={};
for(const format of ['mp4','webm']){
 const v=JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-of','json',join(dir,`chimera-product-overview.${format}`)],{encoding:'utf8'})).streams[0];
 assert.equal(v.pix_fmt,'yuv420p');assert.equal(v.color_range,'tv');assert.equal(v.color_space,'bt470bg');
 metadata[format]={pix_fmt:v.pix_fmt,color_range:v.color_range,color_space:v.color_space};
}
function sample(file,time,x,y){
 const bytes=execFileSync(ffmpeg,['-v','error',...(time===null?[]:['-ss',String(time)]),'-i',file,'-vf',`crop=16:16:${x}:${y},format=rgb24`,'-frames:v','1','-f','rawvideo','-']);
 assert.equal(bytes.length,16*16*3);
 return [0,1,2].map(channel=>{let sum=0;for(let i=channel;i<bytes.length;i+=3)sum+=bytes[i];return +(sum/256).toFixed(3);});
}
const checks=[];
for(const [time,name,x,y] of [[30,'cream',8,920],[30,'queue panel',130,455],[30,'task card',400,396],[54,'graphite background',8,920],[54,'tool card',185,327]]){
 const source=sample(join(dir,`frame-${time.toFixed(1)}.png`),null,x,y),decoded={};
 for(const format of ['mp4','webm']){
  const rgb=sample(join(dir,`chimera-product-overview.${format}`),time,x,y),maxError=Math.max(...rgb.map((n,i)=>Math.abs(n-source[i])));
  assert.ok(maxError<=8,`${name}/${format}: clipped or shifted color (${maxError})`);decoded[format]={rgb,maxChannelError:+maxError.toFixed(3)};
 }
 const crossCodecError=Math.max(...decoded.mp4.rgb.map((n,i)=>Math.abs(n-decoded.webm.rgb[i])));
 assert.ok(crossCodecError<=8,`${name}: codec color disagreement`);checks.push({time,name,region:{x,y,width:16,height:16},source,decoded,crossCodecError:+crossCodecError.toFixed(3)});
}
const report={captureSourceRevision:capture.captureSourceRevision,captureSourceTree:capture.captureSourceTree,metadata,thresholdPerChannel:8,checks};
writeFileSync(join(dir,'color-verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
