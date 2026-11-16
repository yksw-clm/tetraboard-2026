import {
  isFourReversiRoom,
  isFourShogiRoom,
  isReversiRoom,
  isShogiRoom,
} from "@tetraboard/protocol";
import { getLegalMoves as fourReversiMoves } from "@tetraboard/four-reversi";
import { getLegalMoves as reversiMoves } from "@tetraboard/reversi";
import { usiMove } from "@tetraboard/shogi/definition";
import type { PlayingFor } from "../src/rooms/gameProgress";
import type { GameId } from "@tetraboard/protocol";

export async function cpuAiReply(request: Request, room: PlayingFor<GameId>) {
  const body = await request.json<Record<string, unknown>>();
  const context = { request_id: body.request_id, position_revision: body.position_revision };
  if (isFourReversiRoom(room))
    return Response.json({
      ...context,
      api_version: 1,
      game_id: "four-reversi",
      ruleset_version: "four-reversi-singles-v1",
      state_version: 1,
      agent_id: body.agent_id,
      engine_version: "0.1.0",
      position: fourReversiMoves(room.game)[0],
      diagnostics: { nodes: 0, completed_depth: 0, interrupted: false },
    });
  if (isFourShogiRoom(room))
    return Response.json({
      ...context,
      api_version: 1,
      rules_version: 1,
      engine_version: "four-shogi-lv3-v1",
      profile_id: body.profile_id,
      max_work: body.max_work,
      max_time_ms: 500,
      diagnostics: { work: 0 },
      action: room.legalActions[0],
    });
  if (isShogiRoom(room))
    return Response.json({
      ...context,
      engine_version: "yaneuraou-material-faeb37f0",
      nodes: body.nodes,
      best_move: usiMove(room.legalActions[0]!),
    });
  if (!isReversiRoom(room)) throw Error("Expected external AI game");
  return Response.json({
    ...context,
    engine_version: "egaroucid-console-7.8.2-0c1b84ef",
    level: body.level,
    position: reversiMoves(room.game)[0],
  });
}
