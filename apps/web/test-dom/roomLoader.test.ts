import { expect, test } from "bun:test";
import { RouterContextProvider } from "react-router";
import { roomLoader } from "../src/features/room/roomLoader";
import { waitingRoom, membership, token, now } from "../test/fixtures/rooms";
import { waitingShogiRoom } from "../test/fixtures/fourShogiFixtures";
import { flush, requests } from "./harness";

const args = (path: string, id = "12345", signal?: AbortSignal) => ({
  params: { id },
  request: new Request(`https://tetraboard.test${path}`, { signal }),
  context: new RouterContextProvider(),
  url: new URL(`https://tetraboard.test${path}`),
  pattern: "/rooms/:id",
});
const snapshot = (room: ReturnType<typeof waitingRoom> | ReturnType<typeof waitingShogiRoom>) => ({
  room,
  presence: { hostPlayerId: room.players[0]!.id, connectedPlayerIds: [] },
  serverNowMs: now,
});

test("直接アクセス・再読み込みはゲームを判別し、招待世代と本人確認を維持", async () => {
  for (const room of [waitingRoom(), waitingShogiRoom()]) {
    for (let repeat = 0; repeat < 2; repeat++) {
      sessionStorage.setItem("tetraboard:room:12345:membership", token);
      const count = requests.length;
      const input = args(`/rooms/12345?invite=${room.instanceId}`),
        pending = roomLoader(input);
      expect(requests.at(-1)!.url).toBe("/api/rooms/12345?formationAnalysis=1&stamps=1");
      requests.at(-1)!.respond({
        ...snapshot(room),
        ...(room.settings.game === "four-shogi" ? { formationAnalysis: null } : {}),
      });
      await flush();
      expect(requests.at(-1)!.url).toBe("/api/rooms/12345/me");
      expect(requests.at(-1)!.init.signal).toBe(input.request.signal);
      requests.at(-1)!.respond(membership);
      const loaded = await pending;
      expect(loaded.game).toBe(room.settings.game);
      expect(loaded.room).toEqual(room);
      expect(loaded.invited).toBe(true);
      expect(loaded.membership).toEqual(membership);
      expect(requests).toHaveLength(count + 2);
      if (loaded.game === "four-shogi") expect(loaded.formationAnalysisSupported).toBe(true);
    }
  }
});
test("不正なID・招待・再利用された世代・不一致な本人は対象ルームへ進めない", async () => {
  for (const input of [
    args("/rooms/bad", "bad"),
    args("/rooms/12345?invite=bad"),
    args(`/rooms/12345?invite=${waitingRoom().instanceId}&invite=${waitingRoom().instanceId}`),
  ])
    await expect(roomLoader(input)).rejects.toMatchObject({ status: 400 });
  expect(requests).toHaveLength(0);
  let pending = roomLoader(args(`/rooms/12345?invite=${crypto.randomUUID()}`));
  requests.at(-1)!.respond(snapshot(waitingRoom()));
  await expect(pending).rejects.toMatchObject({ status: 410 });
  expect(requests).toHaveLength(1);
  sessionStorage.setItem("tetraboard:room:12345:membership", token);
  pending = roomLoader(args("/rooms/12345"));
  requests.at(-1)!.respond(snapshot(waitingRoom()));
  await flush();
  requests.at(-1)!.respond({ ...membership, playerId: crypto.randomUUID() });
  await expect(pending).rejects.toMatchObject({ status: 503 });
});
test("本人資格が失効した読み込みは資格を消去して観戦へ戻る", async () => {
  sessionStorage.setItem("tetraboard:room:12345:membership", token);
  const pending = roomLoader(args("/rooms/12345"));
  requests.at(-1)!.respond(snapshot(waitingRoom()));
  await flush();
  requests.at(-1)!.respond({ error: "unauthorized" }, 401);
  expect((await pending).membership).toBeNull();
  expect(sessionStorage.getItem("tetraboard:room:12345:membership")).toBeNull();
});
