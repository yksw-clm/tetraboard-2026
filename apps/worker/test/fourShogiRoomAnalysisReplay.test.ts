import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { setDrawProposal } from "@tetraboard/four-shogi";
import { getFourShogiAnalysisReplayContract, fourShogiRoomSchema } from "@tetraboard/protocol";
import { ShogiStore } from "../src/rooms/shogiStore";
import {
  registerFourShogiRoomFixtures,
  start,
  request,
  sideIndex,
  resignCurrent,
  get,
} from "./fourShogiRoomFixtures";

registerFourShogiRoomFixtures();

test("進行中の解析棋譜はrevision固定で取得でき、氏名・参加資格を返さない", async () => {
  const prepared = await start();
  const path = (
    revision: number,
    cursor = 0,
    instanceId = prepared.room.instanceId,
    roundId = prepared.room.roundId,
  ) =>
    `${getFourShogiAnalysisReplayContract.pathFor(prepared.id, roundId)}?${new URLSearchParams({ instanceId, positionRevision: String(revision), cursor: String(cursor) })}`;
  const firstResponse = await request(path(0));
  expect(firstResponse.status).toBe(200);
  expect(firstResponse.headers.get("Cache-Control")).toBe("no-store");
  const first = getFourShogiAnalysisReplayContract.response.parse(await firstResponse.json());
  expect(first.events).toEqual([]);
  expect(first.initial).toEqual({ mode: "singles", threePlayerAttackProhibited: true });
  expect(first.initial).not.toHaveProperty("players");
  const south = prepared.clients[sideIndex(prepared, "south")];
  south.send({
    type: "room.game.action",
    roundId: prepared.room.roundId,
    positionRevision: 0,
    action: prepared.room.legalActions[0],
  });
  const moved = await south.room(
    (room) => room.status === "playing" && room.positionRevision === 1,
  );
  expect(moved.status).toBe("playing");
  expect((await request(path(0))).status).toBe(409);
  const updated = getFourShogiAnalysisReplayContract.response.parse(
    await (await request(path(1))).json(),
  );
  expect(updated.events).toEqual([
    { index: 0, event: { type: "action", side: "south", action: prepared.room.legalActions[0] } },
  ]);
  expect(updated.positionRevision).toBe(1);
  expect((await request(path(1, 1))).status).toBe(200);
  expect((await request(path(1, 2))).status).toBe(404);
  expect((await request(path(1, 0, crypto.randomUUID()))).status).toBe(410);
  expect((await request(path(1, 0, prepared.room.instanceId, crypto.randomUUID()))).status).toBe(
    404,
  );
  expect((await request(path(1).replace("positionRevision=1", "positionRevision=x"))).status).toBe(
    400,
  );
  for (let i = 0; i < 3; i++) await resignCurrent(prepared, await get(prepared.id));
  expect((await request(path(1))).status).toBe(404);
});

test("解析棋譜は100件の境界と末尾差分を返し、ページ途中のrevision変更を拒否する", async () => {
  const prepared = await start();
  const stub = env.GAME_ROOM.getByName(prepared.id);
  await runInDurableObject(stub, (_instance, state) => {
    const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw Error("Not playing");
    const store = new ShogiStore(state.storage.sql);
    let game = store.loadTransition(room.roundId, room.game).state;
    for (let i = 0; i < 101; i++) {
      const result = setDrawProposal(game, "south", i % 2 === 0);
      if (!result.ok) throw Error("fixture");
      game = result.state;
      store.appendEvent(room.roundId, {
        type: "drawProposal",
        side: "south",
        proposed: i % 2 === 0,
      });
    }
    state.storage.kv.put("room", {
      ...room,
      game: store.saveState(room.roundId, game),
      positionRevision: 101,
    });
  });
  const path = (revision: number, cursor: number) =>
    `${getFourShogiAnalysisReplayContract.pathFor(prepared.id, prepared.room.roundId)}?${new URLSearchParams({ instanceId: prepared.room.instanceId, positionRevision: String(revision), cursor: String(cursor) })}`;
  const page = getFourShogiAnalysisReplayContract.response.parse(
    await (await request(path(101, 0))).json(),
  );
  expect(page.eventCount).toBe(101);
  expect(page.events).toHaveLength(100);
  expect(page.nextCursor).toBe(100);
  const tail = getFourShogiAnalysisReplayContract.response.parse(
    await (await request(path(101, 100))).json(),
  );
  expect(tail.events).toEqual([
    { index: 100, event: { type: "drawProposal", side: "south", proposed: true } },
  ]);
  expect(tail.nextCursor).toBeNull();
  await runInDurableObject(stub, (_instance, state) => {
    const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put("room", { ...room, positionRevision: 102 });
  });
  expect((await request(path(101, 100))).status).toBe(409);
});

test("四人将棋ダブルスには解析棋譜を提供しない", async () => {
  const prepared = await start("doubles");
  const query = new URLSearchParams({
    instanceId: prepared.room.instanceId,
    positionRevision: "0",
  });
  expect(
    (
      await request(
        `${getFourShogiAnalysisReplayContract.pathFor(prepared.id, prepared.room.roundId)}?${query}`,
      )
    ).status,
  ).toBe(404);
});
