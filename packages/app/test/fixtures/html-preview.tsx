import React, { useState } from "react";
import type { FsReadResult } from "@chimera/protocol";
import { FileViewer } from "../../src/screens/FileViewer";
import { localHtmlDocument } from "../../src/screens/localHtml";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaPgPAAIDAYAkYfWXAAAAAElFTkSuQmCC";
const source = `<!doctype html><html><head><link rel="stylesheet" href="../styles/main.css"></head><body>
<h1 id="local-title">Local page</h1><img alt="local picture" src="../images/a.png"><div class="swatch">Background</div>
<script>parent.__HTML_ESCAPED__=true;fetch('https://example.invalid/leak')</script>
<img src="https://example.invalid/tracker"><iframe src="https://example.invalid/embed"></iframe>
<a href="https://example.invalid">Remote link</a><form action="https://example.invalid"><button>Submit</button></form>
</body></html>`;
export const htmlFixture = {
  calls: [] as string[],
  read(path: string): FsReadResult {
    this.calls.push(path);
    if (path === "/html-fixture/styles/main.css") return { path, absolutePath: path, content: 'h1 { color: rgb(17, 34, 51); } .swatch { background-image: url("../images/bg.png"); width: 120px; height: 80px; }', binary: false, encoding: "utf8", mediaType: null, sizeBytes: 180, truncated: false };
    if (["/html-fixture/images/a.png", "/html-fixture/images/bg.png"].includes(path)) return { path, absolutePath: path, content: png, binary: true, encoding: "base64", mediaType: "image/png", sizeBytes: 80, truncated: false };
    throw new Error("outside fixture root");
  },
  async limits() {
    let calls = 0;
    const read = async (path: string) => { calls++; return { ...this.read("/html-fixture/images/a.png"), path }; };
    const bounded = await localHtmlDocument(Array.from({ length: 80 }, (_, i) => `<img src="${i}.png">`).join(""), "/html-fixture/index.html", read);
    const count = calls;
    calls = 0;
    try { await localHtmlDocument('<img src="a.png">', "/html-fixture/index.html", read, () => true); } catch { /* cancelled */ }
    return { count, omitted: bounded.omitted, cancelledReads: calls };
  },
};

export function HtmlPreviewProbe() {
  const [open, setOpen] = useState(true);
  const [line, setLine] = useState<number | undefined>();
  return <>
    <button data-html-line onClick={() => { setLine(2); setOpen(true); }}>Open at line</button>
    {open ? <FileViewer selected={{ path: "demo.html", status: "ok", result: { path: "demo.html", absolutePath: "/html-fixture/pages/demo.html", content: source, binary: false, encoding: "utf8", mediaType: null, sizeBytes: source.length, truncated: false } }} highlightLine={line} onClose={() => setOpen(false)} /> : null}
  </>;
}
