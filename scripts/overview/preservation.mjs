// Assert the user's byte-preservation contract against the signed prior collection.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'../..'),base=process.argv[2]??'c0958386573fdead2babcf4c8c32b61eb01b03b2';
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const path='site/assets/videos/provenance.json',before=JSON.parse(git('show',`${base}:${path}`)),after=JSON.parse(readFileSync(join(root,path),'utf8'));
assert.equal(before.clips.length,11);assert.equal(after.clips.length,12);assert.equal(after.clips[0].id,'product-overview');
const checks=[];
for(const clip of before.clips){
 const current=after.clips.find(c=>c.id===clip.id);assert.equal(JSON.stringify(current),JSON.stringify(clip),`${clip.id}: per-clip record changed`);
 const files=[clip.files.mp4.file,clip.files.webm.file,clip.files.poster,clip.files.captions,clip.files.steps];
 for(const file of files){const p=`site/assets/videos/${file}`;assert.equal(git('hash-object',p),git('rev-parse',`${base}:${p}`),`${file}: asset changed`);}
 checks.push({id:clip.id,recordBytesUnchanged:true,assetBytesUnchanged:files});
}
writeFileSync(join(root,'site/assets/videos/overview-preservation.json'),JSON.stringify({baseRevision:base,originalClips:11,unchangedAssets:55,checks},null,2)+'\n');console.log('Preserved all eleven per-clip records and all 55 existing clip assets byte-for-byte.');
