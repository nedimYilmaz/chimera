// FILEBROWSER-T7 — PURE routing/formatting for the FileViewer overlay: which
// of the four panes (error/image/binary/text) an fs.read reply renders as,
// what shiki language its extension maps to, and the truncation-banner text.
// Same discipline as selectors.artifacts.ts: no React, no store import, read
// the wire result defensively.
import type { Image } from "@chimera/ui-state";
import type { FsSelectedFile } from "./commands.projects";
import { formatArtifactSize } from "./selectors.artifacts";

// Extension → shiki bundled-language id (shiki/langs' own id set). An
// unmapped extension (or a dotfile/extension-less name) resolves to `null` —
// FileViewer's HighlightedCode then falls back to a plain <pre> rather than
// guessing at a grammar from content.
const EXT_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc",
  py: "python", rs: "rust", go: "go",
  java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp",
  cs: "csharp", php: "php", rb: "ruby", swift: "swift",
  sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "toml",
  md: "markdown", markdown: "markdown",
  html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "proto",
  xml: "xml", vue: "vue", svelte: "svelte",
  lua: "lua", pl: "perl", r: "r", dart: "dart", scala: "scala",
  clj: "clojure", ex: "elixir", exs: "elixir", elm: "elm", hs: "haskell",
  nim: "nim", zig: "zig", vim: "vim", diff: "diff", patch: "diff", ini: "ini",
};

export function languageForPath(path: string): string | null {
  const base = (path.split("/").pop() ?? path).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile like ".gitignore"
  return EXT_LANG[base.slice(dot + 1)] ?? null;
}

// Mirrors fsbrowse.ts's IMAGE_SIGNATURES (png/jpeg/gif/webp) — the only
// mediaTypes core's fs.read ever attaches to a binary reply.
const IMAGE_MEDIA_TYPES: readonly Image["mediaType"][] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function isImageMediaType(v: string): v is Image["mediaType"] {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(v);
}

export type FileView =
  | { kind: "error"; message: string }
  | { kind: "image"; mediaType: Image["mediaType"]; data: string }
  | { kind: "media"; media: "video" | "audio"; path: string }
  | { kind: "binary"; sizeBytes: number }
  | { kind: "text"; content: string; lang: string | null; truncated: boolean; sizeBytes: number; shownBytes: number };

/** Routes one FsSelectedFile (T5's tagged-union viewer state) to the pane
 * FileViewer renders — the four T7 acceptance branches (error/image/binary/text). */
export function classifyFileView(selected: FsSelectedFile): FileView {
  if (selected.status === "error") return { kind: "error", message: selected.message };
  const r = selected.result;
  if (r.binary && r.absolutePath && (r.mediaType?.startsWith("video/") || r.mediaType?.startsWith("audio/"))) {
    return { kind: "media", media: r.mediaType.startsWith("video/") ? "video" : "audio", path: r.absolutePath };
  }
  if (r.binary && r.mediaType && isImageMediaType(r.mediaType)) {
    return { kind: "image", mediaType: r.mediaType, data: r.content };
  }
  if (r.binary) return { kind: "binary", sizeBytes: r.sizeBytes };
  return {
    kind: "text",
    content: r.content,
    lang: languageForPath(selected.path),
    truncated: r.truncated,
    sizeBytes: r.sizeBytes,
    shownBytes: new TextEncoder().encode(r.content).length,
  };
}

/** "truncated — first N of M bytes", or null when the read wasn't truncated
 * (FS_READ_MAX_BYTES cap, fsbrowse.ts). */
export function truncationBannerText(view: Extract<FileView, { kind: "text" }>): string | null {
  if (!view.truncated) return null;
  return `truncated — first ${formatArtifactSize(view.shownBytes)} of ${formatArtifactSize(view.sizeBytes)}`;
}
