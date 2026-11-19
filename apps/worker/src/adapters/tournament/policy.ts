import {
  getTournamentSettings,
  tournamentSettingsSchema,
  tournamentRules,
} from "@tetraboard/protocol";
import type { TournamentPolicy } from "@tetraboard/context-tournament";
import { accountAvatarUrl } from "../../adapters/account/auth";
export const tournamentPolicy: TournamentPolicy = {
  settings: getTournamentSettings,
  parseSettings: (value) => tournamentSettingsSchema.parse(value),
  pointsUnits: tournamentRules.pointsUnits,
  avatarUrl: (row) =>
    accountAvatarUrl({
      id: row.accountId!,
      avatarKey: row.avatarKey,
      avatarPresetId: row.avatarPresetId,
    }),
};
