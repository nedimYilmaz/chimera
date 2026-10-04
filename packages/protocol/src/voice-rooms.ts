import { z } from "zod";

export const VoiceLimitsSchema = z.object({
  maxRooms: z.number().int().min(1).max(128).default(32),
  maxSessions: z.number().int().min(1).max(32).default(16),
  maxParticipants: z.number().int().min(2).max(12).default(8),
}).strict();
export type VoiceLimits = z.infer<typeof VoiceLimitsSchema>;
export const VoiceRoomSpecSchema = z.object({
  name: z.string().trim().min(1).max(80), agenda: z.string().max(2000).default(""),
  agentIds: z.array(z.string().min(1)).min(1).max(12).refine(ids => new Set(ids).size === ids.length, "Duplicate participant"),
  durationMinutes: z.number().int().min(1).max(120).default(15),
  maxUtterances: z.number().int().min(1).max(500).default(60),
}).strict();
export type VoiceRoomSpec = z.infer<typeof VoiceRoomSpecSchema>;
// Only state and bounded error metadata; no SDP, audio buffers or transcripts.
export const VoiceDiagnosticInputSchema = z.object({
  source: z.enum(["microphone", "webrtc", "provider", "meeting", "desktop", "daemon"]),
  event: z.string().min(1).max(80),
  agentId: z.string().min(1).max(200).optional(), sessionId: z.string().max(200).optional(),
  message: z.string().max(1000).optional(), code: z.string().max(100).optional(),
  connectionState: z.string().max(40).optional(), iceConnectionState: z.string().max(40).optional(),
  signalingState: z.string().max(40).optional(), channelState: z.string().max(40).optional(),
  enabled: z.boolean().optional(),
}).strict();
export type VoiceDiagnosticInput = z.infer<typeof VoiceDiagnosticInputSchema>;
export const VoiceDiagnosticSchema = VoiceDiagnosticInputSchema.extend({ at: z.number(), origin: z.enum(["desktop", "daemon"]) });
export type VoiceDiagnostic = z.infer<typeof VoiceDiagnosticSchema>;
export const VoiceRoomSchema = VoiceRoomSpecSchema.extend({
  // Removing the last participant ends a room; an ended definition can be empty.
  agentIds: z.array(z.string().min(1)).max(12).refine(ids => new Set(ids).size === ids.length, "Duplicate participant"),
  id: z.string().uuid(), revision: z.number().int(), ownerAgentId: z.string().nullable(),
  state: z.enum(["pending", "active", "ended"]), createdAt: z.number(),
  expiresAt: z.number().nullable(), reason: z.string().nullable(),
  diagnostics: z.array(VoiceDiagnosticSchema).max(50).optional(),
  pendingUpdate: VoiceRoomSpecSchema.optional(),
  participants: z.array(z.object({ agentId: z.string(), name: z.string(), role: z.string(), state: z.string() }).strict()),
}).strict().refine(room => room.state === "ended" || room.agentIds.length > 0, "Only ended rooms can have no participants");
export type VoiceRoom = z.infer<typeof VoiceRoomSchema>;
export const VoiceRoomTargetSchema = z.object({ roomId: z.string().uuid(), callerAgentId: z.string().min(1).optional() }).strict();
export const VoiceRoomLeaseSchema = z.object({ roomId: z.string().uuid(), hostId: z.string().uuid() }).strict();
export const VoiceIdentitySchema = z.object({ agentId: z.string(), name: z.string().max(200), role: z.string().max(200) }).strict();
export type VoiceIdentity = z.infer<typeof VoiceIdentitySchema>;
export type VoiceStartContext = { identity?: VoiceIdentity; meeting?: { roomId: string; name: string; agenda: string; participants: VoiceIdentity[] } };
