import type { TournamentQueueRuntime } from "@tetraboard/context-tournament";
import { tournamentRules, accountAvatarPresetId } from "@tetraboard/protocol";
import { avatarKeyPattern } from "../../accounts/auth";
import { releaseReservation } from "../room/seatReservations";
import { reserveMatchSequence } from "../../rooms/matchSequences";
import { finalizeTournament, settingsForTournament, readTournament } from "./store";
import { D1TournamentEntries } from "./entries";
import { D1TournamentQueueStore } from "./queue";
import { DurableTournamentStorage } from "./storage";
import { tournamentCredential } from "./credentials";
export function createTournamentRuntime(ctx: DurableObjectState, env: Env): TournamentQueueRuntime {
  return {
    storage: new DurableTournamentStorage(ctx.storage),
    store: new D1TournamentQueueStore(env.APP_DB),
    read: (key) => readTournament(env.APP_DB, key),
    eligible: (accountId, key) => new D1TournamentEntries(env.APP_DB).eligible(accountId, key),
    finalize: (key) => finalizeTournament(env.APP_DB, key),
    settings: settingsForTournament,
    credential: (input) => tournamentCredential(env, input),
    avatar: (profile) => ({
      avatarKey:
        profile.avatarKey && avatarKeyPattern.test(profile.avatarKey) ? profile.avatarKey : null,
      avatarPresetId: accountAvatarPresetId(profile.id, profile.avatarPresetId),
    }),
    releaseReservation: (admission) => releaseReservation(env, admission, true),
    reserveMatchSequence: (id, scope) => reserveMatchSequence(env.APP_DB, id, scope),
    refresh: (key) => env.TOURNAMENT_COORDINATOR.getByName(key).refresh(key),
    room: (roomId) => env.GAME_ROOM.getByName(roomId),
    rules: tournamentRules,
    now: Date.now,
    randomId: () => crypto.randomUUID(),
    randomRoomId: () =>
      String(crypto.getRandomValues(new Uint32Array(1))[0]! % 100000).padStart(5, "0"),
    random: (bound) => crypto.getRandomValues(new Uint32Array(1))[0]! % bound,
  };
}
