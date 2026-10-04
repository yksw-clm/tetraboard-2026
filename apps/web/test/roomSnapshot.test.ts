import { expect, test } from "bun:test";
import { isFourReversiRoom, isFourShogiRoom, roomSocketContract } from "@tetraboard/protocol";
import { roomSnapshotFor } from "../src/features/room/roomSnapshot";
import { waitingRoom, now, playerIds } from "../browser-tests/fixtures";
import { waitingShogiRoom } from "../browser-tests/fourShogiFixtures";

for (const [game, room, other, guard] of [
  ["four-reversi", waitingRoom(), waitingShogiRoom(), isFourReversiRoom],
  ["four-shogi", waitingShogiRoom(), waitingRoom(), isFourShogiRoom],
] as const) {
  test(`${game}: 同一ID・世代でも別ゲームの解析済みスナップショットは受理しない`, () => {
    const foreign = { ...other, id: room.id, instanceId: room.instanceId };
    const message = roomSocketContract.message.parse({
      type: "room.snapshot",
      room: foreign,
      serverNowMs: now,
      presence: { hostPlayerId: playerIds[0], connectedPlayerIds: [] },
    });
    if (message.type !== "room.snapshot") throw new Error("Expected snapshot");
    // ガードが異なるtupleを動的索引しない。各ゲームの入口を同条件で確認する。
    if (game === "four-reversi") {
      expect(roomSnapshotFor(message.room, isFourReversiRoom)).toBeNull();
      expect(roomSnapshotFor(room, isFourReversiRoom)).toBe(room);
    } else {
      expect(roomSnapshotFor(message.room, isFourShogiRoom)).toBeNull();
      expect(roomSnapshotFor(room, isFourShogiRoom)).toBe(room);
    }
    expect(guard(message.room)).toBe(false);
  });
}
