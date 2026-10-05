// Append one illustrated film without rewriting or recapturing the eleven UI entries.
import {readFileSync,writeFileSync,copyFileSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createCaptions} from './captions.mjs';
const root=resolve(import.meta.dirname,'../..'),dir=join(root,'site/assets/videos');
const input=resolve(process.argv[2]??'/tmp/chimera-overview-final');
const story=JSON.parse(readFileSync(join(import.meta.dirname,'story.json'),'utf8'));
const capture=JSON.parse(readFileSync(join(input,'chimera-product-overview.capture.json'),'utf8'));
const path=join(dir,'provenance.json'),manifest=JSON.parse(readFileSync(path,'utf8'));
if(capture.durationSeconds!==90||capture.fps!==30||capture.sourceTreeDirty)throw Error('Expected clean full-length capture.');
// Reject stale candidates before copying a single asset.
for(const file of ['story.json','scene.mjs','captions.mjs','capture.mjs']){const captured=execFileSync('git',['show',`${capture.captureSourceRevision}:scripts/overview/${file}`],{cwd:root});if(!captured.equals(readFileSync(join(import.meta.dirname,file))))throw Error(`Stale overview capture: ${file} differs from the recorded source`);}
// Reassembly replaces only our own film after source validation.
manifest.clips=manifest.clips.filter(c=>c.id!==story.id);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const ffmpeg=process.env.FFMPEG??'/tmp/chimera-media-tools/ffmpeg';
const files={};const hashes={contentHash:capture.contentHash};
for(const format of ['mp4','webm']){
  const f=capture.files[format];copyFileSync(join(input,f.file),join(dir,f.file));files[format]={file:f.file,bytes:statSync(join(dir,f.file)).size,codec:f.codec};hashes[`${format}FileSha256`]=sha(readFileSync(join(dir,f.file)));
  const decoded=execFileSync(ffmpeg,['-v','error','-i',join(dir,f.file),'-f','framemd5','-'],{maxBuffer:2*1024*1024});hashes[`${format}DecodedHash`]=sha(decoded);
}
const base='chimera-product-overview';files.poster=`${base}.poster.jpg`;copyFileSync(join(input,files.poster),join(dir,files.poster));files.captions=`${base}.vtt`;files.steps=`${base}.steps.txt`;
writeFileSync(join(dir,files.captions),createCaptions(story.chapters));
writeFileSync(join(dir,files.steps),`${story.title}\n90 seconds · original illustrated animation · silent\n\n`+story.chapters.map(ch=>`${ch.start}–${ch.end}s: ${ch.title.replaceAll('\n',' ')}\n${ch.caption}\n${ch.motion}\n`).join('\n')+`\n${story.limits}\n\nExplore on GitHub: https://github.com/nedimyilmaz/chimera\nFeature guide: https://nedimyilmaz.github.io/chimera/features.html\nHow made: https://nedimyilmaz.github.io/chimera/how-made.html#videos\n`);
const clip={id:story.id,title:story.title.replaceAll('\n',' '),kind:'illustrated-animation',captureSourceRevision:capture.captureSourceRevision,captureSourceTree:capture.captureSourceTree,sourceTreeDirty:false,durationSeconds:90,frames:2700,width:1600,height:1000,fps:30,scenario:'An illustrated overview of Chimera capability families',notice:story.limits,rendering:capture.rendering,colorEncoding:capture.colorEncoding,capturedWith:{browser:capture.browser,ffmpeg:capture.ffmpeg,mp4Encoder:'libx264 H.264',webmEncoder:'libvpx VP8'},readability:{headlinePxAt360:17.55,captionPxAt360:13.05,captionPxAt390:14.1375,safeRegions:story.safeRegions,openingDescriptor:story.openingDescriptor,notice:'Large chapter headlines remain readable at phone width. Expand for secondary diagram labels; native captions and text steps carry the complete wording.'},steps:story.chapters.map(ch=>({atSeconds:ch.start,text:ch.caption})),chapters:story.chapters,files,hashes};
manifest.notice="The first film is original illustrated animation explaining Chimera capability families. The eleven interface demos film the real Chimera UI against a SCRIPTED FIXTURE daemon with fictional 'Atlas website' data. None records agents executing work or measures performance.";
if(!manifest.timeline.note.includes('illustrated overview carries'))manifest.timeline.note+=' This timeline describes the eleven interface demos only; the illustrated overview carries its own 30fps 1600x1000 timeline.';
manifest.clips.unshift(clip);
const usedSources=new Set(manifest.clips.map(c=>c.captureSourceRevision));
manifest.captureSourceRevisions=[...new Set([...manifest.captureSourceRevisions.filter(s=>usedSources.has(s)),capture.captureSourceRevision])];
// JSON round-trip leaves each existing clip's serialized fields/order exactly unchanged.
writeFileSync(path,JSON.stringify(manifest,null,2)+'\n');
let md=readFileSync(join(dir,'provenance.md'),'utf8').split('\n## Illustrated product overview')[0];md=md.replace(/> These videos[^\n]+/,`> ${manifest.notice}`);md=md.replace('## Real vs scripted','## Interface demos: real vs scripted');
md+=`\n## Illustrated product overview\n\nOriginal Canvas animation, not real product UI. ${story.limits}\n\n- Exact scene/capture source: \`${capture.captureSourceRevision}\`, tree \`${capture.captureSourceTree}\`; clean committed source.\n- 90 seconds, 2700 frames, 30fps, 1600×1000, silent H.264 MP4 (${files.mp4.bytes} bytes) and VP8 WebM (${files.webm.bytes} bytes).\n- Browser: ${capture.browser}. Encoders: libx264 and libvpx; ${capture.ffmpeg}.\n- Source: scripts/overview/story.json, scene.mjs and capture.mjs. Reproduce with \`node scripts/overview/capture.mjs --out=/tmp/chimera-overview-final\`.\n- The eleven original films, their per-clip records and their assets were preserved. Their 15fps collection timeline above does not apply to this overview.\n- Container SHA256 and complete decoded-frame hashes are recorded in the new clip entry. No second-capture pixel identity or live-provider claim.\n`;
writeFileSync(join(dir,'provenance.md'),md);
console.log(`Assembled overview captured from ${capture.captureSourceRevision}`);
