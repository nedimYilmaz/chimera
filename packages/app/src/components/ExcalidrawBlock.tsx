import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ExcalidrawScene } from "@chimera/ui-state";
import styles from "./MessageBody.module.css";

// EXCALIDRAW-DIAGRAMS — renders an agent-emitted ```excalidraw scene as an
// interactive read-only canvas inside the transcript, with an expand-to-overlay
// affordance. The parser (ui-state markdown.ts) already validated the scene
// structurally and handed us {scene, elementCount}; a malformed scene never
// reaches here (it degrades to a code block upstream).
//
// NO-NETWORK GUARANTEE: Excalidraw fetches its fonts from EXCALIDRAW_ASSET_PATH
// at render time — unset, it defaults to a remote CDN. We pin it to the app's
// OWN origin ("/") so nothing is ever fetched remotely; the fonts are served
// locally by the excalidraw-assets Vite plugin (see vite.config.ts). Even if a
// font file is missing locally, Excalidraw simply falls back to a system font —
// it never reaches out to the network once this path is set.
if (typeof window !== "undefined" && (window as unknown as { EXCALIDRAW_ASSET_PATH?: unknown }).EXCALIDRAW_ASSET_PATH === undefined) {
  (window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "/";
}

// @excalidraw/excalidraw is heavy (a few hundred KB gzip + a WASM/canvas stack),
// so it is code-split behind React.lazy: the chunk (and its stylesheet) load
// ONLY when a transcript actually contains a diagram, never on app start. The
// import lives here so the whole dependency stays out of the base bundle.
const LazyExcalidraw = lazy(async () => {
  const mod = await import("@excalidraw/excalidraw");
  await import("@excalidraw/excalidraw/index.css");
  return { default: mod.Excalidraw };
});

// A scene with more elements than this does NOT auto-render — it collapses
// behind a "render diagram (N elements)" button so a huge pasted scene can't
// jank the transcript on first paint (the feature's oversized guardrail). The
// user opts in per-diagram.
const AUTO_RENDER_MAX_ELEMENTS = 100;

// Excalidraw's `initialData.elements` is typed as its own ExcalidrawElement[];
// our scene carries opaque `unknown[]` (external, parser-validated only for the
// {type, elements[]} envelope). Excalidraw re-validates/normalizes every element
// internally, so we hand the array across the boundary as-is.
type ExcalidrawProps = {
  initialData: { elements: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> };
  viewModeEnabled?: boolean;
  theme?: "dark" | "light";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
};
const Excalidraw = LazyExcalidraw as unknown as (props: ExcalidrawProps) => ReactNode;

function Canvas({ scene, large }: { scene: ExcalidrawScene; large: boolean }) {
  return (
    <Suspense fallback={<div className={styles.streamingPlaceholder}>rendering diagram…</div>}>
      <div className={large ? styles.excalidrawCanvasLarge : styles.excalidrawCanvas}>
        <Excalidraw
          // read-only in v1 (viewMode still permits pan/zoom, which is all the
          // inline + expanded previews need); editing in the overlay is an
          // explicit non-goal for v1.
          viewModeEnabled
          theme="dark"
          // hide the CDN font-loading dot / library / help chrome — this is a
          // preview surface, not the full editor.
          UIOptions={{ canvasActions: { export: false, loadScene: false, saveToActiveFile: false, toggleTheme: false } }}
          initialData={{
            elements: scene.elements,
            appState: { ...(scene.appState ?? {}), viewModeEnabled: true, theme: "dark" },
            ...(scene.files ? { files: scene.files } : {}),
          }}
        />
      </div>
    </Suspense>
  );
}

// The expand overlay. Rendered via a PORTAL to document.body: position:fixed is
// positioned relative to the nearest ancestor with a transform/filter/perspective/
// will-change/contain — and the transcript's virtualized message blocks
// (TranscriptPanel.module.css `.bodyInner > [data-block]`) use
// `content-visibility: auto`, which implies `contain: layout style paint`. Left
// inline, the overlay would be trapped inside that block instead of covering the
// window. The portal escapes the whole transcript DOM so position:fixed;inset:0
// (and the fullscreen/maximized states) always cover the real viewport.
// "full screen" (whole DISPLAY, no window chrome) is a further step only the
// browser/webview can grant via the Fullscreen API. This child owns the
// fullscreen lifecycle so that closing the overlay (unmounting this component)
// always releases fullscreen; it is mounted only while `expanded`.
function ExcalidrawOverlay({
  scene,
  elementCount,
  onClose,
}: {
  scene: ExcalidrawScene;
  elementCount: number;
  onClose: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Fallback for a webview without the Fullscreen API: a maximized CSS state
  // (position:fixed; inset:0; 100vw/100vh) covering the whole window. The overlay
  // is already fixed/inset:0, so this flag mainly drives the :fullscreen-parity
  // sizing + the active affordance state.
  const [fallbackMax, setFallbackMax] = useState(false);

  // Keep the toggle in sync with the browser. Esc exits native fullscreen
  // directly (never through our button) and the desktop window can drop
  // fullscreen on its own — `fullscreenchange` is the single source of truth.
  useEffect(() => {
    if (typeof document === "undefined") return; // node/SSR render (tests) — no DOM
    const sync = () => setIsFullscreen(document.fullscreenElement === overlayRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      // Never strand the webview in OS fullscreen after the overlay is dismissed.
      if (document.fullscreenElement) void document.exitFullscreen?.();
    };
  }, []);

  const active = isFullscreen || fallbackMax;
  const toggleFullscreen = () => {
    const el = overlayRef.current;
    if (active) {
      if (typeof document !== "undefined" && document.fullscreenElement) void document.exitFullscreen?.();
      setFallbackMax(false);
      return;
    }
    if (el && typeof el.requestFullscreen === "function") {
      // requestFullscreen can reject (gesture/permission) — degrade to the
      // maximized CSS fallback instead of leaving the user a dead button.
      Promise.resolve(el.requestFullscreen()).catch(() => setFallbackMax(true));
    } else {
      setFallbackMax(true);
    }
  };

  const overlay = (
    <div
      ref={overlayRef}
      className={fallbackMax ? `${styles.excalidrawOverlay} ${styles.excalidrawOverlayMaximized}` : styles.excalidrawOverlay}
      role="dialog"
      aria-label="excalidraw diagram"
    >
      <div className={styles.excalidrawOverlayBar}>
        <span className={styles.excalidrawLabel}>excalidraw diagram · {elementCount} elements</span>
        <button type="button" className={styles.excalidrawButton} aria-pressed={active} onClick={toggleFullscreen}>
          {active ? "⛶ exit full screen" : "⛶ full screen"}
        </button>
        <button type="button" className={styles.excalidrawButton} onClick={onClose}>
          close
        </button>
      </div>
      <Canvas scene={scene} large />
    </div>
  );

  // node/SSR render (tests without jsdom's document.body) — render inline as a
  // fallback rather than crash; every real (and jsdom) target has a body.
  if (typeof document === "undefined" || !document.body) return overlay;
  return createPortal(overlay, document.body);
}

export function ExcalidrawBlock({ scene, elementCount }: { scene: ExcalidrawScene; elementCount: number }) {
  const oversized = elementCount > AUTO_RENDER_MAX_ELEMENTS;
  // `shown` gates the inline canvas: auto-true for normal scenes, opt-in for
  // oversized ones. `expanded` toggles the full-screen overlay.
  const [shown, setShown] = useState(!oversized);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={styles.excalidrawWrap}>
      <div className={styles.excalidrawBar}>
        <span className={styles.excalidrawGlyph}>◇</span>
        <span className={styles.excalidrawLabel}>
          excalidraw diagram · {elementCount} element{elementCount === 1 ? "" : "s"}
        </span>
        {shown ? (
          <button type="button" className={styles.excalidrawButton} onClick={() => setExpanded(true)}>
            expand
          </button>
        ) : null}
      </div>

      {shown ? (
        // While the overlay is open, don't also keep the (hidden) inline canvas
        // mounted — one heavy @excalidraw instance at a time. The bar/expand
        // chrome above stays put, so `shown` still drives the affordances.
        expanded ? null : <Canvas scene={scene} large={false} />
      ) : (
        // Oversized-scene collapse: nothing heavy mounts until the user asks.
        <button type="button" className={styles.excalidrawRenderButton} onClick={() => setShown(true)}>
          render diagram ({elementCount} elements)
        </button>
      )}

      {expanded ? (
        <ExcalidrawOverlay scene={scene} elementCount={elementCount} onClose={() => setExpanded(false)} />
      ) : null}
    </div>
  );
}
