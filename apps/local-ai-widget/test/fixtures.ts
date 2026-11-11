import { createInitialState, getLegalMoves, type FourReversiState } from "@tetraboard/four-reversi";
import {
  gameSchema,
  type Observation,
  type AnalysisRequest,
  type AnalysisResponse,
} from "../src/model";
import { localProfile } from "../src/profiles";
export const playerId = "00000000-0000-4000-8000-000000000001";
export function observation(): Observation {
  return {
    roomId: "12345",
    instanceId: "00000000-0000-4000-8000-000000000010",
    generation: 1,
    connected: true,
    selfId: playerId,
    serverNowMs: 100,
    status: "playing",
    players: [{ id: playerId, color: "black" }],
    connectedPlayerIds: [playerId],
    game: gameSchema.parse(createInitialState("singles")),
    turnStartedAt: 100,
  };
}
export function requestFor(o = observation()): AnalysisRequest {
  const g = o.game!;
  return {
    api_version: 1,
    ruleset_version: "four-reversi-singles-v2",
    state_version: 2,
    request_id: crypto.randomUUID(),
    position_revision: "a".repeat(64),
    profile_id: "lv5-v1",
    state: {
      board: g.board,
      turn: g.turn,
      moveNumber: g.moveNumber,
      lastMove: g.lastMove,
      eliminatedColors: g.eliminatedColors,
      consecutivePasses: g.consecutivePasses,
    },
  };
}
export function responseFor(r: AnalysisRequest): AnalysisResponse {
  return {
    api_version: 1,
    request_id: r.request_id,
    position_revision: r.position_revision,
    profile_id: r.profile_id,
    profile_hash: localProfile(r.profile_id).hash,
    engine_version: "0.2.0",
    effective_limits: localProfile(r.profile_id).limits,
    reproducible: false,
    cancelled: false,
    candidates: [
      {
        position: getLegalMoves({
          ...r.state,
          mode: "singles",
          status: "playing",
          result: null,
        } as FourReversiState)[0],
        visits: 10,
        solo_wins: [2, 1, 1, 0],
      },
    ],
    diagnostics: { nodes: 100, mcts: { trials: 10, stop_reason: "node_limit" } },
  };
}
export async function settle() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}
