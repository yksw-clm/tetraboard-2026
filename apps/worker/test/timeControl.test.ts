import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  createRoomContract,
  roomTimeControl,
  roomTimeControlSchema,
  roomMainTimePresets,
  roomByoyomiPresets,
} from "@tetraboard/protocol";

for (const game of ["four-reversi", "four-shogi"] as const) {
  test.each(
    roomMainTimePresets.flatMap((mainTimeMs) =>
      roomByoyomiPresets
        .filter((byoyomiMs) => mainTimeMs + byoyomiMs > 0)
        .map((byoyomiMs) => ({ mainTimeMs, byoyomiMs })),
    ),
  )(`${game} は時間設定 $mainTimeMs + $byoyomiMs で作成できる`, async (timeControl) => {
    const response = await exports.default.fetch(
      new Request("https://example.com/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "ホスト",
          game,
          mode: "singles",
          quickPlay: false,
          timeControl,
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(
      createRoomContract.response.parse(await response.json()).room.settings.timeControl,
    ).toEqual(timeControl);
  });
  test.each([
    { mainTimeMs: 0, byoyomiMs: 0 },
    { mainTimeMs: -1, byoyomiMs: 30_000 },
    { mainTimeMs: 120_000, byoyomiMs: 30_000 },
    { mainTimeMs: 300_000, byoyomiMs: 20_000 },
    { mainTimeMs: 60_000.5, byoyomiMs: 0 },
    { mainTimeMs: "60000", byoyomiMs: 10_000 },
  ])(`${game} は不正な時間設定を作成時に拒否する %j`, async (timeControl) => {
    expect(roomTimeControlSchema.safeParse(timeControl).success).toBe(false);
    const response = await exports.default.fetch(
      new Request("https://example.com/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "ホスト",
          game,
          mode: "singles",
          quickPlay: false,
          timeControl,
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });
  test(`${game} の時間設定を省略した作成は従来の初期値になる`, async () => {
    const response = await exports.default.fetch(
      new Request("https://example.com/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ホスト", game, mode: "singles", quickPlay: true }),
      }),
    );
    expect(response.status).toBe(201);
    expect(
      createRoomContract.response.parse(await response.json()).room.settings.timeControl,
    ).toEqual(roomTimeControl);
  });
}
