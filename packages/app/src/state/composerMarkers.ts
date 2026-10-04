// COMPOSER-MARKDOWN-PREVIEW — which runs of the text you are typing are code.
//
// Feeds a mirror layer painted BEHIND the textarea, so a `backtick` span you type is visibly a
// code span before you send it, not only after.
//
// BACKGROUNDS ONLY, and that is a constraint rather than a shortcut. The mirror has to wrap
// identically to the textarea, character for character, or the highlight drifts off the text it is
// marking. It does that by construction — same font, size, line-height, width and wrapping — which
// holds only as long as nothing here changes glyph METRICS. So no bold, no italic, no size change:
// those would desync the two layers, and a highlight that sits half a character off reads as a
// rendering bug in the one control that must feel solid.

export type MarkerRun = { text: string; code: boolean };

/** Split `text` into alternating plain/code runs.
 *
 *  Handles both fenced blocks (```…```) and inline spans (`…`), with fences taking precedence: a
 *  lone backtick INSIDE a fence is content, not the start of an inline span.
 *
 *  An UNTERMINATED marker is left plain. You are mid-typing almost every time one appears, and
 *  lighting up the rest of the buffer on every opening backtick is a flash of the whole message
 *  changing colour between two keystrokes. */
export function markerRuns(text: string): MarkerRun[] {
  if (!text) return [{ text: "", code: false }];
  const out: MarkerRun[] = [];
  let plain = "";
  const flush = (): void => { if (plain) { out.push({ text: plain, code: false }); plain = ""; } };

  let i = 0;
  while (i < text.length) {
    if (text.startsWith("```", i)) {
      const close = text.indexOf("```", i + 3);
      if (close !== -1) {
        flush();
        out.push({ text: text.slice(i, close + 3), code: true });
        i = close + 3;
        continue;
      }
      // No closing fence — the rest is still being typed.
      plain += text.slice(i);
      break;
    }
    if (text[i] === "`") {
      // An inline span does not span lines: a newline before the closing backtick means the opener
      // was never closed, not that the span swallowed the next paragraph.
      const nl = text.indexOf("\n", i + 1);
      let close = text.indexOf("`", i + 1);
      if (close !== -1 && nl !== -1 && nl < close) close = -1;
      if (close !== -1) {
        flush();
        out.push({ text: text.slice(i, close + 1), code: true });
        i = close + 1;
        continue;
      }
      plain += "`";
      i++;
      continue;
    }
    plain += text[i];
    i++;
  }
  flush();
  return out.length ? out : [{ text: "", code: false }];
}
