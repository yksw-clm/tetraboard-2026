import type { FinishedFor } from "../rooms/gameProgress";
import type { Room, GameId } from "@tetraboard/protocol";

/** 終局直前の確定状態から、対局全体と各席の理由だけを取り出します。 */
export function matchEndFacts(room: Room, game: FinishedFor<GameId>) {
  const result = game.result;
  const eliminations = game && "eliminations" in game ? game.eliminations : room.eliminations;
  const standings = result && "standings" in result ? result.standings : [];
  return {
    reason: result?.reason ?? "unknown",
    players: new Map(
      room.players.map((p) => {
        const seat = "side" in p ? p.side : p.color;
        const elimination = eliminations.find((e) => ("side" in e ? e.side : e.color) === seat);
        const standing = standings.find((s) => ("side" in s ? s.side : s.color) === seat);
        return [
          p.id,
          elimination?.reason ?? (standing && "reason" in standing ? standing.reason : "completed"),
        ];
      }),
    ),
  };
}
