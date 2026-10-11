import { expect, test } from "bun:test";
import { publicGomokuMatchDetailSchema, roomSocketContract } from "@tetraboard/protocol";
import on from "../../../test-fixtures/matches/gomoku-on-five.json";
import off from "../../../test-fixtures/matches/gomoku-off-overline.json";
import { gomokuReplayFrames } from "../src/features/room/gomokuReplay";

for (const [fixture, enabled, moves, lineLength] of [
  [on, true, 9, 5],
  [off, false, 11, 6],
] as const) {
  test(`固定棋譜の禁手${enabled ? "ON" : "OFF"}を初期・途中・終局まで再現する`, () => {
    const match = publicGomokuMatchDetailSchema.parse(fixture.detail);
    const before = JSON.stringify(match);
    const frames = gomokuReplayFrames({ ...match, players: match.participants });
    expect(frames).toHaveLength(moves + 1);
    expect(frames[0]).toMatchObject({
      label: "開始局面",
      game: { moveNumber: 0, forbiddenRules: enabled },
    });
    expect(frames[1]).toMatchObject({
      label: "1: 黒 A8",
      game: { lastMove: { x: 0, y: 7 }, result: null },
    });
    expect(frames[2].label).toBe("2: 白 A1");
    expect(frames.at(-1)?.game).toEqual(match.game);
    expect(match.game.result.winningLines[0]).toHaveLength(lineLength);
    expect(match.game.result.winner).toBe("black");
    expect(JSON.stringify(match)).toBe(before);
  });
}
for (const corruption of [
  "initial",
  "turn",
  "snapshot",
  "final",
  "rulesVersion",
  "settings",
] as const) {
  test(`五目並べの${corruption}が破損した棋譜は再生しない`, () => {
    const match = publicGomokuMatchDetailSchema.parse(off.detail);
    if (corruption === "initial") match.replay.initial.board[0][0] = "black";
    if (corruption === "turn") match.replay.steps[0].action.color = "white";
    if (corruption === "snapshot") match.replay.steps[1].game.moveNumber++;
    if (corruption === "final") match.game.moveNumber++;
    if (corruption === "settings") match.settings.forbiddenRules = true;
    if (corruption === "rulesVersion") Object.assign(match.replay.initial, { rulesVersion: 2 });
    expect(() => {
      const parsed = publicGomokuMatchDetailSchema.parse(match);
      gomokuReplayFrames({ ...parsed, players: parsed.participants });
    }).toThrow();
  });
}
test("15路の通信は局IDと更新番号を必須とし、既存8路の通信境界を維持する", () => {
  const command = {
    type: "room.game.action",
    roundId: on.detail.id,
    positionRevision: 0,
    action: { type: "placeGomokuStone", position: { x: 14, y: 14 } },
  };
  const parse = (value: unknown) => roomSocketContract.clientMessage.safeParse(value).success;
  expect(parse(command)).toBe(true);
  for (const x of [-1, 15, 1.5])
    expect(parse({ ...command, action: { ...command.action, position: { x, y: 0 } } })).toBe(false);
  expect(parse({ ...command, roundId: undefined })).toBe(false);
  expect(parse({ ...command, positionRevision: undefined })).toBe(false);
  expect(
    parse({ type: "room.game.action", action: { type: "placeStone", position: { x: 7, y: 7 } } }),
  ).toBe(true);
  expect(
    parse({ type: "room.game.action", action: { type: "placeStone", position: { x: 8, y: 7 } } }),
  ).toBe(false);
});
