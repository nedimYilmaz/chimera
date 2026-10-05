#!/usr/bin/env node
// Static validator for the GitHub Pages site (every site/*.html page, site/features.json) and the README links.
// No dependencies, so it runs the same in the private repo, the public mirror and CI.
//
// Usage:  node scripts/validate-site.mjs [--allow-missing-assets]
//
// Why a separate check: the public mirror strips docs/, examples/ and several top-level
// guides (.github/public-exclude). A link that works in the private tree can 404 on the
// public one, and the Pages artifact is only `site/`, so every path must resolve there.
// `.github/public-exclude` itself is absent from the mirror; the exclusion checks then
// skip, and plain existence is the check.
//
// --allow-missing-assets: screenshots under site/assets/ may not exist yet in a local
// preview. CI never passes it, so a deploy without the real images fails.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowMissingAssets = process.argv.includes("--allow-missing-assets");
const REPO = "https://github.com/nedimYilmaz/chimera";
const PAGES = "https://nedimyilmaz.github.io/chimera/";

const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const read = (p) => readFileSync(join(root, p), "utf8");

// ——— public-exclude ———
const excludePath = join(root, ".github/public-exclude");
const excludes = existsSync(excludePath)
  ? read(".github/public-exclude")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.replace(/\/+$/, ""))
  : null;
if (!excludes) warnings.push("`.github/public-exclude` not found (public mirror?) — exclusion checks skipped");

const isExcluded = (rel) => !!excludes?.some((e) => rel === e || rel.startsWith(`${e}/`));

for (const must of ["site", ".github/workflows/pages.yml", "scripts/validate-site.mjs", "README.md", "LICENSE"]) {
  if (isExcluded(must)) fail(`${must} is listed in .github/public-exclude, so it would not reach the public repo`);
}

// ——— helpers ———
const isAssetPath = (rel) => rel.startsWith("site/assets/");
function checkRepoPath(rel, from) {
  const clean = posix.normalize(rel.replace(/[?#].*$/, ""));
  if (clean.startsWith("..") || clean.startsWith("/")) return fail(`${from}: path escapes the repo: ${rel}`);
  const target = clean === "." ? "" : clean;
  if (isExcluded(target)) return fail(`${from}: ${rel} is stripped from the public mirror`);
  if (!existsSync(join(root, target))) {
    if (allowMissingAssets && isAssetPath(target)) return warnings.push(`${from}: ${rel} not present yet (allowed)`);
    fail(`${from}: ${rel} does not exist`);
  }
}

const attrs = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
const FORBIDDEN_TERMS = [/\bTUI\b/i, /terminal\s+ui/i, /chimera\s+tui/i];
// The MCP tool surface changes release to release; a hardcoded number goes stale silently.
const TOOL_COUNT = /\b(?:about|around|over|nearly|~)?\s*\d{2,3}\+?\s+(?:mcp\s+|core\s+|engine\s+)?tools\b/i;
function checkToolCounts(text, from) {
  const m = TOOL_COUNT.exec(text);
  if (m) fail(`${from}: hardcoded tool count ("${m[0].trim()}") — describe the surface without a number`);
}
function checkTerms(text, from) {
  for (const re of FORBIDDEN_TERMS) if (re.test(text)) fail(`${from}: mentions the retired terminal UI (${re})`);
}

// ——— site/*.html ———
// Every page in site/ gets the same checks; ids are collected first so a link on one page
// can be checked against a fragment on another (index.html -> features.html#schedules).
const siteDir = join(root, "site");
const pages = existsSync(siteDir)
  ? readdirSync(siteDir).filter((f) => f.endsWith(".html")).sort().map((f) => `site/${f}`)
  : [];
for (const must of ["site/index.html", "site/features.html"]) {
  if (!pages.includes(must)) fail(`${must} is missing`);
}
const idsByPage = new Map(pages.map((p) => [p, attrs(read(p), /\sid="([^"]+)"/g)]));

// Resolves `features.html#x`, `./#x` or `index.html#x` (already known to exist) to a page's ids.
function idsFor(clean) {
  const file = clean === "" || clean.endsWith("/") ? `${clean}index.html` : clean;
  return idsByPage.get(`site/${posix.normalize(file)}`);
}

function checkPage(htmlPath) {
  const html = read(htmlPath);
  checkTerms(html, htmlPath);
  checkToolCounts(html, htmlPath);

  const need = [
    [/<html[^>]*\slang="[a-z-]+"/i, "<html lang>"],
    [/<title>[^<]{10,}<\/title>/i, "<title>"],
    [/<meta[^>]+name="description"[^>]+content="[^"]{50,}"/i, "meta description"],
    [/<link[^>]+rel="canonical"/i, "canonical link"],
    [/<meta[^>]+name="viewport"/i, "viewport meta"],
    [/<meta[^>]+property="og:image"/i, "og:image"],
    [/<main[\s>]/i, "<main>"],
  ];
  for (const [re, what] of need) if (!re.test(html)) fail(`${htmlPath}: missing ${what}`);

  const h1s = (html.match(/<h1[\s>]/gi) ?? []).length;
  if (h1s !== 1) fail(`${htmlPath}: expected exactly one <h1>, found ${h1s}`);

  const canonical = /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i.exec(html)?.[1];
  const expected = `${PAGES}${htmlPath === "site/index.html" ? "" : htmlPath.slice("site/".length)}`;
  if (canonical && canonical !== expected) fail(`${htmlPath}: canonical is ${canonical}, expected ${expected}`);

  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!/\balt=/.test(m[0])) fail(`${htmlPath}: <img> without alt: ${m[0].slice(0, 80)}`);
  }

  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try { JSON.parse(m[1]); } catch (e) { fail(`${htmlPath}: JSON-LD does not parse: ${e.message}`); }
  }

  const ids = idsByPage.get(htmlPath);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) fail(`${htmlPath}: duplicate ids: ${[...new Set(dup)].join(", ")}`);
  for (const ref of attrs(html, /\saria-labelledby="([^"]+)"/g)) {
    if (!ids.includes(ref)) fail(`${htmlPath}: aria-labelledby points at missing id "${ref}"`);
  }

  // Everything fetched by the browser must be local: no trackers, CDNs or web fonts.
  const fetched = [
    ...attrs(html, /<script[^>]+\ssrc="([^"]+)"/gi),
    ...attrs(html, /<img[^>]+\ssrc="([^"]+)"/gi),
    ...[...html.matchAll(/<link\b[^>]*>/gi)].flatMap((m) => {
      const rel = /rel="([^"]+)"/.exec(m[0])?.[1] ?? "";
      const href = /href="([^"]+)"/.exec(m[0])?.[1];
      return href && /stylesheet|icon|preload|modulepreload/.test(rel) ? [href] : [];
    }),
  ];
  for (const u of fetched) {
    if (/^(https?:)?\/\//i.test(u)) fail(`${htmlPath}: external resource loaded: ${u}`);
  }

  // Relative links/sources must resolve inside site/ (the whole Pages artifact).
  const relative = [
    ...attrs(html, /\s(?:href|src|poster)="([^"]+)"/g),
  ].filter((u) => !/^(https?:|mailto:|data:|tel:|#)/i.test(u));
  for (const u of new Set(relative)) {
    const clean = u.replace(/[?#].*$/, "");
    if (clean.startsWith("/")) { fail(`${htmlPath}: root-absolute URL breaks the /chimera/ project base: ${u}`); continue; }
    const abs = normalize(join(siteDir, clean));
    if (!abs.startsWith(siteDir + sep)) { fail(`${htmlPath}: ${u} escapes site/`); continue; }
    if (!existsSync(abs)) {
      const rel = `site/${posix.normalize(clean)}`;
      if (allowMissingAssets && isAssetPath(rel)) warnings.push(`${htmlPath}: ${u} not present yet (allowed)`);
      else fail(`${htmlPath}: ${u} does not exist in site/`);
      continue;
    }
    const frag = /#(.+)$/.exec(u)?.[1];
    if (frag && /\.html$|\/$|^$/.test(clean)) {
      const target = idsFor(clean);
      if (target && !target.includes(frag)) fail(`${htmlPath}: ${u} points at a missing id`);
    }
  }

  // #fragment links must hit an id on the page.
  for (const f of new Set(attrs(html, /\shref="#([^"]+)"/g))) {
    if (!ids.includes(f)) fail(`${htmlPath}: #${f} has no matching id`);
  }

  // Absolute URLs into this repo or the Pages site must also be real, public paths.
  for (const u of new Set(attrs(html, /(?:href|content)="(https:\/\/[^"]+)"/g))) {
    if (u.startsWith(PAGES) && u !== PAGES) {
      const rest = u.slice(PAGES.length);
      checkRepoPath(`site/${rest}`, `${htmlPath} (${u})`);
      const frag = /#(.+)$/.exec(rest)?.[1];
      const target = frag && idsFor(rest.replace(/[?#].*$/, ""));
      if (target && !target.includes(frag)) fail(`${htmlPath} (${u}): missing id`);
    }
    const m = new RegExp(`^${REPO}/(?:blob|tree)/main/(.+)$`).exec(u);
    if (m) checkRepoPath(m[1], `${htmlPath} (${u})`);
  }
}
for (const p of pages) checkPage(p);

// Native video policy and complete bounded assets; poster URLs are checked above too.
for (const page of pages) {
  for (const match of read(page).matchAll(/<video\b[^>]*>[\s\S]*?<\/video>/gi)) {
    const video = match[0], tag = video.slice(0, video.indexOf('>'));
    for (const [ok, reason] of [[/\bcontrols\b/.test(tag),'native controls'], [/\bplaysinline\b/.test(tag),'inline playback'], [/preload="(?:none|metadata)"/.test(tag),'bounded preload'], [/poster="[^"]+"/.test(tag),'static poster'], [! /\bautoplay\b/.test(tag),'user-initiated playback'], [/<track\b[^>]*kind="captions"/.test(video),'caption track']]) if (!ok) fail(`${page}: video missing ${reason}`);
  }
}
if (existsSync(join(root,'site/videos.html'))) {
  try {
    const provenance = JSON.parse(read('site/assets/videos/provenance.json'));
    if (provenance.clips.length < 5 || provenance.clips.length > 7) fail('videos: expected 5–7 clips');
    if (provenance.sourceTreeDirty) fail('videos: fixture capture source was dirty');
    for (const clip of provenance.clips) {
      if (clip.durationSeconds < 15 || clip.durationSeconds > 40) fail(`videos: ${clip.id} pacing`);
      for (const format of ['webm','mp4']) {
        const f = clip.files[format]; if (!f) { fail(`videos: ${clip.id} missing ${format}`); continue; }
        checkRepoPath(`site/assets/videos/${f.file}`,`videos:${clip.id}`);
        const file = join(root,'site/assets/videos',f.file);
        if (existsSync(file) && (statSync(file).size !== f.bytes || f.bytes > 15*1024*1024)) fail(`videos: ${f.file} size mismatch or over 15 MiB`);
      }
      for (const name of ['poster','captions','steps']) checkRepoPath(`site/assets/videos/${clip.files[name]}`,`videos:${clip.id}`);
      if (!idsByPage.get('site/videos.html')?.includes(clip.id)) fail(`videos: ${clip.id} missing player`);
    }
  } catch (e) { fail(`videos: ${e.message}`); }
}

// ——— Feature inventory (site/features.json) ———
// features.html and the generated regions of index.html are built from it by
// scripts/build-features.mjs, so labels, alt text and counts have one source. Evidence paths
// are public repo paths; the guide links them, so each must exist on the mirror.
const featuresPath = "site/features.json";
if (existsSync(join(root, featuresPath))) {
  const raw = read(featuresPath);
  if (/\/Users\/|\.chimera\/|\$\s?\d/.test(raw)) fail(`${featuresPath}: contains a private path or a cost figure`);
  checkToolCounts(raw, featuresPath);
  checkTerms(raw, featuresPath);
  let data;
  try { data = JSON.parse(raw); } catch (e) { fail(`${featuresPath}: does not parse: ${e.message}`); }
  if (data) {
    for (const c of data.categories ?? []) {
      for (const ev of c.evidence ?? []) checkRepoPath(ev, `${featuresPath} (${c.id})`);
      if (c.figure?.src) checkRepoPath(`site/${c.figure.src}`, `${featuresPath} (${c.id} figure)`);
    }
    const indexHtml = existsSync(join(root, "site/index.html")) ? read("site/index.html") : "";
    for (const c of data.categories ?? []) {
      if (!indexHtml.includes(`href="features.html#${c.id}"`)) fail(`site/index.html: no link to features.html#${c.id}`);
      if (!idsByPage.get("site/features.html")?.includes(c.id)) fail(`site/features.html: no section with id "${c.id}"`);
    }
    try {
      const { buildAll } = await import("./build-features.mjs");
      for (const [rel, content] of Object.entries(buildAll(root))) {
        if (!existsSync(join(root, rel)) || read(rel) !== content) {
          fail(`${rel} is out of date with ${featuresPath}: run \`node scripts/build-features.mjs\``);
        }
      }
    } catch (e) {
      fail(`scripts/build-features.mjs: ${e.message}`);
    }
  }
} else {
  fail(`${featuresPath} is missing`);
}

// ——— CSS / JS ———
for (const f of ["site/styles.css", "site/script.js"]) {
  if (!existsSync(join(root, f))) { fail(`${f} is missing`); continue; }
  const src = read(f);
  if (/@import|url\(\s*["']?https?:|https?:\/\/(?!nedimyilmaz\.github\.io|github\.com)/i.test(src.replace(/\/\*[\s\S]*?\*\//g, ""))) {
    fail(`${f}: references an external origin`);
  }
}
if (!/prefers-reduced-motion/.test(read("site/styles.css"))) fail("site/styles.css: no prefers-reduced-motion handling");

// ——— README ———
{
  const md = read("README.md");
  checkTerms(md, "README.md");
  checkToolCounts(md, "README.md");
  const inline = [...md.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
  const html = attrs(md, /(?:href|src|poster)="([^"]+)"/g);
  for (const u of new Set([...inline, ...html])) {
    if (u.startsWith("#") || /^(mailto:|data:)/i.test(u)) continue;
    if (/^https?:\/\//i.test(u)) {
      const m = new RegExp(`^${REPO}/(?:blob|tree)/[^/]+/(.+)$`).exec(u);
      if (m) checkRepoPath(m[1], `README.md (${u})`);
      if (u.startsWith(PAGES) && u !== PAGES) checkRepoPath(`site/${u.slice(PAGES.length)}`, `README.md (${u})`);
      continue;
    }
    checkRepoPath(u, `README.md (${u})`);
  }
  if (!md.includes(PAGES)) fail("README.md: does not link the landing page " + PAGES);
  if (!md.includes(PAGES + "features.html")) fail("README.md: does not link the feature guide " + PAGES + "features.html");
}

// ——— Pages workflow ———
{
  const wf = read(".github/workflows/pages.yml");
  const rules = [
    [/github\.repository\s*==\s*'nedimYilmaz\/chimera'/, "guard `github.repository == 'nedimYilmaz/chimera'`"],
    [/pages:\s*write/, "`pages: write`"],
    [/id-token:\s*write/, "`id-token: write`"],
    [/path:\s*site\s*$/m, "artifact path `site`"],
    [/concurrency:/, "a concurrency group"],
  ];
  for (const [re, what] of rules) if (!re.test(wf)) fail(`.github/workflows/pages.yml: missing ${what}`);
  for (const m of wf.matchAll(/uses:\s*(\S+)/g)) {
    if (!/@[0-9a-f]{40}\b/.test(m[1])) fail(`.github/workflows/pages.yml: action not pinned to a full SHA: ${m[1]}`);
  }
}

// ——— Report ———
for (const w of warnings) console.warn(`warn  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`FAIL  ${e}`);
  console.error(`\nvalidate-site: ${errors.length} problem(s)`);
  process.exit(1);
}
console.log(`validate-site: ok${allowMissingAssets ? " (missing assets allowed)" : ""}`);
