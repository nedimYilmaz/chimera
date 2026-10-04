import { describe, expect, it } from "vitest";
import { AGENT_DND_MIME, agentDragOverEffect } from "../src/state/commands.agents";

// UI-DRAGDROP-AFFORDANCE: the "+" (copy) cursor must be scoped to a genuine
// drag payload over the composer input, never left to the browser's implicit
// dropEffect resolution (which can leak "+" onto regions with no drop
// handling at all — see Composer.tsx's onDragOver comment). This is the
// input-target handler's own verdict fn; a dragover anywhere else in the app
// never runs this code path at all (onDragOver is bound only to the
// composer's textarea), so "non-target dragover" here means a payload this
// handler must still reject even while it IS the hover target.
describe("agentDragOverEffect — composer drag-drop cursor scoping", () => {
  it("is copy for an agent-row drag (AGENT_DND_MIME)", () => {
    expect(agentDragOverEffect([AGENT_DND_MIME])).toBe("copy");
  });

  it("is copy for an OS file drag (Files)", () => {
    expect(agentDragOverEffect(["Files"])).toBe("copy");
  });

  it("is none for an unrelated payload (e.g. plain text)", () => {
    expect(agentDragOverEffect(["text/plain"])).toBe("none");
  });

  it("is none for no payload at all", () => {
    expect(agentDragOverEffect([])).toBe("none");
    expect(agentDragOverEffect(undefined)).toBe("none");
  });
});
