import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { createAccountCleanupJob } from "./accountCleanupJob";
import { createCpuCapacityJob } from "./cpuCapacityJob";
import { createGuestClaimsJob } from "./guestClaimsJob";
import { createRoomIndexJob } from "./indexJob";
import { createMatchJob } from "./matchJob";
import { createShogiMatchJob } from "./shogiMatchJob";
import { createTournamentStateJob } from "./tournamentStateJob";

export type RoomJobs = {
  readonly roomIndexJob: ReturnType<typeof createRoomIndexJob>;
  readonly accountCleanupJob: ReturnType<typeof createAccountCleanupJob>;
  readonly tournamentStateJob: ReturnType<typeof createTournamentStateJob>;
  readonly cpuCapacityJob: ReturnType<typeof createCpuCapacityJob>;
  readonly matchJob: ReturnType<typeof createMatchJob>;
  readonly shogiMatchJob: ReturnType<typeof createShogiMatchJob>;
  readonly guestClaimsJob: ReturnType<typeof createGuestClaimsJob>;
};

export function createRoomJobs(runtime: RoomRuntime): RoomJobs {
  return {
    roomIndexJob: createRoomIndexJob(runtime),
    accountCleanupJob: createAccountCleanupJob(runtime),
    tournamentStateJob: createTournamentStateJob(runtime),
    cpuCapacityJob: createCpuCapacityJob(runtime),
    matchJob: createMatchJob(runtime),
    shogiMatchJob: createShogiMatchJob(runtime),
    guestClaimsJob: createGuestClaimsJob(runtime),
  };
}
