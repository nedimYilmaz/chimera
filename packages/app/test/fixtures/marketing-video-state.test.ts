import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AgentResourcesResponseSchema, CanvasGetResponseSchema, ContextLinkViewSchema } from '@chimera/protocol';
import { ids, marketingRpc } from './marketing-data';

let rpc: (method: string, params?: Record<string, unknown>) => unknown;
let hooks: { transition(id: string, state: string): void; misses(): string[] };
let dispatch: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('window', { __MARKETING_RPC__: marketingRpc });
  const video = await import('./marketing-video-state');
  rpc = (window as unknown as { __MARKETING_RPC__: typeof rpc }).__MARKETING_RPC__;
  dispatch = vi.fn();
  video.installVideoHooks({ dispatch, getState: () => ({ lastSeq: 40 }) });
  hooks = (window as unknown as { __MARKETING_VIDEO__: typeof hooks }).__MARKETING_VIDEO__;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('usage video fixture safety and visible state', () => {
  it('throws and records unknown RPCs instead of returning an empty success', () => {
    expect(() => rpc('provider.realSideEffect')).toThrow('has no answer');
    expect(hooks.misses()).toEqual(['provider.realSideEffect']);
  });
  it('filters memory and preserves resolvable linked notes', () => {
    const hits = rpc('memory.search', { query: 'webp' }) as { record: { id: string } }[];
    expect(hits.map(h => h.record.id).sort()).toEqual(['m-0007', 'm-0008']);
    expect(rpc('memory.search', { query: 'nonexistent fictional word' })).toEqual([]);
    expect(rpc('memory.get', { id: 'm-0007' })).toMatchObject({ record: { id: 'm-0007' } });
  });
  it('pushes deterministically, updates counts and emits real reducer coordination events', () => {
    const detail = () => rpc('queue.status', { queue: 'atlas-release' }) as { counts: Record<string, number>; tasks: {taskId: string; state: string}[] };
    const pending = detail().counts.pending;
    expect(rpc('queue.push', { queue: 'atlas-release', prompt: 'Demo task' })).toEqual({ taskId: 'd1e5a7c3', state: 'pending' });
    expect(detail().counts.pending).toBe(pending + 1);
    hooks.transition('d1e5a7c3', 'in_progress');
    expect(detail().tasks.at(-1)?.state).toBe('in_progress');
    expect(detail().counts.pending).toBe(pending);
    expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'event', event: expect.objectContaining({ seq: 41, agentId: 'task:d1e5a7c3', kind: 'status' }) }));
    hooks.transition('d1e5a7c3', 'done');
    expect(detail().tasks.at(-1)?.state).toBe('done');
  });
  it('answers shared header and inspector resources in both still and video fixtures', () => {
    for (const read of [marketingRpc, rpc]) {
      for (const agentId of [ids.conductor, ids.pricing]) {
        const result = AgentResourcesResponseSchema.parse(read('agent.resources', { agentId }));
        expect(result.sample.agentId).toBe(agentId);
        expect(result.sample.totals).toMatchObject({ cpuPct: 15.5, rssBytes: 232 * 1024 ** 2 });
      }
    }
    expect(hooks.misses()).toEqual([]);
  });
  it('validates the new capture services and makes revoked snapshot bodies unreadable', () => {
    expect(AgentResourcesResponseSchema.parse(rpc('agent.resources', { agentId: ids.conductor })).sample.totals.procCount).toBe(2);
    expect(CanvasGetResponseSchema.parse(rpc('canvas.get', { projectId: 'atlas-website' })).nodes).toHaveLength(4);
    const link = ContextLinkViewSchema.parse(rpc('contextlink.create', { from: { kind: 'agent-summary', ref: ids.conductor }, toAgentId: ids.conductor, title: 'Reviewed release', expiresAt: null }));
    expect(rpc('contextlink.get', { id: link.id })).toMatchObject({ snapshot: { text: expect.stringContaining('Atlas release:') } });
    rpc('contextlink.revoke', { id: link.id });
    expect(() => rpc('contextlink.get', { id: link.id })).toThrow('Snapshot unavailable');
    expect(() => rpc('contextlink.fakeSideEffect', { id: link.id })).toThrow('has no answer');
  });

});
