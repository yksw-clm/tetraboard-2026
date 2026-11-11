import {
  createInitialState as createShogiInitialState,
  getLegalActions as getShogiLegalActions,
} from "@tetraboard/four-shogi";
import { fourShogiPublicStateSchema } from "@tetraboard/protocol";
import { continuousProfile, sides } from "../src/model";
import { createInitialState, getLegalMoves, type FourReversiState } from "@tetraboard/four-reversi";
import {
  gameSchema,
  type ReversiObservation,
  type AnalysisRequest,
  type AnalysisResponse,
} from "../src/model";
import { localProfile } from "../src/profiles";
export const playerId = "00000000-0000-4000-8000-000000000001";
export function observation(): ReversiObservation {
  return {
    gameId: "four-reversi",
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

export function continuousRequestFor(): import("../src/model").ContinuousRequest {
  const r = requestFor();
  return {
    api_version: 2,
    request_id: r.request_id,
    position_revision: r.position_revision,
    profile_hash: continuousProfile("four-reversi").hash,
    input: { game: "four-reversi", state: r.state },
  };
}
export function progressFor(
  request: import("../src/model").ContinuousRequest,
  sequence = 1,
): import("../src/model").ContinuousResponse {
  const profile = continuousProfile(request.input.game);
  const base = {
    api_version: 2 as const,
    request_id: request.request_id,
    position_revision: request.position_revision,
    profile_id: profile.id,
    profile_hash: profile.hash,
    status: "running" as const,
    sequence,
    reproducible: false as const,
  };
  if (request.input.game === "four-reversi") {
    const position = getLegalMoves({
      ...request.input.state,
      mode: "singles",
      status: "playing",
      result: null,
    } as FourReversiState)[0];
    return {
      ...base,
      game: "four-reversi",
      candidates: [
        { position, visits: sequence * 10, solo_wins: [sequence * 2, sequence, sequence, 0] },
      ],
      diagnostics: { nodes: sequence * 100, trials: sequence * 10, tree_nodes: sequence + 1 },
    };
  }
  return {
    ...base,
    game: "four-shogi",
    candidates: [{ action: shogiObservation().legalActions[0], score: 100 }],
    diagnostics: { nodes: sequence * 100, completed_depth: sequence },
  };
}
export function shogiObservation(): import("../src/model").ShogiObservation {
  const ids = [1, 2, 3, 4].map((i) => `00000000-0000-4000-8000-00000000000${i}`);
  const state = createShogiInitialState({
    mode: "singles",
    players: { south: ids[0], west: ids[1], north: ids[2], east: ids[3] },
    threePlayerAttackProhibited: true,
  });
  const { repetitions: _repetitions, ...game } = state;
  return {
    ...observation(),
    gameId: "four-shogi",
    game: fourShogiPublicStateSchema.parse(game),
    players: sides.map((side, i) => ({ id: ids[i], side })),
    roundId: "00000000-0000-4000-8000-000000000020",
    positionRevision: 0,
    legalActions: getShogiLegalActions(state),
  };
}
