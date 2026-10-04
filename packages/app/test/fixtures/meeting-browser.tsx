import React from "react";
import "../../src/styles/tokens.css";
import "../../src/styles/fonts.css";
import "../../src/styles/base.css";
import { createRoot } from "react-dom/client";
import type { VoiceRoomSpec } from "@chimera/protocol/voice-rooms";
import { MeetingAudio } from "../../src/voice/meetingAudio";

export async function runAudioProbe() {
  const failures: string[] = [];
  let localFrames = 0;
  const one = new MeetingAudio(["a", "b"], 20, () => {}, e => failures.push(e), () => {}, () => {}, undefined, samples => { if (samples.some(x => Math.abs(x) > 0.01)) localFrames++; });
  const two = new MeetingAudio(["c", "d"], 20, () => {}, e => failures.push(e));
  await Promise.all([one.prepare(), two.prepare()]);
  const playback = one.context.createMediaStreamDestination();
  (one as unknown as { speaker: GainNode }).speaker.connect(playback);
  await one.setSpeaker(true);
  const meter = (room: MeetingAudio, id: string) => {
    const source = room.context.createMediaStreamSource(id === "playback" ? playback.stream : room.input(id));
    const analyser = room.context.createAnalyser(); analyser.fftSize = 2048; source.connect(analyser);
    const silent = room.context.createGain(); silent.gain.value = 0; analyser.connect(silent); silent.connect(room.context.destination);
    return () => { const samples = new Float32Array(2048); analyser.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((sum, x) => sum + x*x, 0) / samples.length); };
  };
  const own = meter(one, "a"), other = meter(one, "b"), audible = meter(one, "playback"), isolated = meter(two, "c");
  const oscillator = one.context.createOscillator(); oscillator.frequency.value = 300;
  const output = one.context.createMediaStreamDestination();
  oscillator.connect(output); one.capture("a", output.stream); oscillator.start();
  await new Promise(r => setTimeout(r, 1800));
  // Measure continuity after warmup on the actual receiving bus, not a single
  // lucky RMS snapshot between the old inter-frame dropouts.
  let silentRun = 0, maxSilentRun = 0, captured = 0, receiving = false;
  const received = one.context.createMediaStreamSource(playback.stream);
  const probe = new AudioWorkletNode(one.context, "chimera-room-capture");
  const silence = one.context.createGain(); silence.gain.value = 0;
  received.connect(probe); probe.connect(silence); silence.connect(one.context.destination);
  probe.port.onmessage = event => { for (const x of event.data.samples as Float32Array) { if (Math.abs(x) >= 0.001) receiving = true; if (!receiving) continue; captured++; silentRun = Math.abs(x) < 0.001 ? silentRun + 1 : 0; maxSilentRun = Math.max(maxSilentRun, silentRun); } };
  // On a busy host, worklet messages can arrive after the wall-clock sample window.
  // Keep the minimum observation window AND the existing sample-count requirement;
  // a bounded deadline still fails when capture is broken rather than merely delayed.
  const sampleStarted = performance.now();
  while (performance.now() - sampleStarted < 6000
    && (performance.now() - sampleStarted < 1200 || captured <= 10_000)) {
    await new Promise(r => setTimeout(r, 50));
  }
  const result = { self: own(), participant: other(), audible: audible(), localFrames: 0, otherRoom: isolated(), failures, afterHumanLeaves: 0, maxSilenceMs: maxSilentRun / one.context.sampleRate * 1000, captured, duringPause: 0, operatorPeer: 0, humanInput: 0, state: one.context.state, time: one.context.currentTime, speaker: one.floor.speaker, waiting: one.floor.waiting() };
  probe.port.onmessage = null; received.disconnect(); probe.disconnect(); silence.disconnect();
  one.setPaused(true); await new Promise(r => setTimeout(r, 250)); result.duringPause = audible();
  one.setPaused(false);
  const originalMic = navigator.mediaDevices.getUserMedia;
  const human = one.context.createOscillator(); human.frequency.value = 600;
  const humanGain = one.context.createGain(); const humanBus = one.context.createMediaStreamDestination();
  human.connect(humanGain); humanGain.connect(humanBus); human.start();
  navigator.mediaDevices.getUserMedia = async () => humanBus.stream;
  try {
    await one.setMicrophone(true); await new Promise(r => setTimeout(r, 250)); result.humanInput = own();
    humanGain.gain.value = 0; await new Promise(r => setTimeout(r, 1100)); result.operatorPeer = other();
  } finally { navigator.mediaDevices.getUserMedia = originalMic; human.stop(); }
  one.focus(false); await new Promise(r => setTimeout(r, 250)); result.afterHumanLeaves = other();
  result.localFrames = localFrames;
  oscillator.stop(); one.close(); two.close(); return result;
}

export async function runManagedAudioProbe({ samplingDelayMs = 200 }: { samplingDelayMs?: number } = {}) {
  const failures: string[] = [];
  let turns = 0;
  const room = new MeetingAudio(["a", "b", "listener"], 60, () => {}, e => failures.push(e), () => {}, () => {}, () => { turns++; });
  await room.prepare(); room.setParticipantListening("listener", true);
  const playback = room.context.createMediaStreamDestination();
  (room as unknown as { speaker: GainNode }).speaker.connect(playback);
  await room.setSpeaker(true);
  const meter = (id: string) => {
    const source = room.context.createMediaStreamSource(id === "playback" ? playback.stream : room.input(id));
    const analyser = room.context.createAnalyser(); analyser.fftSize = 2048; source.connect(analyser);
    const zero = room.context.createGain(); zero.gain.value = 0; analyser.connect(zero); zero.connect(room.context.destination);
    return () => { const samples = new Float32Array(2048); analyser.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((sum, x) => sum + x*x, 0) / samples.length); };
  };
  const audible = meter("playback"), listener = meter("listener"), a = meter("a");
  const mic = navigator.mediaDevices.getUserMedia;
  const humanBus = room.context.createMediaStreamDestination();
  navigator.mediaDevices.getUserMedia = async () => humanBus.stream;
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
  try {
    await room.setMicrophone(true);
    const older = { samples: new Float32Array(24000).fill(0.2), rate: 48000, capturedAt: room.context.currentTime };
    room.floor.push("a", older); room.floor.push("b", { ...older, samples: new Float32Array(24000).fill(0.4) });
    await pause(900); const held = audible();
    room.addParticipant("late"); room.setParticipantListening("late", true); const late = meter("late");
    room.setRecipient("b"); await pause(samplingDelayMs);
    const selected = audible(), noSelfOrOtherSpeaker = a(), noHistory = late();
    await pause(600);
    room.floor.push("b", { samples: new Float32Array(24000).fill(0.4), rate: 48000, capturedAt: room.context.currentTime });
    await pause(samplingDelayMs); const liveJoin = late();
    // Switch while b still has scheduled PCM; late b frames must not leak
    // through the new recipient, and listener toggles must keep the graph live.
    room.setRecipient("a");
    room.floor.push("b", { ...older, samples: new Float32Array(24000).fill(0.4) });
    room.floor.push("a", older);
    await pause(samplingDelayMs); const switched = audible();
    room.setParticipantListening("a", true);
    await pause(100); const listenerMuted = audible();
    room.setParticipantListening("a", false); room.floor.push("a", older);
    await pause(samplingDelayMs); const resumed = audible();
    const unchangedInput = room.input("a").getAudioTracks()[0]!.readyState;
    return { held, selected, switched, listenerMuted, resumed, listenerInput: listener(), noSelfOrOtherSpeaker, noHistory, liveJoin, turns, unchangedInput, state: room.context.state, failures };
  } finally { navigator.mediaDevices.getUserMedia = mic; room.close(); }
}

export async function renderMeeting() {
  let room = { id: "f38dfae2-01c8-4bea-8ca4-0429d61e4e21", revision: 1, pendingUpdate: undefined as VoiceRoomSpec | undefined, name: "Architecture review", agenda: "Review the implementation, agree on next steps, and continue delivery.", agentIds: ["a","b","c"], durationMinutes: 15, maxUtterances: 60, state: "active",
    participants: [{ agentId: "a", name: "Atlas", role: "conductor", state: "running" }, { agentId: "b", name: "Nova", role: "engineer", state: "running" }, { agentId: "c", name: "Sage", role: "reviewer", state: "running" }] };
  let view = [{ context: [] as any[], room, joined: false, observing: true, microphone: false, speakerEnabled: false, micPending: false, paused: false, humanSpeaking: false, connecting: false, speaker: "a", waiting: ["c"], error: null,
    participants: Object.fromEntries(room.agentIds.map(id => [id, { mode: "speaker", pending: false }])),
    agents: { a: { status: "listening", messages: [{ id: "m1", role: "assistant", text: "Atlas here. Nova, the audio isolation checks are passing. Sage, please review the permission boundaries.", final: true, ts: Date.now() }] }, b: { status: "listening" }, c: { status: "listening" } } }];
  const target = window as any;
  target.__ROOM_TEST_STATE = { connected: true, selectedAgentId: "a", activeTab: "agents", agents: Object.fromEntries(room.participants.map(p => [p.agentId, { ...p, provider: "codex", displayLabel: p.name }])) };
  const listeners = new Set<() => void>();
  const update = (patch: Record<string, unknown>) => { view = [{ ...view[0]!, ...patch }]; for (const f of listeners) f(); };
  target.__SET_MEETING_AVATAR_STATE__ = update;
  const actions: string[] = [];
  target.__MEETING_HOST__ = { submitText: (_id: string, text: string) => { target.__LAST_MEETING_TEXT__ = text; update({ context: [{ id: "typed", speaker: "operator", text, ts: Date.now() }] }); }, startDiscussion: () => update({ discussion: true }), stopDiscussion: () => update({ discussion: false }), subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); }, getState: () => view, leave: () => update({ joined: false, microphone: false, speakerEnabled: false }), observe: () => update({ joined: false, microphone: false, speakerEnabled: false }), stopAll: () => {}, join: async () => update({ joined: true, speakerEnabled: true }), setSpeaker: async (_id: string, enabled: boolean) => update({ speakerEnabled: enabled }), setMicrophone: async (_id: string, enabled: boolean) => update({ microphone: enabled }), setPaused: (_id: string, paused: boolean) => update({ paused }), end: () => {},
    reviewUpdate: async (_id: string, revision: number, accept: boolean) => {
      if (revision !== room.revision) throw new Error("Wrong proposal revision");
      const proposal = room.pendingUpdate!;
      room = { ...room, ...(accept ? proposal : {}), pendingUpdate: undefined, revision: revision + 1 };
      update({ room, participants: Object.fromEntries(room.agentIds.map(id => [id, { mode: "speaker", pending: false }])) });
    },
    setAutoParticipation: (_id: string, enabled: boolean) => update({ autoParticipation: enabled, discussion: false }),
    chooseRecipient: (_id: string, agentId: string) => update({ recipient: agentId }),
    setListener: async (_id: string, agent: string, listener: boolean) => update({ participants: { ...view[0]!.participants, [agent]: { mode: listener ? "listener" : "speaker", pending: false } } }),
    removeParticipant: async (_id: string, agent: string) => { actions.push(`remove:${agent}`); room = { ...room, revision: room.revision + 1, agentIds: room.agentIds.filter(id => id !== agent), participants: room.participants.filter(p => p.agentId !== agent) }; update({ room }); },
    endMeeting: async () => { actions.push("end"); room = { ...room, state: "ended" }; update({ room }); },
  };
  target.__CHIMERA_MOCK__.rpc = async (method: string, params: any) => {
    if (method === "agent.hold" || method === "agent.killMany") {
      if (JSON.stringify(params.agentIds) !== '["a","b"]') throw new Error("Wrong bulk action targets");
      actions.push(method);
      return method === "agent.hold" ? { held: ["a"], skipped: [{ agentId: "b", state: "already paused" }] } : { succeeded: ["a", "b"], failed: [] };
    }
    return { rooms: [room], limits: { maxRooms: 32, maxSessions: 16, maxParticipants: 8 } };
  };
  const { MeetingRooms, MeetingRoomsProvider, MeetingRoomsBand, useMeetingRooms } = await import("../../src/components/MeetingRooms");
  const { FleetNavigation } = await import("../../src/components/FleetNavigation");
  const { useState } = await import("react");
  function Surface() {
    const meetings = useMeetingRooms()!;
    const [viewName, setViewName] = useState<"inspector" | "dashboard" | "liveboard">("inspector");
    return <><MeetingRoomsBand /><FleetNavigation view={meetings.open ? "meetings" : viewName} onChange={next => {
      if (next === "meetings") meetings.openRooms();
      else { if (meetings.open) meetings.closeRooms(); setViewName(next); }
    }} /><div style={{ display: "flex", flex: 1, minHeight: 0, paddingTop: 6 }}><MeetingRooms /></div></>;
  }
  document.getElementById("root")!.style.cssText = "height:100vh;display:flex;flex-direction:column;overflow:hidden";
  createRoot(document.getElementById("root")!).render(<MeetingRoomsProvider><Surface /></MeetingRoomsProvider>);
  await new Promise(r => setTimeout(r, 700));
  [...document.querySelectorAll("button")].find(b => b.textContent?.includes("Architecture review"))!.click();
  await new Promise(r => setTimeout(r, 300));
  document.querySelector<HTMLDetailsElement>("details:has(> summary[data-participant-settings])")!.open = true;
  if (!document.body.innerText.includes("Waiting for the floor")) throw new Error("Meeting stage failed to render");
  const click = async (text: string) => { const button = [...document.querySelectorAll("button")].find(b => b.textContent === text); if (!button) throw new Error(`Missing control: ${text}`); button.click(); await new Promise(r => setTimeout(r, 100)); };
  if (!document.body.innerText.includes("watching silently")) throw new Error("Room must open as silent observer");
  await click("Listen from outside");
  if (document.body.innerText.includes("You · participant")) throw new Error("Listening cannot join the human seat");
  await click("Join meeting · mic off");
  if (!document.body.innerText.includes("You · participant")) throw new Error("Join failed");
  await click("Mic on · take the floor");
  if (!document.body.innerText.includes("Active participation:")) throw new Error("Priority state missing");
  await click("Pause agent audio"); await click("Resume agent audio");
  await click("Leave seat · observe");
  target.__EXERCISE_MEETING_UPDATES__ = async () => {
    const original = room;
    const proposal = { name: room.name, agenda: "Continue together", agentIds: [...room.agentIds, "d"], durationMinutes: room.durationMinutes, maxUtterances: room.maxUtterances };
    room = { ...room, revision: room.revision + 1, pendingUpdate: proposal };
    update({ room, joined: true, microphone: true, speakerEnabled: true }); await new Promise(r => setTimeout(r, 100));
    if (!document.body.innerText.includes("Review meeting changes · conversation continues")) throw new Error("Live invitation not shown");
    await click("Decline changes");
    if (!view[0]!.microphone || room.agentIds.includes("d") || actions.length) throw new Error("Decline interrupted the meeting");
    room = { ...room, revision: room.revision + 1, pendingUpdate: proposal }; update({ room }); await new Promise(r => setTimeout(r, 100));
    await click("Approve changes · keep meeting going");
    if (!room.agentIds.includes("d") || !view[0]!.microphone || !view[0]!.speakerEnabled || actions.length) throw new Error("Approval interrupted the meeting");
    room = { ...original, revision: room.revision + 1 }; update({ room, joined: false, microphone: false });
    return { approvalPreservedMicrophone: true, declinePreservedMeeting: true };
  };
  target.__EXERCISE_MEETING_CONTROLS__ = async () => {
    const participants = document.querySelector<HTMLDetailsElement>('details:has(> summary[data-participant-settings])')!;
    if (!participants.open) participants.querySelector("summary")!.click();
    const byLabel = async (label: string) => { const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); if (!button) throw new Error(`Missing ${label}`); button.click(); await new Promise(r => setTimeout(r, 100)); };
    await byLabel("Make listener: Atlas");
    if (!document.body.innerText.includes("Listener · transcript retained")) throw new Error("Listener status missing");
    await byLabel("Allow speaking: Atlas"); await byLabel("Remove from room: Sage");
    if (document.activeElement?.textContent !== "Cancel") throw new Error("Confirmation should focus Cancel");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); await new Promise(r => setTimeout(r, 100));
    if (actions.length || document.querySelector('[role="alertdialog"]')) throw new Error("Escape must cancel without mutations");
    await byLabel("Remove from room: Sage"); await click("Remove participant");
    if (document.querySelector('button[aria-label="Remove from room: Sage"]')) throw new Error("Dismissed participant still present");
    [...document.querySelectorAll("summary")].find(s => s.textContent?.includes("Stop coding agents"))!.click();
    await click("Kill all coding agents…"); await click("Cancel");
    if (actions.join() !== "remove:c") throw new Error("Unconfirmed bulk action executed");
    await click("Pause all coding agents…");
    const targets = [...document.querySelectorAll('[role="alertdialog"] li')].map(li => li.textContent);
    if (targets.join() !== "Atlas,Nova") throw new Error("Confirmation has wrong roster");
    await click("Confirm pause");
    if (!document.body.innerText.includes("Not paused: already paused")) throw new Error("Partial failure hidden");
    await click("Kill all coding agents…"); await click("Confirm kill");
    if (actions.join() !== "remove:c,end,agent.hold,end,agent.killMany") throw new Error(`Bad action order: ${actions}`);
    update({ error: "Native voice event channel closed", room: { ...room, diagnostics: [{ at: Date.now(), origin: "desktop", source: "webrtc", event: "channel-closed", message: "Native voice event channel closed" }] } });
    await click("Back to inspector · leave audio");
    if (!document.querySelector('[role="alert"]')?.textContent?.includes("Native voice event channel closed")) throw new Error("Closed meeting lost its failure banner");
    await click("Architecture review stopped: Native voice event channel closed");
    if (!document.body.innerText.includes("Connection diagnostics") || !document.body.innerText.includes("channel-closed")) throw new Error("Connection diagnostics were not retained");
    return { actions, targets, partialFailureVisible: true, failureVisibleOutsideRoom: true, diagnosticsVisible: true };
  };
}
