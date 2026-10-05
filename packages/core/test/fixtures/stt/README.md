Local STT evidence is deliberately narrow: two synthetic sentences, not real speakers,
noise, accents or long recordings. English Samantha and Turkish Yelda were generated
with macOS `say -r 150`, then converted by `afconvert -f WAVE -d LEI16@16000 -c 1`.
The checked-in canonical PCM16 WAV bytes and their hashes are in manifest.json.

Pinned whisper.cpp 1.9.4 static CPU CLI + multilingual small-q5_1 reproduced both
reference sentences on macOS arm64 (manual CLI cold calls 2.18 s / 1.26 s).
The opt-in actual installer/IPC-pipeline test requires CMake and a C++ toolchain:

    CHIMERA_STT_LIVE=1 env -u CHIMERA_AGENT_ID -u CHIMERA_DEPTH -u CHIMERA_TREE_ID -u CHIMERA_TEAM -u CHIMERA_ROLE npx vitest run packages/core/test/stt-live.test.ts

This downloads pinned 9.35 MB source + 190.09 MB model into a temporary directory,
builds a static CPU CLI, checks hashes, transcribes both fixture WAVs through LocalStt,
checks WER <= 10% and latency < 25 s, then uninstalls. No microphone or daemon is opened.
Production installs only from the Settings button. macOS arm64/Linux x64 local builds
are offered; Linux has not received a real runtime/quality gate here. Windows and
macOS x64 Whisper installs are unsupported. Missing CMake/compiler is an explicit
install failure with retry; no cloud fallback, automatic download or automatic update.
Runtime source is pinned; the local build binary SHA-256 is recorded in the installation
manifest and reverified together with the pinned model before every launch. That local
build digest depends on the host compiler; it is not claimed to be an upstream binary pin.

Apple on-device availability is read from SFSpeechRecognizer without prompting; actual
Speech authorization occurs only after explicit hold/release. requiresOnDeviceRecognition
remains forced. Apple capture is limited to 30 seconds to stay within one native round.
Apple permissions/quality and physical microphone behavior cannot be proven headlessly;
Chromium uses an owned fake device. Whisper supports final text only; the current dictation
UI inserts only a final transcript and never sends. Rollback: revert the feature; delete
only <state>/stt and <state>/stt.json. Other voice engines/settings are preserved.
