import { fourReversiDefinition } from "@tetraboard/four-reversi/definition";
import type { ExternalCpuWork } from "../../../rooms/fourReversiCpu";
import { profileMetadata } from "./aiServiceProfiles";

export function createFourReversiAiRequest(work: ExternalCpuWork, revision: string) {
  const selectedProfile = work.job.serviceProfile;
  if (selectedProfile && "configuration_error" in selectedProfile)
    throw new Error("Invalid AI service profile");
  const request = fourReversiDefinition.cpu.external!.createRequest(
    work.game,
    work.job.color,
    work.job.level,
    { extendedRules: work.job.extendedRules },
  );
  const agentId = selectedProfile
    ? profileMetadata(selectedProfile.profile_id).config.agent_id
    : request.agent_id;
  const { agent_id: _agentId, ...gameRequest } = request;
  return {
    agentId,
    rulesetVersion: request.ruleset_version,
    stateVersion: request.state_version,
    body: JSON.stringify({
      api_version: selectedProfile ? 2 : 1,
      ...gameRequest,
      request_id: work.job.requestId,
      position_revision: revision,
      ...(selectedProfile
        ? {
            profile_id: selectedProfile.profile_id,
            ...(selectedProfile.limits ? { limits: selectedProfile.limits } : {}),
          }
        : { agent_id: agentId }),
      seed: Number.parseInt(revision.slice(0, 8), 16),
    }),
  };
}
