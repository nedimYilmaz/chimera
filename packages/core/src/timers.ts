// Node's setTimeout takes a 32-bit signed int; anything larger silently wraps to a 1 ms delay.
// Shared by jobs.ts's tick() re-arm and supervisor.ts's scheduleResume chunking — both clamp a
// possibly-far-future delay to this and re-arm on wake. Lives in its own module (rather than
// jobs.ts or supervisor.ts) because jobs.ts already does a type-only import of AgentSupervisor
// from supervisor.ts; a value import the other way would risk a module-graph cycle.
export const MAX_TIMER_DELAY_MS = 2_147_483_647;   // 2^31-1 ms — the largest setTimeout delay Node won't clamp
