import { fourReversiRoomSchema, roomSchema, type Room } from "@tetraboard/protocol";
import { z } from "zod";
import { normalizeLegacyShogiState } from "./normalizeLegacyShogiState";
import { normalizeLegacyReversiState } from "./normalizeLegacyReversiState";

export const roomStateVersionKey = "room-state-version";
export const currentRoomStateVersion = 1;
export const fourReversiPositionRoomStateVersion = 2;

const roomStateV2Schema = z.union([
  roomSchema,
  z
    .discriminatedUnion("status", [
      z.looseObject({
        status: z.literal("waiting"),
        roundId: z.null().optional(),
        positionRevision: z.literal(0).optional(),
      }),
      z.looseObject({
        status: z.literal("playing"),
        roundId: z.uuid().optional(),
        positionRevision: z.int().nonnegative().optional(),
      }),
    ])
    .transform(({ roundId: _roundId, positionRevision: _positionRevision, ...room }) => room)
    .pipe(fourReversiRoomSchema),
]);

export function roomStateSchemaForVersion(version: number) {
  return version === fourReversiPositionRoomStateVersion ? roomStateV2Schema : roomSchema;
}

export interface RoomStateMigrationDependencies {
  readReplay: () => unknown;
  migrateLegacy: (room: Room, saved: object, readReplay: () => unknown) => void;
}

export function migrateRoomStateV0ToV1(
  saved: unknown,
  dependencies: RoomStateMigrationDependencies,
): ReturnType<typeof roomSchema.safeParse> {
  const parsed = roomSchema.safeParse(
    normalizeLegacyReversiState(
      normalizeLegacyShogiState(saved),
      () => (dependencies.readReplay() as { id: string } | undefined)?.id,
    ),
  );
  if (parsed.success)
    dependencies.migrateLegacy(parsed.data, saved as object, dependencies.readReplay);
  return parsed;
}
