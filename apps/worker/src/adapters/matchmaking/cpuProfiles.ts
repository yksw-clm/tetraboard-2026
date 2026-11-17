import { createNamedCpuProfiles } from "@tetraboard/context-matchmaking";
import { cpuProfileSchema } from "@tetraboard/protocol";
import characters from "../../../../../packages/ai/configs/characters-v1.json";
import registry from "../../../../../packages/ai/configs/profiles-v1.json";
export const { findNamedCpuProfile, namedCpuProfile } = createNamedCpuProfiles(
  registry,
  characters,
  cpuProfileSchema.parse,
);
