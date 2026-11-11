import { cpuProfileSchema, type CpuProfile } from "@tetraboard/protocol";
import characters from "../../../../packages/ai/configs/characters-v1.json";
import registry from "../../../../packages/ai/configs/profiles-v1.json";

export function findNamedCpuProfile(id: string): CpuProfile | undefined {
  const profile = registry.profiles.find((p) => p.id === id);
  const character = characters.characters.find((c) => c.profile_id === id);
  if (!profile || !character) return;
  return cpuProfileSchema.parse({
    id,
    engineVersion: characters.engine_version,
    rulesetVersion: characters.ruleset_version,
    stateVersion: characters.state_version,
    hash: profile.profile_hash,
    agentId: profile.config.agent_id,
    level: character.level,
    name: character.name,
    style: character.style,
  });
}

export function namedCpuProfile(id: string): CpuProfile {
  const profile = findNamedCpuProfile(id);
  if (!profile) throw Error("CPU profileが不明です");
  return profile;
}
