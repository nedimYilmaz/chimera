// BUNDLE-STARTUP-COST: this constant lives apart from fileHighlight.ts so FileViewer can read it
// SYNCHRONOUSLY without statically importing that module — which would pull shiki's core, its
// textmate grammar engine and oniguruma-to-es (~200 kB) into the entry chunk for a viewer most
// sessions never open. FileViewer loads the highlighter itself on demand.
//
// It has to be sync: the pre-highlight plain-text render stamps this class so a `path:line` jump
// can scroll to its target during the load gap, before any highlighted HTML exists.
export const HIGHLIGHT_LINE_CLASS = "path-target-line";
