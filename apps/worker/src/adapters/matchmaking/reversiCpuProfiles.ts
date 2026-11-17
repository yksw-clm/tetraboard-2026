import { createReversiCpuProfiles } from "@tetraboard/context-matchmaking";
import { ratedCpuNames } from "@tetraboard/protocol";
export const { selectReversiCpu, reversiCpuProfile } = createReversiCpuProfiles(
  ratedCpuNames.reversi,
);
