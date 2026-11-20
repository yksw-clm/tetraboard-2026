import type { StoredProfile } from "../adapters/account/auth";
import type { TournamentRow } from "../adapters/tournament/store";
import { readLimitedBody } from "./readLimitedBody";

export type TournamentRouteEnv = { Bindings: Env; Variables: TournamentRouteVariables };

type TournamentRouteVariables = {
  tournament: TournamentRow;
  user: StoredProfile;
  readTournamentInChatBatch?: boolean;
};

export async function readTournamentJson(request: Request) {
  const bytes = await readLimitedBody(request, 32768);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}
