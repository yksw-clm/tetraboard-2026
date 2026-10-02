import { expect, test } from "bun:test";
import { fourReversiMatchDetailSchema } from "@tetraboard/protocol";
import { replayMatch } from "../browser-tests/matchReplayFixtures";
import { matchSeats, replayPlayerDetails } from "../src/features/room/roomPresentation";
import { replayFrames } from "../src/features/room/replayFrames";

for (const mode of ["singles", "doubles"] as const) {
  test(`${mode}の本人を手前に配置し、選択局面の石数・脱落だけを表示する`, () => {
    const match = fourReversiMatchDetailSchema.parse(replayMatch(mode));
    expect(matchSeats(match).map((p) => p.seat)).toEqual([1, 2, 3, 0]);
    const frames = replayFrames({ ...match, players: match.participants });
    expect(replayPlayerDetails(frames[0].game, "white", match.eliminations)).toEqual({
      count: 2,
      rank: null,
    });
    expect(replayPlayerDetails(frames[1].game, "black", match.eliminations)).toMatchObject({
      count: 4,
      rank: null,
    });
    expect(replayPlayerDetails(frames[2].game, "white", match.eliminations)).toEqual({
      count: null,
      rank: {
        rank: 4,
        label: mode === "singles" ? "4位（時間切れ）" : "脱落（退室）",
      },
    });
    expect(frames.at(-1)?.game).toEqual(match.game);
    expect(frames[0].game.lastMove).toBeNull();
    expect(
      frames.slice(1).every((frame) => frame.game.lastMove?.x === 2 && frame.game.lastMove.y === 3),
    ).toBe(true);
  });
  test(`${mode}の通常終局の棋譜が保存結果と一致する`, () => {
    const match = replayMatch(mode, true);
    const frames = replayFrames({ ...match, players: match.participants });
    expect(frames.at(-1)?.game).toEqual(match.game);
    expect(frames.some((frame) => frame.label.endsWith("パス"))).toBe(true);
    if (mode === "singles")
      expect(replayPlayerDetails(match.game, "black", []).rank).not.toBeNull();
  });
}
