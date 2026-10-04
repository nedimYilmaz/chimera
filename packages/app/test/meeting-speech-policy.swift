// Run after concatenating the production meeting_speech.swift before this file.
// No recognition session is created; only the error recovery classification runs.
let cases: [(String, Int, Bool)] = [
    ("kAFAssistantErrorDomain", 1110, true),
    ("kAFAssistantErrorDomain", 1101, false),
    ("kAFAssistantErrorDomain", 203, false),
    ("PermissionError", 1110, false)
]
for (domain, code, expected) in cases {
    precondition(shouldRestartAfterNoSpeech(NSError(domain: domain, code: code)) == expected)
}
print("4 speech recovery cases passed")
