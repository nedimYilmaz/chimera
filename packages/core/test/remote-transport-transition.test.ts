import { describe, it, expect, vi } from 'vitest';
import { makeMultiProviderSupervisor } from './helpers.js';
import type { FakeStep } from '@chimera/core/backends/fake';

const idle: FakeStep[] = [{ emit: { kind: 'agent_started', data: { sessionId: 'same-native-session' } } }, { awaitSend: true }];
async function setup(options: Record<string, unknown> = {}) {
  const h = makeMultiProviderSupervisor([], [idle, idle]);
  const spawn = h.codex.spawn.bind(h.codex);
  vi.spyOn(h.codex, 'spawn').mockImplementation((spec, ...rest) => {
    const handle = spawn(spec, ...rest);
    // The first handle represents an exec process restored from before the default changed.
    if (h.codex.spawns.length === 1 && options.codexTransport !== 'app-server') delete handle.remoteControl;
    return handle;
  });
  const r = await h.sup.spawn({ provider: 'codex', account: 'cx-main', prompt: 'x', cwd: '/tmp', isolation: 'none', session: true, resumeOnly: true, resume: 'same-native-session', permissionProfile: 'full', acknowledgeCodexFullAccessRisk: true, displayLabel: 'my-codex', providerOptions: options });
  await vi.waitFor(() => expect(r.sessionId).toBe('same-native-session'));
  return { ...h, r };
}

describe('explicit remote connection transition', () => {
  it('requires acknowledgment, then resumes the same identity/session with no task replay', async () => {
    const { sup, codex, r, events } = await setup({ codexTransport: 'exec', unrelated: 'kept' });
    await expect(sup.remoteControl(r.agentId, true)).rejects.toThrow('Confirm switch and enable');
    expect(codex.spawns).toHaveLength(1);
    const result = await sup.remoteControl(r.agentId, true, undefined, true);
    expect(result).toMatchObject({ enabled: true, name: 'my-codex' });
    expect(sup.status(r.agentId)).toBe(r);
    expect(codex.spawns).toHaveLength(2);
    expect(codex.spawns[1]).toMatchObject({ agentId: r.agentId, resume: 'same-native-session', resumeOnly: true, permissionProfile: 'full', cwd: '/tmp', accountName: 'cx-main', persistent: true, providerOptions: { codexTransport: 'app-server', unrelated: 'kept' } });
    expect(events.tail(r.agentId, 100).some(e => e.kind === 'status' && e.data.state === 'killed')).toBe(false);
    expect(r.remoteControlIntent).toMatchObject({ enabled: true });
    await sup.remoteControl(r.agentId, false);
    expect(codex.spawns).toHaveLength(2);
    expect(r.remoteControlIntent).toBeUndefined();
    await sup.kill(r.agentId);
  });
  it('refuses a busy turn without changing its connection or intent', async () => {
    const { sup, codex, r } = await setup();
    const handles = (sup as any).handles;
    handles.get(r.agentId).isTurnActive = () => true;
    await expect(sup.remoteControl(r.agentId, true, undefined, true)).rejects.toThrow('Nothing was interrupted');
    expect(codex.spawns).toHaveLength(1); expect(r.remoteControlIntent).toBeUndefined();
    expect(r.spec.providerOptions.codexTransport).toBeUndefined();
    await sup.kill(r.agentId);
  });
  it('does not revive a paused agent or transition without a native session', async () => {
    const { sup, codex, r } = await setup();
    r.sessionId = undefined;
    await expect(sup.remoteControl(r.agentId, true, undefined, true)).rejects.toThrow('establish its session');
    r.sessionId = 'same-native-session';
    await sup.hold(r.agentId);
    await expect(sup.remoteControl(r.agentId, true, undefined, true)).rejects.toThrow('resume it');
    expect(codex.spawns).toHaveLength(1); expect(r.state).toBe('paused');
    await sup.kill(r.agentId);
  });
});
