#!/usr/bin/env node
// KIMI-BACKEND S2: a stand-in "kimi" executable for kimi-backend.test.ts's real-process kill()
// assertion. Deliberately ignores every argv (--session/--work-dir/--wire/...) and never writes
// a byte to stdout, so the SDK's ProtocolClient never completes its initialize handshake — the
// point of this fixture is only to BE a real, live, killable child process, proving
// AgentHandle.kill() terminates the actual OS process (not merely the event stream), independent
// of whether the wire protocol itself ever succeeds.
setInterval(() => {}, 60_000);
