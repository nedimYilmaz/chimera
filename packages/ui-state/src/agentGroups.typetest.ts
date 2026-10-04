// AGENT-GROUPS Phase 1: compile-time-only regression net (mirrors protocol's
// contract.typetest.ts convention — lives under src/, so it's covered by `tsc -b`, never
// imported/run by anything else) asserting protocol's AgentGroupColor stays IDENTICAL to
// teamIcon.ts's TeamColorId. protocol can't import ui-state (see index.ts's header comment: no
// UI package may be a dependency of protocol), so AGENT_GROUP_COLORS is a literal tuple
// mirrored by hand there — this is the tripwire that fails `tsc -b packages/ui-state` the
// moment the two lists drift apart, since AgentGroupSchema.color is meant to be renderable
// through the SAME palette a team badge already uses.
import type { AgentGroupColor } from "@chimera/protocol";
import type { TeamColorId } from "./teamIcon.js";

declare function acceptsTeamColor(c: TeamColorId): void;
declare function acceptsGroupColor(c: AgentGroupColor): void;
declare const groupColor: AgentGroupColor;
declare const teamColor: TeamColorId;

acceptsTeamColor(groupColor); // valid only if every AgentGroupColor is a TeamColorId
acceptsGroupColor(teamColor); // valid only if every TeamColorId is an AgentGroupColor
