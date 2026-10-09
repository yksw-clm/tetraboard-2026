import { expect, test } from "bun:test";
import { applyAction } from "@tetraboard/reversi";
import { publicReversiMatchDetailSchema } from "@tetraboard/protocol";
import archive from "../../../test-fixtures/matches/reversi-standard-draw.json";
import { reversiReplayFrames } from "../src/features/room/reversiReplay";
import { renderPublicLobby } from "../build/renderPublicLobby";
test("固定棋譜の全着手・自動パス・最終引き分けが将来のエンジンでも再現できる", () => {
  const match = publicReversiMatchDetailSchema.parse(archive.detail);
  let game = match.replay.initial;
  for (const step of match.replay.steps) {
    if (step.action.type !== "place") throw Error("Unexpected fixture action");
    expect(game.turn).toBe(step.action.color);
    const result = applyAction(game, { type: "placeStone", position: step.action.position });
    if (!result.ok) throw Error("Rejected fixed move");
    expect(result.state).toEqual(step.game);
    expect(result.passedColors).toEqual(step.passedColors);
    if (result.state.status === "playing") game = result.state;
  }
  const frames = reversiReplayFrames({
    game: match.game,
    players: match.participants,
    replay: match.replay,
  });
  expect(frames).toHaveLength(1 + archive.expected.moveNumber + archive.expected.passCount);
  expect(frames.at(-1)?.game).toEqual(match.game);
  expect(match.game.result).toMatchObject({
    winner: archive.expected.winner,
    stoneCounts: archive.expected.stoneCounts,
  });
});
test("通常リバーシの初期HTMLはCPU1人と2人ルール、検索メタ情報と3ゲームのリンクを持つ", () => {
  const template =
    '<html><head><title>TetraBoard</title></head><body><div id="root"></div></body></html>';
  const html = renderPublicLobby(template, "reversi");
  expect(html).toContain("リバーシをブラウザでオンライン対戦");
  expect(html).toContain("https://tetraboard.net/games/reversi");
  expect(html).toContain("CPU1人との待機室");
  expect(html).toContain('href="/games/reversi"');
  expect(html).not.toContain("シングルス");
  expect(html).toContain("人間とCPUで2席を埋め");
  expect(html).not.toContain("4席");
  expect(html).not.toContain("全滅手は禁止");
  expect(html).toContain("game-theme-reversi");
});
