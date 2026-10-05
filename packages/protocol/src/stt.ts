import { z } from "zod";

export const SttEngineSchema = z.enum(["apple-on-device", "whisper-cpp"]);
export const SttPreferencesSchema = z.object({ v: z.literal(1), engine: SttEngineSchema.nullable(), language: z.enum(["en", "tr"]) }).strict();
export const SttStatusSchema = z.object({
  preferences: SttPreferencesSchema,
  engines: z.array(z.object({ id: SttEngineSchema, available: z.boolean(), installed: z.boolean(), version: z.string().optional(), languages: z.array(z.string()), reason: z.string().optional() }).strict()),
  install: z.object({ state: z.enum(["idle", "downloading", "verifying", "building", "installed", "failed"]), progress: z.number().min(0).max(1), error: z.string().optional() }).strict(),
  model: z.object({ id: z.literal("small-q5_1"), bytes: z.number().int().positive(), sha256: z.string(), license: z.string(), runtimeVersion: z.string(), runtimeSha256: z.string(), path: z.string() }).strict(),
}).strict();
export const SttInstallSchema = z.object({ engine: z.literal("whisper-cpp"), model: z.literal("small-q5_1") }).strict();
// 60 seconds PCM16 mono = 1,920,044 bytes / 2,560,060 base64 chars, below
// the daemon's 32 MiB frame cap. No arbitrary path, executable or URL crosses IPC.
export const SttTranscribeSchema = z.object({ requestId: z.string().uuid(), engine: z.literal("whisper-cpp"), language: z.enum(["en", "tr"]), audio: z.object({ format: z.literal("wav-pcm16-16k-mono"), base64: z.string().min(60).max(2_560_060).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict() }).strict();
export const SttTranscriptSchema = z.object({ text: z.string().max(8192), language: z.string(), durationMs: z.number().nonnegative(), engine: SttEngineSchema }).strict();
export const SttCancelSchema = z.object({ requestId: z.string().uuid() }).strict();
export type SttStatus = z.infer<typeof SttStatusSchema>;
