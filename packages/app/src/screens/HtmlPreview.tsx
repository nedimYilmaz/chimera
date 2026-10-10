import { useEffect, useState } from "react";
import type { FsReadResult } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { localHtmlDocument } from "./localHtml";
import styles from "./FileViewer.module.css";

export function HtmlPreview({ source, path }: { source: string; path?: string }) {
  const [result, setResult] = useState<{ html: string; omitted: number } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setResult(null); setError(false);
    void localHtmlDocument(source, path, asset => rpcCall<FsReadResult>("fs.read", { path: asset }), () => cancelled)
      .then(value => { if (!cancelled) setResult(value); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [source, path]);
  return <div className={styles.htmlWrap} data-html-preview>
    <div className={styles.htmlNote}>Local HTML preview · scripts and remote resources are disabled.
      {result?.omitted ? ` ${result.omitted} resource(s) unavailable.` : ""}
    </div>
    {error ? <div role="status">Preview unavailable. Switch to Source to read this file.</div>
      : result ? <iframe title="Local HTML preview" sandbox="" referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
          srcDoc={result.html} className={styles.htmlFrame} />
      : <div role="status">Loading HTML preview…</div>}
  </div>;
}
