import { CanvasGetResponseSchema, CanvasSaveResponseSchema, emptyCanvasLayout, type CanvasGraph, type CanvasLayout } from "@chimera/protocol";
import { createLoadStatus, runLoad } from "./loadStatus";
import { canvasPositions } from "./canvas-layout";
import { errorText } from "./errorText";
export type CanvasRequest = <T>(method: string, params: unknown) => Promise<T>;
type State = { graph: CanvasGraph | null; layout: CanvasLayout; selected: string | null; dirty: boolean; saving: boolean; saveError: string | null };
export class CanvasController {
  readonly status = createLoadStatus();
  private state: State = { graph: null, layout: emptyCanvasLayout(), selected: null, dirty: false, saving: false, saveError: null };
  private listeners = new Set<() => void>();
  private dirtyPositions = new Set<string>(); private viewportDirty = false; private cosmeticDirty = false;
  private serial = 0; private generation = 0; private alive = true;
  constructor(readonly projectId: string, private readonly request: CanvasRequest) {}
  activate() { this.alive = true; }
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<State>) { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(); }
  async load() {
    await runLoad(this.status, async () => CanvasGetResponseSchema.parse(await this.request("canvas.get", { projectId: this.projectId })), graph => {
      const refs = new Set(graph.nodes.map(n => n.ref));
      // Dirty edits survive CAS refresh; removed nodes are dropped rather than resurrected.
      const positions = { ...graph.layout.positions };
      for (const [ref, p] of Object.entries(this.state.layout.positions)) if (refs.has(ref) && !positions[ref]) positions[ref] = p;
      const automatic = canvasPositions(graph.nodes, graph.edges, { ...graph.layout, positions });
      for (const n of graph.nodes) if (n.kind !== "cluster" && !positions[n.ref]) positions[n.ref] = automatic[n.ref]!;
      for (const ref of this.dirtyPositions) if (refs.has(ref) && this.state.layout.positions[ref]) positions[ref] = this.state.layout.positions[ref]!;
      this.set({ graph, selected: this.state.selected && refs.has(this.state.selected) ? this.state.selected : null, layout: { ...graph.layout, positions, viewport: this.viewportDirty ? this.state.layout.viewport : graph.layout.viewport, ...(this.cosmeticDirty ? { groups: this.state.layout.groups, stickies: this.state.layout.stickies } : {}) } });
    }, { isUnsupported: e => /unknown method|unsupported|not implemented/i.test(errorText(e)) });
  }
  select(ref: string | null) { this.set({ selected: ref }); }
  update(layout: CanvasLayout, changedRef?: string) {
    if (this.state.graph?.readOnly) return;
    if (changedRef) this.dirtyPositions.add(changedRef); else this.viewportDirty = true;
    this.cosmeticDirty ||= layout.groups !== this.state.layout.groups || layout.stickies !== this.state.layout.stickies;
    this.serial++; this.set({ layout, dirty: true, saveError: null });
  }
  async save() {
    const { graph, layout, dirty, saving } = this.state;
    if (!this.alive || !graph || graph.readOnly || !dirty || saving) return;
    const serial = this.serial, generation = this.generation; this.set({ saving: true, saveError: null });
    try {
      const result = CanvasSaveResponseSchema.parse(await this.request("canvas.saveLayout", { projectId: this.projectId, baseRevision: graph.revision, layout }));
      if (!this.alive || generation !== this.generation) return;
      if (serial === this.serial) { this.dirtyPositions.clear(); this.viewportDirty = false; this.cosmeticDirty = false; }
      this.set({ graph: { ...this.state.graph!, revision: result.revision }, dirty: serial !== this.serial });
    } catch (error) {
      if (!this.alive || generation !== this.generation) return;
      const message = errorText(error);
      this.set({ saveError: /stale_revision/.test(message) ? "Layout changed elsewhere. Your arrangement is retained; refresh completed, then Save layout to retry." : message });
      if (/stale_revision/.test(message)) await this.load();
    } finally { if (this.alive && generation === this.generation) this.set({ saving: false }); }
  }
  interrupt() { this.generation++; this.status.interrupt("Disconnected; showing last loaded canvas"); this.set({ saving: false, saveError: this.state.dirty ? "Disconnected; arrangement retained. Refresh before saving." : this.state.saveError }); }
  dispose() { this.alive = false; this.generation++; this.status.reset(); this.listeners.clear(); }
}
