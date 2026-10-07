import { expect, test } from "bun:test";
import { type Color } from "@tetraboard/four-reversi";
import { fourReversiRoomSchema } from "@tetraboard/protocol";
import { playingRoom, waitingRoom } from "./fixtures/rooms";
import { replayMatch } from "./fixtures/matchReplayFixtures";
import { rotatedSeatIndex } from "../src/features/room/boardRotation";
import {
  fourReversiRoomSeats,
  matchSeats,
  orderedSeats,
} from "../src/features/room/roomPresentation";

const clockwise: Record<Color, Color[]> = {
  black: ["black", "white", "red", "blue"],
  white: ["white", "red", "blue", "black"],
  red: ["red", "blue", "black", "white"],
  blue: ["blue", "black", "white", "red"],
};
function permutations(values: Color[]): Color[][] {
  return values.length === 0
    ? [[]]
    : values.flatMap((value, index) =>
        permutations(values.filter((_, i) => i !== index)).map((rest) => [value, ...rest]),
      );
}
function expectClockwiseAfterRotation(seats: { color: Color }[]) {
  for (const rotation of [0, 1, 2, 3] as const) {
    const displayed = seats
      .map((player, index) => ({ player, position: rotatedSeatIndex(index, rotation) }))
      .sort((a, b) => a.position - b.position)
      .map(({ player }) => player.color);
    expect(displayed).toEqual(clockwise[displayed[0]]);
  }
}

for (const mode of ["singles", "doubles"] as const) {
  test(`${mode}: 全24配色で観戦は黒、本人は自色を手前にし、回転・脱落でも色順を保つ`, () => {
    const assignments = permutations(clockwise.black);
    expect(assignments).toHaveLength(24);
    for (const assignment of assignments) {
      const room = playingRoom();
      if (room.status !== "playing") throw new Error("Expected playing room");
      room.settings.mode = mode;
      room.game.mode = mode;
      room.players = room.players.map((player, index) => ({ ...player, color: assignment[index] }));
      room.game.eliminatedColors = mode === "singles" ? ["red"] : [];
      const before = structuredClone(room);
      for (const selfId of [undefined, "absent-player", ...room.players.map((p) => p.id)]) {
        const seats = fourReversiRoomSeats(room, selfId);
        const anchor = room.players.find((p) => p.id === selfId)?.color ?? "black";
        expect(seats.map((p) => p?.color)).toEqual(clockwise[anchor]);
        expect(seats).toHaveLength(4);
        expectClockwiseAfterRotation(seats as { color: Color }[]);
        for (const player of room.players) expect(seats).toContain(player);
      }
      expect(room).toEqual(before);
    }
  });

  test(`${mode}: 保存済みの席番号・配列順に依存せず全24配色と本人4色を表示する`, () => {
    for (const assignment of permutations(clockwise.black)) {
      const match = replayMatch(mode);
      match.participants = match.participants
        .map((player, index) => ({ ...player, color: assignment[index] }))
        .reverse();
      const before = structuredClone(match.participants);
      for (const player of match.participants) {
        match.selfPlayerId = player.id;
        const seats = matchSeats(match);
        expect(seats[0]).toBe(player);
        expect(seats.map((p) => p.color)).toEqual(clockwise[player.color]);
        expectClockwiseAfterRotation(seats);
        expect(seats.find((p) => p.seat === 0)).toBe(match.participants.find((p) => p.seat === 0)!);
      }
      expect(match.participants).toEqual(before);
    }
  });
}

test("初回・再戦待機は現在の入室順・空席・本人基準を維持し、再抽選後は新しい色順を使う", () => {
  const waiting = waitingRoom();
  const match = replayMatch();
  waiting.players.splice(1, 1);
  waiting.players[0].ready = true;
  const rematch = fourReversiRoomSchema.parse({
    ...waiting,
    lastRound: {
      game: match.game,
      players: match.participants.map(({ id, name, color }) => ({ id, name, color })),
      replay: match.replay,
    },
  });
  for (const room of [waiting, rematch]) {
    for (const self of [undefined, room.players[1].id]) {
      expect(fourReversiRoomSeats(room, self)).toEqual(orderedSeats(room, self));
      expect(fourReversiRoomSeats(room, self).at(-1 - (self ? 1 : 0))).toBeNull();
    }
  }
  const started = playingRoom();
  if (started.status !== "playing") throw new Error("Expected playing room");
  const blackId = fourReversiRoomSeats(started, undefined)[0]!.id;
  started.players = started.players.map((p, i) => ({ ...p, color: clockwise.blue[i] }));
  expect(fourReversiRoomSeats(started, undefined).map((p) => p?.color)).toEqual(clockwise.black);
  expect(fourReversiRoomSeats(started, undefined)[0]!.id).not.toBe(blackId);
});
