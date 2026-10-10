import type { ArtifactRow } from "../state/selectors.artifacts";

export const DESIGN_MAX_BYTES = 1024 * 1024;
export type DesignDocument = { key: string; label: string; revisions: ArtifactRow[] };

export function isDesignArtifact(row: ArtifactRow): boolean {
  return row.kind === "file" && /\.html?$/i.test(row.path ?? row.label);
}

/** The source path identifies a design; snapshot IDs identify immutable revisions.
 * Never group unrelated files by their human labels, which need not be unique. */
export function designDocuments(rows: readonly ArtifactRow[]): DesignDocument[] {
  const groups = new Map<string, DesignDocument>();
  for (const row of rows) {
    if (!isDesignArtifact(row)) continue;
    const key = row.path ?? row.id;
    const group = groups.get(key) ?? { key, label: row.label, revisions: [] };
    if (!group.revisions.some((revision) => revision.id === row.id)) group.revisions.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.revisions.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    group.label = group.revisions[0]!.label;
  }
  return [...groups.values()].sort((a, b) => b.revisions[0]!.createdAt - a.revisions[0]!.createdAt || a.key.localeCompare(b.key));
}

// This is a static renderer, NOT a JavaScript sandbox. No allow-scripts, native
// bridge, resource resolver or message listener is exposed to generated content.
export const DESIGN_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'";
const tags = new Set("a abbr address article aside b bdi bdo blockquote br button caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr i img input ins kbd label legend li main mark menu meter nav ol optgroup option output p picture pre progress q rp rt ruby s samp section select small source span strong style sub summary sup table tbody td textarea tfoot th thead time tr u ul var wbr".split(" "));
const attrs = new Set("id class style title lang dir role alt width height type value placeholder disabled checked selected multiple readonly required min max step rows cols colspan rowspan scope open for name datetime start reversed span size wrap loading decoding".split(" "));

export function staticDesignDocument(source: string, maxBytes = DESIGN_MAX_BYTES): { html: string; removed: number } {
  if (new TextEncoder().encode(source).byteLength > maxBytes) throw new Error(`HTML preview is limited to ${maxBytes / (1024 * 1024)} MiB. Use a smaller document or view its source.`);
  // Template contents are inert: unlike a detached DOMParser document, images
  // must not start requests during parsing, before the preview CSP takes effect.
  const template = document.createElement("template");
  template.innerHTML = source;
  let removed = 0;
  for (const el of [...template.content.querySelectorAll("*")]) {
    if (el.namespaceURI !== "http://www.w3.org/1999/xhtml" || !tags.has(el.localName)) {
      el.remove(); removed++; continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const raster = el.localName === "img" && name === "src" && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i.test(attr.value);
      if (!raster && !attrs.has(name) && !/^aria-[a-z-]+$/.test(name)) { el.removeAttribute(attr.name); removed++; }
    }
    // Forms are presentation only. Prevent keyboard focus from moving into a
    // generated control that could look like a Chimera permission/action UI.
    if (["button", "input", "select", "textarea"].includes(el.localName)) el.setAttribute("disabled", "");
  }
  return {
    html: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${DESIGN_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${template.innerHTML}</body></html>`,
    removed,
  };
}
