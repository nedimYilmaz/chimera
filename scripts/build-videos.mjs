// Static demo page and README poster links. Native video controls and text links work without JS.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'site/assets/videos/provenance.json'), 'utf8'));
const escape = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const asset = f => `assets/videos/${escape(f)}`;
const cards = manifest.clips.map(c => `<article class="demo-card" id="${c.id}" aria-labelledby="title-${c.id}">
<h2 id="title-${c.id}">${escape(c.title)}</h2>
<p>${c.durationSeconds.toFixed(1)} seconds</p>
<video controls playsinline preload="none" loading="lazy" width="1280" height="800" poster="${asset(c.files.poster)}" aria-label="${escape(c.title)}" aria-describedby="motion-note">
${c.files.mp4 ? `<source src="${asset(c.files.mp4.file)}" type="video/mp4">` : ''}
<source src="${asset(c.files.webm.file)}" type="video/webm">
<track kind="captions" src="${asset(c.files.captions)}" srclang="en" label="English" default>
Your browser cannot play this video. Read the text steps below.
</video>
<p class="demo-links"><a href="${asset(c.files.steps)}">Text steps</a><a href="${asset(c.files.poster)}">Static poster</a><a href="${asset(c.files.captions)}">English captions</a>${c.files.mp4 ? `<a href="${asset(c.files.mp4.file)}">MP4 · ${(c.files.mp4.bytes/1024/1024).toFixed(1)} MB</a>` : ''}<a href="${asset(c.files.webm.file)}">WebM</a></p>
</article>`).join('\n');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chimera product demos — six workflows in the real interface</title>
<meta name="description" content="Watch six short animated Chimera workflows with native controls, English captions and static text steps. Explore teams, queues, memory and more.">
<link rel="canonical" href="https://nedimyilmaz.github.io/chimera/videos.html">
<meta property="og:image" content="https://nedimyilmaz.github.io/chimera/assets/og-image.png">
<link rel="icon" href="favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="styles.css">
</head><body><header class="sec"><div class="wrap"><nav class="demo-nav" aria-label="Site"><a href="index.html">Chimera home</a><a href="features.html">Feature guide</a><a href="https://github.com/nedimYilmaz/chimera">GitHub</a></nav></div></header>
<main id="main" class="sec"><div class="wrap"><p class="eyebrow">Short product demos</p><h1>Your agents. One workspace.</h1>
<p class="sub">Six focused workflows in the actual Chimera interface. Watch with captions and controls, or read the text steps.</p>
<p id="motion-note">These silent videos contain eased zoom/pan and pointer motion. Playback starts only when you choose it. For reduced motion, use each static poster and text steps. Captions and controls work without JavaScript. Expand the player to inspect small UI text.</p>
<div class="demo-grid">${cards}</div>
<p class="fine"><a href="how-made.html#videos">How these videos were made</a>.</p>
</div></main></body></html>\n`;
const tiles=manifest.clips.map(c=>`<td width="50%"><a href="https://nedimyilmaz.github.io/chimera/videos.html#${c.id}"><img src="site/assets/videos/${c.files.poster}" alt="${escape(c.title)} — play the demo" width="420"></a><br><strong>${escape(c.title)}</strong> · ${c.durationSeconds.toFixed(1)}s</td>`);
const posters=`<table>\n${tiles.map((t,i)=>i%2===0?`<tr>${t}${tiles[i+1]??''}</tr>`:'').filter(Boolean).join('\n')}\n</table>`;
const readmePath = join(root,'README.md');
const readme = readFileSync(readmePath,'utf8').replace(/<!-- videos:readme:start -->[\s\S]*?<!-- videos:readme:end -->/, `<!-- videos:readme:start -->\n${posters}\n<!-- videos:readme:end -->`);
const outputs = { 'site/videos.html':html, 'README.md':readme };
let stale=false;
for (const [path, content] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) { if (readFileSync(join(root,path),'utf8') !== content) { console.error(`${path} is stale`); stale=true; } }
  else writeFileSync(join(root,path),content);
}
if(stale) process.exitCode=1;
