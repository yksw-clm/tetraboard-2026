import { roomSchema, type Room } from "@tetraboard/protocol";
import { normalizeLegacyShogiState } from "./normalizeLegacyShogiState";
import { normalizeLegacyReversiState } from "./normalizeLegacyReversiState";

export const roomStateVersionKey = "room-state-version";
export const currentRoomStateVersion = 2;

export interface RoomStateMigrationDependencies {
  readReplay: () => unknown;
  migrateLegacy: (room: Room, saved: object, readReplay: () => unknown) => void;
}

function withFourReversiPosition(saved: unknown): unknown {
  if (!saved || typeof saved !== "object" || !("settings" in saved)) return saved;
  const { settings } = saved;
  if (
    !settings ||
    typeof settings !== "object" ||
    !("game" in settings) ||
    settings.game !== "four-reversi" ||
    !("status" in saved)
  )
    return saved;
  if (saved.status !== "waiting" && saved.status !== "playing") return saved;
  if ("roundId" in saved && "positionRevision" in saved) return saved;
  if (saved.status === "waiting") return { roundId: null, positionRevision: 0, ...saved };
  // 切り戻し後の再移行でも、以前の局面に送られた着手と照合が一致しないようにします。
  return {
    ...saved,
    roundId: crypto.randomUUID(),
    positionRevision: 0,
  };
}

export function migrateRoomState(
  saved: unknown,
  version: number,
  dependencies: RoomStateMigrationDependencies,
): ReturnType<typeof roomSchema.safeParse> {
  const readReplayId = () => (dependencies.readReplay() as { id: string } | undefined)?.id;
  const withPosition = withFourReversiPosition(saved);
  const parsed = roomSchema.safeParse(
    version === 0
      ? normalizeLegacyReversiState(normalizeLegacyShogiState(withPosition), readReplayId)
      : withPosition,
  );
  if (parsed.success && version === 0)
    dependencies.migrateLegacy(parsed.data, saved as object, dependencies.readReplay);
  return parsed;
}
