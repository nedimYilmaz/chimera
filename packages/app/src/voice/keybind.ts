// VOICE-STOP: the stop must work on EVERY screen — the operator can be in Settings when the app
// starts talking. Composer (where the voice UI lives) only mounts on the agents/welcome screens,
// so registering there left Esc meaning "close overlay" everywhere else. These two registrations
// are page-lifetime, installed from the store bootstrap next to installSpeakingWatchdog().
import { registerActionHandler, registerWhen } from "../keymap";
import { stopSpeakingNow } from "./session";
import { voiceLocal } from "./store";
import { nativeCodexVoice } from "./nativeCodex";
import { meetingHost } from "./meetingHost";

let installed = false;

export function installVoiceStopKeybinding(): () => void {
  if (installed) return () => {};
  installed = true;
  const nativeActive = () => ["connecting", "listening"].includes(nativeCodexVoice.getState().status);
  const inMeeting = () => meetingHost.getState().some(room => room.joined);
  const offWhen = registerWhen("voiceSpeaking", () => inMeeting() || nativeActive() || voiceLocal.getState().status === "speaking");
  const offAction = registerActionHandler("voice.stopSpeaking", () => { if (inMeeting()) meetingHost.leave(); else if (nativeActive()) nativeCodexVoice.stop(); else stopSpeakingNow(); });
  return () => { installed = false; offWhen(); offAction(); };
}
