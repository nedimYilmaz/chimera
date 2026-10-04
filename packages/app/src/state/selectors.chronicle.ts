import type { ChronicleSearchHit } from "@chimera/protocol";

export type ChronicleLane = "workflow" | "agent" | "task" | "tool/gate" | "artifact" | "engine/trace";

/** A hit may appear in multiple lanes; only explicit persisted correlation is
 * used, so the UI never invents causal links. */
export function chronicleLanes(hit: ChronicleSearchHit): ChronicleLane[] {
  const lanes = new Set<ChronicleLane>();
  if (hit.correlation.workflow || hit.fields.includes("workflow")) lanes.add("workflow");
  lanes.add("agent");
  if (hit.correlation.taskId || hit.fields.includes("task")) lanes.add("task");
  if (hit.correlation.toolId || hit.fields.some((field) => field.startsWith("tool_")) || hit.fields.includes("gate")) lanes.add("tool/gate");
  if (hit.correlation.artifactId || hit.fields.includes("artifact")) lanes.add("artifact");
  if (hit.engineId !== "local" || hit.correlation.traceId || hit.correlation.spanId) lanes.add("engine/trace");
  return [...lanes];
}

export function chronicleCausalKey(hit: ChronicleSearchHit): string[] {
  const c = hit.correlation;
  return [c.taskId, c.workflow, c.stepId, c.toolId, c.artifactId, c.traceId, c.spanId, c.parentAgentId].filter((value): value is string => !!value);
}
