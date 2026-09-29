import { z } from "zod";

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

const nicknameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((name) => Array.from(segmenter.segment(name)).length <= 10);

const playerNameRequestSchema = z.strictObject({ name: nicknameSchema });

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
  error: z.enum([
    "invalid_request",
    "not_found",
    "code_unavailable",
    "room_full",
    "upgrade_required",
    "internal_error",
  ]),
});

export const createRoomContract = {
  method: "POST",
  path: "/rooms",
  request: playerNameRequestSchema,
  response: roomSchema,
  error: roomErrorSchema,
} as const;

export const joinRoomContract = {
  method: "POST",
  path: "/rooms/:id/players",
  pathFor: (id: string) => `/rooms/${id}/players`,
  request: playerNameRequestSchema,
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

export const roomSocketContract = {
  method: "GET",
  path: "/rooms/:id/ws",
  pathFor: (id: string) => `/rooms/${id}/ws`,
  message: z.strictObject({
    type: z.literal("room.snapshot"),
    room: roomSchema,
  }),
  error: roomErrorSchema,
} as const;

export type CreateRoomRequest = z.infer<typeof createRoomContract.request>;
export type JoinRoomRequest = z.infer<typeof joinRoomContract.request>;
export type Room = z.infer<typeof roomSchema>;
export type RoomError = z.infer<typeof roomErrorSchema>;
export type RoomSocketMessage = z.infer<typeof roomSocketContract.message>;
