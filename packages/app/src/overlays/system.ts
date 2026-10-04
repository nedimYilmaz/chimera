// W6 aggregator — the ONE line overlays/index.ts imports for this workstream.
// Each card module self-registers via registerOverlay(id, Component) at module
// eval (see components/OverlayOutlet.tsx); importing them here is the whole
// side effect. SystemStrips hosts the right-column banner strips (budget
// pause + replay bar) through the same outlet.
import "../components/SystemStrips";
import "../components/AccountsCard";
import "../components/ResultCard";
import "../components/ModelCard";
import "../components/EffortCard";
import "../components/AccountCard";
import "../components/RemoteControlCard";
import "../components/CommandPalette";
import "../components/McpToolPalette";
export {};
