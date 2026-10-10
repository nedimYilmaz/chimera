import type { FsReadResult } from "@chimera/protocol";
import { staticDesignDocument, DESIGN_MAX_BYTES } from "../design/documents";

const MAX_ASSETS = 32;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const raster = /^image\/(png|jpeg|gif|webp)$/;
const inlineRaster = /^data:image\/(png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i;

/** Resolve relative assets against the file, never the app's own origin. The
 * daemon's fs.read performs the final project-root and symlink authorization. */
export function localResourcePath(base: string | undefined, reference: string): string | null {
  const ref = reference.trim();
  if (!base || !ref || ref.startsWith("#") || /^(?:[a-z][\w+.-]*:|[\\/]{2})/i.test(ref)) return null;
  try {
    const normalized = base.replace(/\\/g, "/");
    if (!normalized.startsWith("/") && !/^[a-z]:\//i.test(normalized)) return null;
    const root = new URL(`file://${normalized.startsWith("/") ? "" : "/"}${normalized.split("/").map(encodeURIComponent).join("/")}`);
    const url = new URL(ref.replace(/\\/g, "/"), root);
    if (url.protocol !== "file:" || url.hostname) return null;
    const path = decodeURIComponent(url.pathname);
    return /^[a-z]:\//i.test(normalized) && /^\/[a-z]:/i.test(path) ? path.slice(1) : path;
  } catch { return null; }
}

export async function localHtmlDocument(source: string, path: string | undefined, read: (path: string) => Promise<FsReadResult>, cancelled = () => false): Promise<{ html: string; omitted: number }> {
  if (new TextEncoder().encode(source).byteLength > DESIGN_MAX_BYTES) throw new Error("HTML preview is limited to 1 MiB. Use Source to read this file.");
  const template = document.createElement("template");
  template.innerHTML = source;
  const cache = new Map<string, FsReadResult | null>();
  let bytes = 0, embedded = 0, stylesBytes = 0, references = 0, omitted = 0;
  const asset = async (base: string | undefined, ref: string): Promise<FsReadResult | null> => {
    const resolved = localResourcePath(base, ref);
    if (!resolved || cancelled()) return null;
    if (cache.has(resolved)) return cache.get(resolved)!;
    if (cache.size >= MAX_ASSETS || bytes >= MAX_ASSET_BYTES) return null;
    cache.set(resolved, null);
    try {
      const result = await read(resolved);
      bytes += result.sizeBytes;
      if (cancelled() || result.truncated || bytes > MAX_ASSET_BYTES) return null;
      cache.set(resolved, result);
      return result;
    } catch { return null; }
  };
  const image = async (base: string | undefined, ref: string): Promise<string> => {
    if (++references > MAX_ASSETS) { omitted++; return "data:,"; }
    if (inlineRaster.test(ref)) {
      embedded += ref.length;
      if (embedded <= 6 * 1024 * 1024) return ref;
      omitted++; return "data:,";
    }
    const result = await asset(base, ref);
    if (result?.encoding === "base64" && raster.test(result.mediaType ?? "") && /^[a-z\d+/=\s]+$/i.test(result.content)) {
      embedded += result.content.length;
      if (embedded <= 6 * 1024 * 1024) return `data:${result.mediaType};base64,${result.content}`;
    }
    omitted++;
    return "data:,";
  };
  const css = async (text: string, base: string | undefined): Promise<string> => {
    // Imports are not recursively fetched. This keeps asset work bounded even
    // for cyclic stylesheets; remote CSS/fonts remain blocked by the frame CSP.
    text = text.replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;/gi, () => { omitted++; return ""; });
    const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
    let output = "", end = 0;
    for (const match of text.matchAll(pattern)) {
      output += text.slice(end, match.index) + `url("${await image(base, (match[1] ?? match[2] ?? match[3] ?? "").trim())}")`;
      end = match.index! + match[0].length;
    }
    return output + text.slice(end);
  };
  for (const style of template.content.querySelectorAll("style")) style.textContent = await css(style.textContent ?? "", path);
  for (const el of template.content.querySelectorAll("[style]")) el.setAttribute("style", await css(el.getAttribute("style")!, path));
  for (const link of template.content.querySelectorAll('link[rel~="stylesheet"]')) {
    if (++references > MAX_ASSETS) { link.remove(); omitted++; continue; }
    const result = await asset(path, link.getAttribute("href") ?? "");
    if (result && !result.binary) {
      stylesBytes += new TextEncoder().encode(result.content).byteLength;
      if (stylesBytes > 2 * 1024 * 1024) { link.remove(); omitted++; continue; }
      const style = document.createElement("style");
      style.textContent = await css(result.content, result.absolutePath ?? localResourcePath(path, link.getAttribute("href") ?? "") ?? undefined);
      link.replaceWith(style);
    } else { link.remove(); omitted++; }
  }
  for (const img of template.content.querySelectorAll("img[src]")) img.setAttribute("src", await image(path, img.getAttribute("src")!));
  if (cancelled()) throw new Error("Preview closed");
  // Reuse the existing static-document boundary: opaque sandbox, no scripts,
  // forms, navigation, native bridge or network. Assets become vetted data URLs.
  const result = staticDesignDocument(template.innerHTML, 8 * 1024 * 1024);
  return { html: result.html, omitted };
}
