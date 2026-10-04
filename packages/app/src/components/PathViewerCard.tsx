import { registerOverlay } from "./OverlayOutlet";
import { FileViewer } from "../screens/FileViewer";
import { closePathViewer, usePathViewerLocal } from "../state/pathRefs";

// FILE-PATH-LINKS — hosts the SAME FileViewer the project file-browser panel
// uses (FILEBROWSER-T7), opened instead from a PathLink click in a transcript.
// Registered once (like ArtifactPreviewCard) so it renders regardless of
// which screen/agent the clicked path came from; FileViewer itself already
// portals to document.body and owns its own esc/scrim-close, so this wrapper
// is just the local-store ↔ component wiring.
function PathViewerCard() {
  const selected = usePathViewerLocal((s) => s.selected);
  const line = usePathViewerLocal((s) => s.line);
  if (!selected) return null;
  return <FileViewer selected={selected} onClose={closePathViewer} highlightLine={line ?? undefined} />;
}

registerOverlay("path-viewer", PathViewerCard, closePathViewer);
