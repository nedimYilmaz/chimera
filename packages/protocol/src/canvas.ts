import { z } from "zod";

const id = z.string().min(1).max(200);
const ref = z.string().min(1).max(240);
const coordinate = z.number().finite().min(-100000).max(100000);
export const CANVAS_EDGE_KINDS = ["fork", "context", "dependsOn", "issue", "ownership"] as const;
export const CanvasViewportSchema = z.object({ x: coordinate, y: coordinate, zoom: z.number().finite().min(0.2).max(3) }).strict();
export const CanvasLayoutSchema = z.object({
  positions: z.record(ref, z.object({ x: coordinate, y: coordinate, collapsed: z.boolean().optional(), group: id.optional() }).strict()).refine(p => Object.keys(p).length <= 1000, "At most 1000 positions"),
  viewport: CanvasViewportSchema,
  groups: z.array(z.object({ id, title: z.string().max(120) }).strict()).max(50),
  stickies: z.array(z.object({ id, text: z.string().max(500), x: coordinate, y: coordinate }).strict()).max(50),
}).strict();
export const CanvasNodeSchema = z.object({
  ref, kind: z.enum(["agent", "task", "artifact", "worktree", "context-link", "issue", "cluster"]),
  entityId: id, label: z.string().max(200), status: z.string().max(80),
  agentId: id.optional(), queue: id.optional(), count: z.number().int().positive().optional(),
}).strict();
export const CanvasEdgeSchema = z.object({ from: ref, to: ref, kind: z.enum(CANVAS_EDGE_KINDS), label: z.string().max(120).optional() }).strict();
export const CanvasGetSchema = z.object({ projectId: id, callerAgentId: id.optional() }).strict();
export const CanvasGetResponseSchema = z.object({ revision: z.number().int().nonnegative(), layout: CanvasLayoutSchema, nodes: z.array(CanvasNodeSchema).max(300), edges: z.array(CanvasEdgeSchema).max(1000), truncated: z.boolean(), readOnly: z.boolean() }).strict();
export const CanvasSaveLayoutSchema = z.object({ projectId: id, baseRevision: z.number().int().nonnegative(), layout: CanvasLayoutSchema }).strict();
export const CanvasSaveResponseSchema = z.object({ revision: z.number().int().nonnegative() }).strict();
export type CanvasLayout = z.infer<typeof CanvasLayoutSchema>;
export type CanvasNode = z.infer<typeof CanvasNodeSchema>;
export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>;
export type CanvasGraph = z.infer<typeof CanvasGetResponseSchema>;
export const emptyCanvasLayout = (): CanvasLayout => ({ positions: {}, viewport: { x: 0, y: 0, zoom: 1 }, groups: [], stickies: [] });
