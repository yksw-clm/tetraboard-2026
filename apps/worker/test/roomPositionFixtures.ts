import { runInDurableObject } from "cloudflare:test";
import { applyAction, getLegalMoves } from "@tetraboard/four-reversi";
import { applyAction as placeGomoku } from "@tetraboard/four-gomoku";
import {
  roundReplaySchema,
  fourReversiStateSchema,
  fourGomokuStateSchema,
  type FourReversiRoom,
  type FourGomokuRoom,
  type FourGomokuReplay,
} from "@tetraboard/protocol";

// 自動パスの直前、または終局2手前までの棋譜を用意します。
export async function seedFourReversiEnd(
  stub: DurableObjectStub,
  initial: FourReversiRoom,
  stopBeforePass = false,
) {
  if (initial.status !== "playing") throw Error("Not playing");
  return runInDurableObject(stub, (_, state) => {
    const room = structuredClone(initial);
    const replay = roundReplaySchema.parse(state.storage.kv.get("round-replay"));
    let previous: typeof room | null = null;
    for (let count = 0; count < 64; count++) {
      const position = getLegalMoves(room.game)[0];
      if (!position) throw Error("Missing legal move");
      const color = room.game.turn;
      const result = applyAction(room.game, { type: "placeStone", position });
      if (!result.ok) throw Error("Illegal fixture move");
      if (result.state.status === "finished") {
        if (!previous) throw Error("Missing pre-finish fixture");
        replay.steps.pop();
        state.storage.kv.put("room", previous);
        state.storage.kv.put("round-replay", replay);
        return previous;
      }
      const game = fourReversiStateSchema.parse(result.state);
      if (game.status !== "playing") throw Error("Expected playing fixture");
      if (stopBeforePass && result.passedColors.length > 0) {
        state.storage.kv.put("room", room);
        state.storage.kv.put("round-replay", replay);
        return room;
      }
      replay.steps.push({
        action: { type: "place", color, position },
        game,
        passedColors: [...result.passedColors],
      });
      previous = { ...room };
      room.game = game;
      room.positionRevision++;
    }
    throw Error("Fixture never finished");
  });
}

// 勝ち抜けまでの通信は別の統合テストで検証し、コマンド拒否用の局面だけを準備します。
export async function seedFourGomokuWinner(stub: DurableObjectStub, initial: FourGomokuRoom) {
  if (initial.status !== "playing") throw Error("Not playing");
  return runInDurableObject(stub, (_, state) => {
    const room = structuredClone(initial);
    const replay = state.storage.kv.get<FourGomokuReplay>("round-replay")!;
    const positions = Array.from({ length: 16 }, (_, index) => ({
      x: Math.floor(index / 4),
      y: (index % 4) * 2,
    }));
    positions.push({ x: 4, y: 0 });
    for (const position of positions) {
      if (room.game.status !== "playing") throw Error("Finished early");
      const color = room.game.turn;
      const result = placeGomoku(room.game, { type: "placeStone", position });
      if (!result.ok || result.state.status !== "playing") throw Error("Invalid fixture move");
      const game = fourGomokuStateSchema.parse(result.state);
      if (game.status !== "playing") throw Error("Expected playing fixture");
      replay.steps.push({ action: { type: "place", color, position }, game });
      room.game = game;
      room.positionRevision++;
    }
    state.storage.kv.put("room", room);
    state.storage.kv.put("round-replay", replay);
    return room;
  });
}
