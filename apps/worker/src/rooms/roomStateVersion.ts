import { roomSchema, type Room } from "@tetraboard/protocol";
import { normalizeLegacyShogiState } from "./normalizeLegacyShogiState";
import { normalizeLegacyReversiState } from "./normalizeLegacyReversiState";

export const roomStateVersionKey = "room-state-version";
export const currentRoomStateVersion = 1;

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
