import type { CpuProfile } from "@tetraboard/protocol";
export function createNamedCpuProfiles(
  registry: { profiles: { id: string; profile_hash: string; config: { agent_id: string } }[] },
  characters: {
    engine_version: string;
    ruleset_version: string;
    state_version: number;
    characters: { profile_id: string; level: number; name: string; style: string }[];
  },
  parse: (input: unknown) => CpuProfile,
) {
  function findNamedCpuProfile(id: string): CpuProfile | undefined {
    const profile = registry.profiles.find((p) => p.id === id);
    const character = characters.characters.find((c) => c.profile_id === id);
    if (!profile || !character) return;
    return parse({
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

  function namedCpuProfile(id: string): CpuProfile {
    const profile = findNamedCpuProfile(id);
    if (!profile) throw Error("CPU profileが不明です");
    return profile;
  }

  return { findNamedCpuProfile, namedCpuProfile };
}
