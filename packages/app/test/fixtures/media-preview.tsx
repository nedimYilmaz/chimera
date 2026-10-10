import React, { useState } from "react";
import { FileViewer } from "../../src/screens/FileViewer";

export function MediaPreviewProbe() {
  const [kind, setKind] = useState("video");
  const [visible, setVisible] = useState(true);
  return <>
    <button data-media-reopen onClick={() => { setKind("video"); setVisible(true); }}>Open video</button>
    {visible ? <>
      <div style={{ position: "fixed", bottom: 0, zIndex: 210 }}>
        <button data-media-audio onClick={() => setKind("audio")}>Audio</button>
        <button data-media-pdf onClick={() => setKind("pdf")}>PDF</button>
        <button data-media-broken onClick={() => setKind("broken")}>Unavailable video</button>
      </div>
      <FileViewer selected={{ status: "ok", path: kind === "audio" ? "voice.wav" : kind === "pdf" ? "report.pdf" : `${kind}.webm`, result: {
        path: kind, absolutePath: `/fixture/${kind}`, encoding: "utf8", content: "", binary: true,
        mediaType: kind === "audio" ? "audio/wav" : kind === "pdf" ? "application/pdf" : "video/webm", sizeBytes: 3000000, truncated: false,
      } }} onClose={() => setVisible(false)} />
    </> : null}
  </>;
}
