import { z } from "zod";

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

const nicknameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((name) => Array.from(segmenter.segment(name)).length <= 10);

export const roomCodeSchema = z.string().regex(/^\d{5}$/);

export const roomSchema = z.strictObject({
  id: roomCodeSchema,
  status: z.literal("waiting"),
  players: z.array(
    z.strictObject({
      id: z.uuid(),
      name: nicknameSchema,
    }),
  ),
});

const roomErrorSchema = z.strictObject({
  error: z.enum(["invalid_request", "not_found", "code_unavailable", "internal_error"]),
});

export const createRoomContract = {
  method: "POST",
  path: "/rooms",
  request: z.strictObject({ name: nicknameSchema }),
  response: roomSchema,
  error: roomErrorSchema,
} as const;

export const getRoomContract = {
  method: "GET",
  path: "/rooms/:id",
  pathFor: (id: string) => `/rooms/${id}`,
  response: roomSchema,
  error: roomErrorSchema,
} as const;

export type CreateRoomRequest = z.infer<typeof createRoomContract.request>;
export type Room = z.infer<typeof roomSchema>;
export type RoomError = z.infer<typeof roomErrorSchema>;
