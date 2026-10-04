// FILEBROWSER-T7 — VSCode-grade highlighting for FileViewer, via shiki's
// FINE-GRAINED bundle (shiki/core + shiki/engine/javascript), not the default
// `shiki` entrypoint: the default bundle eagerly ships every theme+language;
// this one loads only the one theme up front and each language lazily, on
// first open, as its own chunk.
//
// CSP (tauri.conf.json: default-src 'self') — two choices matter here:
//  - engine/javascript (a pure regex engine) instead of engine/oniguruma
//    (wasm): no wasm-unsafe-eval/worker-src relaxation needed.
//  - `bundledLanguages`/`bundledThemes` (literal `import()` calls inside
//    shiki's own source) instead of a templated `import(`shiki/langs/${lang}`)`:
//    Rollup can only code-split import() calls it can statically see, so a
//    templated path would fail to resolve at runtime in the built app. The
//    bundled maps give it a literal call per language, bundled as a local
//    chunk shipped with the app — no external fetch either way.
import { HIGHLIGHT_LINE_CLASS } from "./fileHighlightClass";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages, type BundledLanguage } from "shiki/langs";
import { bundledThemes } from "shiki/themes";

export const FILE_VIEWER_THEME = "vitesse-dark";

let highlighterPromise: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [bundledThemes[FILE_VIEWER_THEME]],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

const loadedLangs = new Set<string>();

// FILE-PATH-LINKS — the class a decorated `path:line` target line gets
// (FileViewer.module.css draws the highlight); exported so the caller can
// find the decorated element to scroll it into view without re-deriving the
// string shiki was told to use.
export { HIGHLIGHT_LINE_CLASS } from "./fileHighlightClass";

/** null ⇒ caller falls back to a plain <pre> (no lang, or an id shiki's
 * bundle doesn't carry). `highlightLine` (1-based) wraps that line in a
 * `HIGHLIGHT_LINE_CLASS` span via shiki's own decorations API — no manual
 * HTML surgery on shiki's output, which would risk breaking its per-token
 * markup. */
export async function highlightFile(code: string, lang: string | null, highlightLine?: number | null): Promise<string | null> {
  if (!lang || !(lang in bundledLanguages)) return null;
  const highlighter = await getHighlighter();
  if (!loadedLangs.has(lang)) {
    await highlighter.loadLanguage(bundledLanguages[lang as BundledLanguage]);
    loadedLangs.add(lang);
  }
  // start/end kept on the SAME line (0 → that line's own length), not
  // "through the start of the next line" — the latter is out of range for the
  // file's LAST line when it has no trailing newline.
  const lines = code.length === 0 ? [] : code.split("\n");
  const decorations =
    highlightLine && highlightLine >= 1 && highlightLine <= lines.length
      ? [{
          start: { line: highlightLine - 1, character: 0 },
          end: { line: highlightLine - 1, character: lines[highlightLine - 1]!.length },
          properties: { class: HIGHLIGHT_LINE_CLASS },
        }]
      : undefined;
  return highlighter.codeToHtml(code, { lang, theme: FILE_VIEWER_THEME, decorations });
}
