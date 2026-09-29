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
      ready: z.boolean().default(false),
    }),
  ),
});

export const membershipTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const roomMembershipSchema = z.strictObject({
  playerId: z.uuid(),
  role: z.enum(["host", "player"]),
});

const roomMembershipIssuedSchema = z.strictObject({
  playerId: z.uuid(),
  role: z.enum(["host", "player"]),
  token: membershipTokenSchema,
});

const roomEntryResponseSchema = z.strictObject({
  room: roomSchema,
  membership: roomMembershipIssuedSchema,
});

const roomErrorSchema = z.strictObject({
  error: z.enum([
    "invalid_request",
    "not_found",
    "code_unavailable",
    "room_full",
    "unauthorized",
    "upgrade_required",
    "internal_error",
  ]),
});

export const createRoomContract = {
  method: "POST",
  path: "/rooms",
  request: playerNameRequestSchema,
  response: roomEntryResponseSchema,
  error: roomErrorSchema,
} as const;

export const joinRoomContract = {
  method: "POST",
  path: "/rooms/:id/players",
  pathFor: (id: string) => `/rooms/${id}/players`,
  request: playerNameRequestSchema,
  response: roomEntryResponseSchema,
  error: roomErrorSchema,
} as const;

export const getRoomMembershipContract = {
  method: "GET",
  path: "/rooms/:id/me",
  pathFor: (id: string) => `/rooms/${id}/me`,
  request: z.strictObject({ token: membershipTokenSchema }),
  response: roomMembershipSchema,
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
  clientMessage: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("room.auth"), token: membershipTokenSchema }),
    z.strictObject({ type: z.literal("room.ready.set"), ready: z.boolean() }),
  ]),
  message: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("room.snapshot"), room: roomSchema }),
    z.strictObject({ type: z.literal("room.authenticated"), membership: roomMembershipSchema }),
    z.strictObject({
      type: z.literal("room.error"),
      error: z.enum(["invalid_request", "unauthorized", "not_found", "internal_error"]),
    }),
  ]),
  error: roomErrorSchema,
} as const;

export type CreateRoomRequest = z.infer<typeof createRoomContract.request>;
export type JoinRoomRequest = z.infer<typeof joinRoomContract.request>;
export type Room = z.infer<typeof roomSchema>;
export type RoomError = z.infer<typeof roomErrorSchema>;
export type RoomMembership = z.infer<typeof roomMembershipSchema>;
export type RoomSocketClientMessage = z.infer<typeof roomSocketContract.clientMessage>;
export type RoomSocketMessage = z.infer<typeof roomSocketContract.message>;
