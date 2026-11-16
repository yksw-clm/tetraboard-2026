import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { registrationForPlayer } from "../../flows/guestRegistration/records";
import { tournamentReservation } from "../../flows/tournamentRoom/reservations";
import type { MatchmakingRoomReservation } from "../../matchmaking/coordinator";
import { nextRoomAlarmAt } from "../../rooms/roomAlarm";
import { readRoom } from "./state";

export function nextAlarmAt(runtime: RoomRuntime): number | null {
  const room = readRoom(runtime);
  const cpu = room ? runtime.gameAdapter(room).cpu : null;
  return nextRoomAlarmAt({
    room,
    registrations: new Map(
      (room?.players ?? []).flatMap((player) => {
        const registration = registrationForPlayer(runtime, player.id);
        return registration ? [[player.id, registration] as const] : [];
      }),
    ),
    usesIdleDeadline: !!room && !!cpu?.usesIdleDeadline(room),
    cpuAlarmAt:
      room?.status === "playing" && cpu && cpu.currentCpu(room) !== null ? cpu.alarmAt(room) : null,
    jobs: [
      runtime.jobs.cpuCapacityJob,
      runtime.jobs.roomIndexJob,
      runtime.jobs.accountCleanupJob,
      runtime.jobs.matchJob,
      runtime.jobs.shogiMatchJob,
      runtime.jobs.guestClaimsJob,
      runtime.jobs.tournamentStateJob,
    ].map((job) => job.nextAlarmAt()),
    tournament: tournamentReservation(runtime, room),
    matchmaking:
      room && "matchmaking" in room && room.matchmaking
        ? runtime.ctx.storage.kv.get<MatchmakingRoomReservation>(
            `matchmaking:${room.matchmaking.id}`,
          )
        : undefined,
  });
}
