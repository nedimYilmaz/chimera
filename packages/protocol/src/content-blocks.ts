import { z } from "zod";

export const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1) }).strict(),
  z.object({
    type: z.literal("image"),
    mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    data: z.string().min(1),
  }).strict(),
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
