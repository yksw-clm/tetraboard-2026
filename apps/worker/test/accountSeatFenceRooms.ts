import { runInDurableObject } from "cloudflare:test";
import { createRoomAlarms, createRoomRuntime } from "../src/durableObjects/gameRoom/createRuntime";
import type { RoomRuntime } from "../src/durableObjects/gameRoom/runtime";
import { prepareMatchmakingRoom } from "../src/flows/matchmakingRoom/prepare";
import { abortMatchmakingRoom } from "../src/flows/matchmakingRoom/reservations";
import { prepareTournamentRoom } from "../src/flows/tournamentRoom/prepare";
import { abortTournamentRoom } from "../src/flows/tournamentRoom/reservations";
import type { MatchmakingRuntime } from "@tetraboard/context-matchmaking";
import type { TournamentQueueRuntime } from "@tetraboard/context-tournament";

function inRoom<T>(env: Env, id: string, action: (r: RoomRuntime) => Promise<T>) {
  return runInDurableObject(env.GAME_ROOM.getByName(id), async (instance, ctx) => {
    const runtime: RoomRuntime = createRoomRuntime(
      ctx,
      () => env,
      createRoomAlarms(instance, ctx, () => runtime),
    );
    return action(runtime);
  });
}
export const matchmakingFenceRoom =
  (env: Env): MatchmakingRuntime["room"] =>
  (id) => {
    const stub = env.GAME_ROOM.getByName(id);
    return {
      prepareMatchmakingRoom: (input) => inRoom(env, id, (r) => prepareMatchmakingRoom(r, input)),
      abortMatchmakingRoom: (match, instance) =>
        inRoom(env, id, (r) => abortMatchmakingRoom(r, match, instance)),
      rekeyMatchmakingPlayer: (...args) => stub.rekeyMatchmakingPlayer(...args),
      getMatchmakingState: (...args) => stub.getMatchmakingState(...args),
    };
  };
export const tournamentFenceRoom =
  (env: Env): TournamentQueueRuntime["room"] =>
  (id) => {
    const stub = env.GAME_ROOM.getByName(id);
    return {
      prepareTournamentRoom: (input) => inRoom(env, id, (r) => prepareTournamentRoom(r, input)),
      abortTournamentRoom: (match, excluded) =>
        inRoom(env, id, (r) => abortTournamentRoom(r, match, excluded)),
      getTournamentReservationState: (...args) => stub.getTournamentReservationState(...args),
      rekeyTournamentPlayer: (...args) => stub.rekeyTournamentPlayer(...args),
    };
  };
