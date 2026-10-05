// System-overlay registrations — imported once from main.tsx for module-eval
// side effects. Each workstream appends EXACTLY ONE import line under its own
// marker and never touches the others (merge-safe single-line appends; the
// cards call registerOverlay(id, Component) at module eval, see
// components/OverlayOutlet.tsx).

// W6 (system surfaces): accounts/result/model/command-palette/mcp-palette cards
import "./system";
// W7 (projects/plugins): plugins & commands card
import "../components/PluginsCard";
// W8 (host tools): host tools card
import "../components/HostToolsCard";
// W19 (F17 artifacts): in-app artifact preview card
import "../components/ArtifactPreviewCard";
// W20 (F18 notifications): the notification-rules card
import "../components/NotifyRulesCard";
// HOOK-6 (PLAN-HOOKS.md §7): the lifecycle-hooks rules card
import "../components/HooksCard";
// W21 (F19 usage analytics): the usage & cost card
import "../components/UsageCard";
// W22 (F20 checkpoints): the checkpoints list card
import "../components/CheckpointsCard";
// FILE-PATH-LINKS: the transcript path-click file viewer
import "../components/PathViewerCard";
export {};

import "../components/ContextLinkShareOverlay";
import "../components/IssueCommentCard";

import "../components/ForkAgentOverlay";
