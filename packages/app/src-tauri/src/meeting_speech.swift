import Foundation
import Speech
import AVFoundation

func shouldRestartAfterNoSpeech(_ error: NSError) -> Bool {
    error.domain == "kAFAssistantErrorDomain" && error.code == 1110
}

private typealias EventCallback = @convention(c) (UInt64, UnsafePointer<CChar>) -> Void
private let speechQueue = DispatchQueue(label: "dev.chimera.meeting-speech")
private var sessions: [UInt64: SpeechSession] = [:]
private enum PendingSpeechInput { case audio([Float], Double); case finish(String?) }

private final class SpeechSession {
    let token: UInt64
    let id: String
    let recognizer: SFSpeechRecognizer
    let hints: [String]
    let callback: EventCallback
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var round = 0
    var finishing = false
    var announcedReady = false
    var voicedSeconds = 0.0
    var roundSeconds = 0.0
    var pending: [PendingSpeechInput] = []
    var pendingSeconds = 0.0
    var boundaryId: String?

    init(token: UInt64, id: String, recognizer: SFSpeechRecognizer, hints: [String], callback: @escaping EventCallback) {
        self.token = token; self.id = id; self.recognizer = recognizer; self.hints = hints; self.callback = callback
    }
    func emit(_ type: String, text: String? = nil, final: Bool? = nil, error: String? = nil) {
        var event: [String: Any] = ["sessionId": id, "type": type]
        if type == "transcript" { event["utteranceId"] = "\(token):\(round)" }
        if final == true, let boundaryId = boundaryId { event["boundaryId"] = boundaryId }
        if let text = text { event["text"] = text }
        if let final = final { event["final"] = final }
        if let error = error { event["error"] = error }
        guard let data = try? JSONSerialization.data(withJSONObject: event), let json = String(data: data, encoding: .utf8) else { return }
        json.withCString { callback(token, $0) }
    }
    func stop() {
        round += 1
        request?.endAudio(); task?.cancel(); request = nil; task = nil
        pending.removeAll(); pendingSeconds = 0
    }
    func fail(_ message: String) {
        guard sessions[token] === self else { return }
        sessions.removeValue(forKey: token); stop(); emit("error", error: message)
    }
    func beginRound() {
        guard sessions[token] === self else { return }
        guard recognizer.isAvailable && recognizer.supportsOnDeviceRecognition else {
            fail("On-device speech recognition became unavailable. No audio was sent to a cloud recognizer."); return
        }
        round += 1
        let currentRound = round
        finishing = false; voicedSeconds = 0; roundSeconds = 0; boundaryId = nil
        let next = SFSpeechAudioBufferRecognitionRequest()
        next.requiresOnDeviceRecognition = true
        next.shouldReportPartialResults = true
        next.contextualStrings = hints
        next.taskHint = .dictation
        request = next
        task = recognizer.recognitionTask(with: next) { [weak self] result, error in
            speechQueue.async {
                guard let self = self, sessions[self.token] === self, self.round == currentRound else { return }
                if let result = result {
                    self.emit("transcript", text: result.bestTranscription.formattedString, final: result.isFinal)
                    if result.isFinal { self.restartRound(); return }
                }
                if let error = error {
                    // Recognition can find no words even when VAD detected noise.
                    // Complete an empty boundary and keep the microphone alive.
                    if shouldRestartAfterNoSpeech(error as NSError) {
                        if self.boundaryId != nil { self.emit("transcript", text: "", final: true) }
                        self.restartRound()
                    }
                    else { self.fail("On-device speech recognition failed: \(error.localizedDescription)") }
                }
            }
        }
        if !announcedReady { announcedReady = true; emit("ready") }
    }
    func restartRound() {
        round += 1
        task?.cancel(); task = nil; request = nil
        let buffered = pending; pending.removeAll(); pendingSeconds = 0
        beginRound()
        for input in buffered {
            switch input {
            case .audio(let samples, let rate): append(samples, rate: rate)
            case .finish(let boundary): finishRound(boundary: boundary)
            }
        }
    }
    func finishRound(boundary: String? = nil) {
        guard sessions[token] === self else { return }
        if finishing {
            guard pending.count < 160 else { fail("Too many pending local speech boundaries."); return }
            pending.append(.finish(boundary)); return
        }
        boundaryId = boundary; finishing = true; request?.endAudio()
        let currentRound = round
        speechQueue.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self = self, sessions[self.token] === self, self.round == currentRound, self.finishing else { return }
            self.fail("On-device speech recognition did not finalize the utterance. Try the microphone again.")
        }
    }
    func append(_ samples: [Float], rate: Double) {
        guard sessions[token] === self, let request = request else { return }
        let duration = Double(samples.count) / rate
        if finishing {
            guard pendingSeconds + duration <= 3 else { fail("On-device speech recognition could not keep up with the microphone."); return }
            pending.append(.audio(samples, rate)); pendingSeconds += duration; return
        }
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData?[0] else { fail("Could not prepare microphone audio for local recognition."); return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in channel.update(from: source.baseAddress!, count: samples.count) }
        request.append(buffer)
        roundSeconds += duration
        let rms = sqrt(samples.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(samples.count))
        if rms >= 0.012 { voicedSeconds += duration }
        // Normal utterances finish through the caller's VAD. Roll over long
        // requests before the OS task limit without changing authorization.
        if roundSeconds >= 45 { finishRound() }
    }
}

@_cdecl("chimera_meeting_speech_start")
public func meetingSpeechStart(_ token: UInt64, _ config: UnsafePointer<CChar>, _ callback: @escaping @convention(c) (UInt64, UnsafePointer<CChar>) -> Void) {
    let copied = String(cString: config)
    speechQueue.async {
        guard let data = copied.data(using: .utf8), let values = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = values["sessionId"] as? String, let locale = values["locale"] as? String,
              let hints = values["contextualStrings"] as? [String] else { return }
        let tag = locale.replacingOccurrences(of: "_", with: "-").lowercased()
        let supported = SFSpeechRecognizer.supportedLocales().contains { $0.identifier.replacingOccurrences(of: "_", with: "-").lowercased() == tag }
        guard supported, let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            let error: [String: Any] = ["sessionId": id, "type": "error", "error": "On-device speech recognition is unavailable for \(locale). No cloud fallback is enabled."]
            if let encoded = try? JSONSerialization.data(withJSONObject: error), let json = String(data: encoded, encoding: .utf8) { json.withCString { callback(token, $0) } }
            return
        }
        let session = SpeechSession(token: token, id: id, recognizer: recognizer, hints: hints, callback: callback)
        sessions[token] = session
        DispatchQueue.main.async {
            guard speechQueue.sync(execute: { sessions[token] === session }) else { return }
            SFSpeechRecognizer.requestAuthorization { status in
                speechQueue.async {
                    guard sessions[token] === session else { return }
                    if status == .authorized { session.beginRound() }
                    else { session.fail("Speech recognition permission was not granted. Enable it for Chimera in System Settings > Privacy & Security > Speech Recognition.") }
                }
            }
        }
    }
}

@_cdecl("chimera_meeting_speech_append")
public func meetingSpeechAppend(_ token: UInt64, _ samples: UnsafePointer<Float>, _ count: Int, _ rate: Double) {
    // Backpressure keeps PCM bounded; the caller's pointer stays valid until
    // this synchronous copy and append complete. No PCM touches disk.
    speechQueue.sync { sessions[token]?.append(Array(UnsafeBufferPointer(start: samples, count: count)), rate: rate) }
}

@_cdecl("chimera_meeting_speech_stop")
public func meetingSpeechStop(_ token: UInt64) {
    speechQueue.async { sessions.removeValue(forKey: token)?.stop() }
}

@_cdecl("chimera_meeting_speech_finish")
public func meetingSpeechFinish(_ token: UInt64, _ boundary: UnsafePointer<CChar>?) {
    let id = boundary.map { String(cString: $0) }
    speechQueue.async { sessions[token]?.finishRound(boundary: id) }
}
