#!/usr/bin/env node
// Renders the public feature guide from its single source, site/features.json:
//   - site/features.html                 (whole file is generated)
//   - site/index.html                    (only the marker-delimited regions below)
//
// Usage:  node scripts/build-features.mjs [--check]
//
// Why generated: the guide, the homepage feature map and the homepage gallery all name the
// same areas and reuse the same screenshot alt text. One JSON file keeps those from drifting,
// and `validate-site.mjs` fails the Pages deploy if the checked-in HTML is stale.
// Edit site/features.json (or this renderer), run the script, commit the output.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PAGES = "https://nedimyilmaz.github.io/chimera/";
const REPO = "https://github.com/nedimYilmaz/chimera";

// Homepage gallery: the screens that tell a story at a glance. Order is the reading order.
const GALLERY = ["teams", "projects", "roles", "schedules", "mcp-store", "secrets", "computer-use"];

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STATUS_LABEL = { preview: "Preview", experimental: "Experimental" };

function check(data) {
  const fams = new Set(data.families.map((f) => f.id));
  const ids = new Set();
  for (const c of data.categories) {
    if (!fams.has(c.family)) throw new Error(`features.json: ${c.id}: unknown family "${c.family}"`);
    if (ids.has(c.id) || /^family-|^guide-|^(top|main|limits)$/.test(c.id)) throw new Error(`features.json: bad or duplicate id "${c.id}"`);
    ids.add(c.id);
    for (const k of ["label", "title", "short", "keywords", "problem", "benefit", "scenario"]) {
      if (typeof c[k] !== "string" || !c[k].trim()) throw new Error(`features.json: ${c.id}: missing ${k}`);
    }
    if (!c.groups?.length || c.groups.some((g) => !g.items?.length)) throw new Error(`features.json: ${c.id}: empty group`);
    if (c.figure && !(c.figure.src && c.figure.alt && c.figure.caption)) throw new Error(`features.json: ${c.id}: incomplete figure`);
    if (c.status && !STATUS_LABEL[c.status]) throw new Error(`features.json: ${c.id}: unknown status "${c.status}"`);
  }
  for (const f of data.families) {
    if (!data.categories.some((c) => c.family === f.id)) throw new Error(`features.json: family "${f.id}" has no categories`);
  }
  for (const a of data.advanced) if (!ids.has(a.in)) throw new Error(`features.json: advanced "${a.name}" targets unknown area "${a.in}"`);
  for (const g of GALLERY) {
    const c = data.categories.find((x) => x.id === g);
    if (!c?.figure) throw new Error(`build-features: gallery area "${g}" has no figure`);
  }
}

// ——— shared fragments ———
function figure(c, theme) {
  const f = c.figure;
  return [
    `<figure class="shot shot--${theme}">`,
    `  <a href="${esc(f.src)}" data-zoom><img src="${esc(f.src)}" width="1600" height="1000" alt="${esc(f.alt)}" loading="lazy" decoding="async"></a>`,
    `  <figcaption>${esc(f.caption)}</figcaption>`,
    `</figure>`,
  ].join("\n");
}

function sourceLink(root, rel) {
  const p = join(root, rel);
  const kind = existsSync(p) && statSync(p).isDirectory() ? "tree" : "blob";
  return `<li><a href="${REPO}/${kind}/main/${esc(rel)}"><code>${esc(rel)}</code></a></li>`;
}

function category(root, data, c) {
  const adv = data.advanced.filter((a) => a.in === c.id);
  const status = c.status ? ` <span class="pill pill--warn">${STATUS_LABEL[c.status]}</span>` : "";
  const fam = data.families.find((f) => f.id === c.family);
  const out = [];
  out.push(`<article class="cat" id="${c.id}" aria-labelledby="${c.id}-title" data-kw="${esc(c.keywords)}">`);
  out.push(`  <header class="cat__head">`);
  out.push(`    <p class="kicker">${esc(fam.title)}${status}</p>`);
  out.push(`    <h3 id="${c.id}-title">${esc(c.title)}</h3>`);
  out.push(`    <p class="cat__short">${esc(c.short)}</p>`);
  out.push(`  </header>`);
  out.push(`  <dl class="story">`);
  out.push(`    <div><dt>The problem</dt><dd>${esc(c.problem)}</dd></div>`);
  out.push(`    <div><dt>What changes</dt><dd>${esc(c.benefit)}</dd></div>`);
  out.push(`    <div><dt>In practice</dt><dd>${esc(c.scenario)}</dd></div>`);
  out.push(`  </dl>`);
  if (c.figure) out.push(figure(c, "light").replace(/^/gm, "  "));
  if (c.limits) out.push(`  <p class="limits"><strong>Limits.</strong> ${esc(c.limits)}</p>`);
  out.push(`  <div class="groups">`);
  c.groups.forEach((g, i) => {
    const gid = `${c.id}-g${i + 1}`;
    out.push(`    <section class="grp" aria-labelledby="${gid}">`);
    out.push(`      <h4 id="${gid}">${esc(g.title)}</h4>`);
    out.push(`      <dl class="items">`);
    for (const it of g.items) out.push(`        <div><dt>${esc(it.name)}</dt><dd>${esc(it.text)}</dd></div>`);
    out.push(`      </dl>`);
    out.push(`    </section>`);
  });
  out.push(`  </div>`);
  if (adv.length) {
    out.push(`  <details class="adv">`);
    out.push(`    <summary>Smaller capabilities in this area <span class="adv__n">(${adv.length})</span></summary>`);
    out.push(`    <ul>`);
    for (const a of adv) out.push(`      <li><strong>${esc(a.name)}</strong> ${esc(a.text)}</li>`);
    out.push(`    </ul>`);
    out.push(`  </details>`);
  }
  out.push(`  <details class="src">`);
  out.push(`    <summary>Where this lives in the source</summary>`);
  out.push(`    <ul>`);
  for (const rel of c.evidence) out.push(`      ${sourceLink(root, rel)}`);
  out.push(`    </ul>`);
  out.push(`  </details>`);
  out.push(`</article>`);
  return out.join("\n");
}

// ——— features.html ———
function head({ title, description, url, ogTitle }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${url}">
  <meta name="theme-color" content="#f4f1ea">
  <meta name="color-scheme" content="light">
  <link rel="icon" href="favicon.svg" type="image/svg+xml">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Chimera">
  <meta property="og:title" content="${esc(ogTitle)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${PAGES}assets/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="The Chimera desktop app showing agents and a conversation, showing its workspace.">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(ogTitle)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${PAGES}assets/og-image.png">

  <link rel="stylesheet" href="styles.css">
  <script src="script.js" defer></script>`;
}

function featuresPage(root, data) {
  const title = "Chimera feature guide — agents, queues, memory, MCP store, secrets and more";
  const description =
    "Searchable guide to every area of the Chimera desktop workspace: agents, projects, roles, teams, queues, schedules, memory, MCP store, secrets manager, computer use and more.";
  const url = `${PAGES}features.html`;
  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        name: "Chimera feature guide",
        url,
        description,
        isPartOf: { "@type": "WebSite", name: "Chimera", url: PAGES },
        about: { "@type": "SoftwareApplication", name: "Chimera", url: PAGES },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Chimera", item: PAGES },
          { "@type": "ListItem", position: 2, name: "Feature guide", item: url },
        ],
      },
    ],
  };

  const toc = data.families
    .map((f) => {
      const items = data.categories
        .filter((c) => c.family === f.id)
        .map((c) => `            <li data-for="${c.id}"><a href="#${c.id}">${esc(c.label)}</a></li>`)
        .join("\n");
      return [
        `          <div class="toc__fam" data-for-family="${f.id}">`,
        `            <p><a href="#family-${f.id}">${esc(f.title)}</a></p>`,
        `            <ul>`,
        items,
        `            </ul>`,
        `          </div>`,
      ].join("\n");
    })
    .join("\n");

  const families = data.families
    .map((f) => {
      const cats = data.categories.filter((c) => c.family === f.id).map((c) => category(root, data, c).replace(/^/gm, "      "));
      return [
        `    <section class="fam" id="family-${f.id}" aria-labelledby="family-${f.id}-title" data-family="${f.id}">`,
        `      <header class="fam__head">`,
        `        <h2 id="family-${f.id}-title">${esc(f.title)}</h2>`,
        `        <p class="sub">${esc(f.blurb)}</p>`,
        `      </header>`,
        cats.join("\n\n"),
        `    </section>`,
      ].join("\n");
    })
    .join("\n\n");

  const flagged = data.categories.filter((c) => c.status);
  const footFams = data.families.map((f) => `          <li><a href="#family-${f.id}">${esc(f.title)}</a></li>`).join("\n");

  return `${head({ title, description, url, ogTitle: "Chimera feature guide — every area, with a real scenario" })}
  <script type="application/ld+json">
${JSON.stringify(jsonld, null, 2).replace(/^/gm, "  ")}
  </script>
</head>
<body class="guide-page">
  <a class="skip" href="#main">Skip to content</a>

  <header class="top">
    <div class="wrap top__row">
      <a class="brand" href="index.html" aria-label="Chimera, back to the home page">
        <img src="favicon.svg" alt="" width="28" height="28">
        <span>Chimera</span>
      </a>
      <nav class="top__nav" aria-label="Site sections">
        <a href="index.html">Overview</a>
        <a href="features.html" aria-current="page">Feature guide</a>
        <a href="index.html#install">Install</a>
        <a href="index.html#faq">FAQ</a>
      </nav>
      <a class="btn btn--ghost btn--sm" href="${REPO}">GitHub<span aria-hidden="true"> ↗</span></a>
    </div>
  </header>

  <main id="main">
    <section class="ghero" id="top" aria-labelledby="guide-title">
      <div class="wrap">
        <p class="status"><span class="dot" aria-hidden="true"></span>Feature guide · early access</p>
        <h1 id="guide-title">What Chimera does, area by area.</h1>
        <p class="lede">Every area starts with the problem it solves, says what changes, walks one concrete scenario and then lists its sub-features. Search or filter below, or jump from the contents list.</p>
        <div id="guide-tools" class="gtools"></div>
        <p class="fine">${data.categories.length} areas in ${data.families.length} groups. Where an area is a preview or experimental, or only works on some platforms, it says so.</p>
      </div>
    </section>

    <div class="wrap guide">
      <nav class="toc" aria-label="Feature areas">
        <details class="toc__d" open>
          <summary>Jump to an area</summary>
          <div class="toc__list">
${toc}
          </div>
        </details>
      </nav>

      <div class="guide__body">
${families}

    <section class="fam fam--edges" id="limits" aria-labelledby="limits-title">
      <header class="fam__head">
        <h2 id="limits-title">Where this stands today</h2>
        <p class="sub">Chimera is early access software. The guide describes what the code does; it does not promise polish everywhere.</p>
      </header>
      <ul class="ticks ticks--warn">
        <li>macOS on Apple Silicon is the most tested platform. The Intel Mac build and the Linux AppImage have not yet been verified end to end on a clean machine, and on Windows only the CLI and MCP server install.</li>
        <li>One command installs the signed desktop app and the CLI on macOS and Linux; the <a href="index.html#install">install steps</a> are on the home page.</li>
${flagged.map((c) => `        <li><strong>${esc(c.label)}</strong> is ${STATUS_LABEL[c.status].toLowerCase()}.${c.limits ? ` ${esc(c.limits)}` : ""}</li>`).join("\n")}
      </ul>
      <p class="fine">Screenshots show the actual Chimera interface. <a href="how-made.html">How these images were made</a>.</p>
    </section>
      </div>
    </div>

    <section class="sec sec--dark final" aria-labelledby="guide-final-title">
      <div class="wrap final__row">
        <div class="final__copy">
          <h2 id="guide-final-title">Read the code, then run it.</h2>
          <p class="sub">Chimera is MIT licensed and developed in the open. Each area above links to the files that implement it.</p>
        </div>
        <div class="cta">
          <a class="btn btn--light" href="${REPO}">Explore on GitHub<span aria-hidden="true"> ↗</span></a>
          <a class="link link--dark" href="index.html#install">Install</a>
          <a class="link link--dark" href="${REPO}/issues">Share feedback</a>
        </div>
      </div>
    </section>
  </main>

  <footer class="foot">
    <div class="wrap foot__grid">
      <div class="foot__brand">
        <a class="brand brand--dark" href="index.html"><img src="favicon.svg" alt="" width="28" height="28"><span>Chimera</span></a>
        <p>A desktop workspace for Claude and Codex agent teams.</p>
      </div>
      <nav aria-label="Project links">
        <h2 class="foot__h">Project</h2>
        <ul>
          <li><a href="index.html">Home page</a></li>
          <li><a href="${REPO}">GitHub repository</a></li>
          <li><a href="${REPO}/issues">Issues</a></li>
          <li><a href="${REPO}/blob/main/LICENSE">MIT license</a></li>
        </ul>
      </nav>
      <nav aria-label="Feature groups">
        <h2 class="foot__h">In this guide</h2>
        <ul>
${footFams}
        </ul>
      </nav>
    </div>
    <div class="wrap foot__note">
      <p>Screenshots: actual Chimera interface. <a href="how-made.html">How these images were made</a>.</p>
      <p>Early access software. Issues are welcome; changes from pull requests are applied in the maintainer's tree.</p>
    </div>
  </footer>

  <dialog class="lightbox" aria-label="Screenshot preview">
    <form method="dialog"><button class="lightbox__close" aria-label="Close preview">Close <span aria-hidden="true">✕</span></button></form>
    <img alt="">
    <p class="lightbox__cap"></p>
  </dialog>
</body>
</html>
`;
}

// ——— index.html regions ———
function homeGrid(data) {
  const cards = data.families
    .map((f) => {
      const rows = data.categories
        .filter((c) => c.family === f.id)
        .map((c) => {
          const flag = c.status ? ` <span class="pill pill--warn">${STATUS_LABEL[c.status]}</span>` : "";
          return `              <li><a href="features.html#${c.id}"><strong>${esc(c.label)}</strong>${flag}<span>${esc(c.short)}</span></a></li>`;
        })
        .join("\n");
      return [
        `          <section class="fcard" aria-labelledby="fmap-${f.id}">`,
        `            <h3 id="fmap-${f.id}"><a href="features.html#family-${f.id}">${esc(f.title)}</a></h3>`,
        `            <p>${esc(f.blurb)}</p>`,
        `            <ul>`,
        rows,
        `            </ul>`,
        `          </section>`,
      ].join("\n");
    })
    .join("\n");
  return `    <section class="sec sec--tint fmap" id="features" aria-labelledby="features-title">
      <div class="wrap">
        <div class="head head--wide">
          <p class="kicker">The rest of the workshop</p>
          <h2 id="features-title">Every area, and what it is for.</h2>
          <p class="sub">The queue and memory screens above are two of ${data.categories.length} areas. Each one below opens a section of the feature guide: the problem, a concrete scenario and every sub-feature.</p>
          <p class="cta"><a class="btn btn--primary" href="features.html">Open the feature guide</a></p>
        </div>
        <div class="fmap__grid">
${cards}
        </div>
      </div>
    </section>`;
}

function homeGallery(data) {
  const items = GALLERY.map((id) => {
    const c = data.categories.find((x) => x.id === id);
    return [
      `          <article class="gal__item">`,
      figure(c, "dark").replace(/^/gm, "            "),
      `            <h3>${esc(c.label)}</h3>`,
      `            <p>${esc(c.short)}. <a class="link link--dark" href="features.html#${c.id}">Read about ${esc(c.label.toLowerCase())}<span aria-hidden="true"> →</span></a></p>`,
      `          </article>`,
    ].join("\n");
  }).join("\n");
  return `    <section class="sec sec--dark gal" id="gallery" aria-labelledby="gallery-title">
      <div class="wrap">
        <div class="head head--wide">
          <p class="kicker">In the app</p>
          <h2 id="gallery-title">Seven more screens, as they really look.</h2>
          <p class="sub">Explore the actual Chimera interface. Select a screenshot to enlarge it.</p>
        </div>
        <div class="gal__grid">
${items}
          <article class="gal__item gal__more">
            <h3>${data.categories.length} areas in the guide</h3>
            <p>Workflows, hooks, memory graphs, review, history and more, each with a scenario and its sub-features.</p>
            <p class="cta"><a class="btn btn--light" href="features.html">Open the feature guide</a></p>
          </article>
        </div>
      </div>
    </section>`;
}

const REGIONS = { grid: homeGrid, gallery: homeGallery };

function region(name, body) {
  return `<!-- features:${name}:start (generated by scripts/build-features.mjs from site/features.json — do not edit) -->\n${body}\n    <!-- features:${name}:end -->`;
}

function injectRegions(html, data) {
  let out = html;
  for (const [name, render] of Object.entries(REGIONS)) {
    const re = new RegExp(`<!-- features:${name}:start[^>]*-->[\\s\\S]*?<!-- features:${name}:end -->`);
    if (!re.test(out)) throw new Error(`site/index.html: missing <!-- features:${name}:start --> … end marker pair`);
    out = out.replace(re, () => region(name, render(data)));
  }
  return out;
}

/** Returns the expected content of every generated file, keyed by repo-relative path. */
export function buildAll(root = resolve(here, "..")) {
  const data = JSON.parse(readFileSync(join(root, "site/features.json"), "utf8"));
  check(data);
  const indexPath = join(root, "site/index.html");
  return {
    "site/features.html": featuresPage(root, data),
    "site/index.html": injectRegions(readFileSync(indexPath, "utf8"), data),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(here, "..");
  const built = buildAll(root);
  const checkOnly = process.argv.includes("--check");
  let stale = 0;
  for (const [rel, content] of Object.entries(built)) {
    const p = join(root, rel);
    const current = existsSync(p) ? readFileSync(p, "utf8") : null;
    if (current === content) continue;
    stale++;
    if (checkOnly) console.error(`stale  ${rel}`);
    else { writeFileSync(p, content); console.log(`wrote  ${rel}`); }
  }
  if (checkOnly && stale) {
    console.error("build-features: generated files are out of date — run `node scripts/build-features.mjs`");
    process.exit(1);
  }
  if (!stale) console.log("build-features: up to date");
}
