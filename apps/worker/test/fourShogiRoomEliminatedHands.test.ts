import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { eliminateSide, getActionAvailability } from "@tetraboard/four-shogi";
import {
  createRoomContract,
  fourShogiRoomSchema,
  isFourShogiRoom,
  type RoomSocketMessage,
} from "@tetraboard/protocol";
import { FourShogiProgress, shogiEliminatedHandsKey } from "../src/rooms/fourShogiProgress";
import {
  fixture as engineFixture,
  move as engineMove,
} from "../../../packages/four-shogi/bench/positionFixture";
import { ShogiStore } from "../src/rooms/shogiStore";
import { GameRoom } from "../src/durableObjects/gameRoom/gameRoom";
import { shogiMatchStartKey } from "../src/adapters/record/shogiMatchStore";
import {
  registerFourShogiRoomFixtures,
  start,
  connect,
  sideIndex,
  request,
  resignCurrent,
  get,
  create,
  json,
} from "./fourShogiRoomFixtures";

registerFourShogiRoomFixtures();

test("脱落時持ち駒の要求別配信・同時詰み・再取得・休止・終局・次局を保持する", async () => {
  const prepared = await start();
  const stub = env.GAME_ROOM.getByName(prepared.id);
  const hand = { rook: 1, gold: 2, silver: 3, pawn: 12 };
  await runInDurableObject(stub, (_instance, ctx) => {
    const room = fourShogiRoomSchema.parse(ctx.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Not playing");
    const state = engineFixture({
      kings: { south: "E9" },
      hands: { west: hand, north: hand },
      pieces: [
        { side: "south", kind: "rook", at: "E2" },
        { side: "south", kind: "rook", at: "B1" },
        { side: "south", kind: "rook", at: "H1" },
        { side: "south", kind: "gold", at: "B3" },
        { side: "south", kind: "gold", at: "H3" },
      ],
    });
    const game = {
      ...state,
      players: room.game.players,
      threePlayerAttackProhibited: room.game.threePlayerAttackProhibited,
    };
    ctx.storage.kv.delete(shogiMatchStartKey);
    ctx.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...room,
        game: new ShogiStore(ctx.storage.sql).saveState(room.roundId, game),
        ...getActionAvailability(game),
      }),
    );
  });
  const plain = await connect(prepared.id);
  const handsOnly = await connect(prepared.id, undefined, false, true);
  const both = await connect(prepared.id, undefined, true, true);
  const south = prepared.clients[sideIndex(prepared, "south")];
  south.send({
    type: "room.game.action",
    roundId: prepared.room.roundId,
    positionRevision: 0,
    action: engineMove("E2", "E1"),
  });
  const updated = await south.room(
    (room) => room.status === "playing" && room.positionRevision === 1,
  );
  expect(updated.game?.hands.west.pawn).toBe(0);
  const predicate = (m: RoomSocketMessage) =>
    m.type === "room.snapshot" && isFourShogiRoom(m.room) && m.room.positionRevision === 1;
  const ordinary = await plain.until(predicate);
  const retained = await handsOnly.until(predicate);
  const analyzed = await both.until(predicate);
  const expected = { roundId: prepared.room.roundId, hands: { west: hand, north: hand } };
  expect(ordinary).not.toHaveProperty("eliminatedHands");
  expect(retained).toHaveProperty("eliminatedHands", expected);
  expect(retained).not.toHaveProperty("formationAnalysis");
  expect(analyzed).toHaveProperty("eliminatedHands", expected);
  expect(analyzed).toHaveProperty("formationAnalysis.positionRevision", 1);
  expect(await (await request(`/rooms/${prepared.id}`)).json()).not.toHaveProperty(
    "eliminatedHands",
  );
  expect(await (await request(`/rooms/${prepared.id}?eliminatedHands=1`)).json()).toHaveProperty(
    "eliminatedHands",
    expected,
  );
  expect((await request(`/rooms/${prepared.id}?eliminatedHands=2`)).status).toBe(400);
  await runInDurableObject(stub, async (_instance, ctx) => {
    const socket = ctx
      .getWebSockets("eliminated-hands-v1")
      .find((socket) => ctx.getTags(socket).includes("formation-analysis-v1"))!;
    await new GameRoom(ctx, env).webSocketMessage(
      socket,
      JSON.stringify({
        type: "room.auth",
        token: prepared.memberships[sideIndex(prepared, "east")].token,
      }),
    );
    expect(ctx.getTags(socket)).toContain("eliminated-hands-v1");
    const room = fourShogiRoomSchema.parse(ctx.storage.kv.get("room"));
    expect(JSON.stringify(room)).not.toContain("eliminatedHands");
  });
  const reconnected = await connect(prepared.id, undefined, false, true);
  expect(await reconnected.until((m) => m.type === "room.snapshot")).toHaveProperty(
    "eliminatedHands",
    expected,
  );
  const final = await resignCurrent(prepared, await get(prepared.id));
  expect(final.status).toBe("waiting");
  expect(await (await request(`/rooms/${prepared.id}?eliminatedHands=1`)).json()).toHaveProperty(
    "eliminatedHands.hands.west",
    hand,
  );
  for (let index = 0; index < 4; index++) {
    prepared.clients[index].send({ type: "room.ready.set", ready: true });
    await prepared.clients[0].room(
      (room) => room.players.filter((p) => p.ready).length === index + 1,
    );
  }
  prepared.clients[0].send({ type: "room.game.start" });
  const next = await prepared.clients[0].room((room) => room.status === "playing");
  const snapshot = await (await request(`/rooms/${prepared.id}?eliminatedHands=1`)).json();
  expect(snapshot).toHaveProperty("eliminatedHands", { roundId: next.roundId, hands: {} });
  await runInDurableObject(stub, async (instance, ctx) => {
    const room = fourShogiRoomSchema.parse(ctx.storage.kv.get("room"));
    ctx.storage.kv.put("room", { ...room, lastActivityAtMs: Date.now() - 25 * 60 * 60 * 1000 });
    await instance.alarm();
    expect(ctx.storage.kv.get("room")).toBeUndefined();
    expect(ctx.storage.kv.get(shogiEliminatedHandsKey)).toBeUndefined();
  });
});

test("表示用保存は全外部脱落・両モードとロールバックに対応し、旧局・別局の値を使わない", async () => {
  const prepared = await start();
  await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), (_instance, ctx) => {
    const room = fourShogiRoomSchema.parse(ctx.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Not playing");
    const progress = new FourShogiProgress({
      storage: ctx.storage,
      membership: () => null,
      accountId: () => null,
    });
    const hand = { rook: 2, gold: 1, silver: 0, pawn: 3 };
    ctx.storage.kv.delete(shogiMatchStartKey);
    for (const mode of ["singles", "doubles"] as const)
      for (const reason of ["resigned", "left", "timeout", "disconnected"] as const) {
        const game = {
          ...new ShogiStore(ctx.storage.sql).loadState(room.roundId, room.game),
          mode,
          hands: { ...room.game.hands, south: hand },
        };
        const input = fourShogiRoomSchema.parse({
          ...room,
          settings: { ...room.settings, mode },
          game: new ShogiStore(ctx.storage.sql).saveState(room.roundId, game),
        });
        if (input.status !== "playing") throw new Error("Not playing");
        const result = eliminateSide(game, "south", reason);
        if (!result.ok) throw new Error(result.reason);
        ctx.storage.kv.delete(shogiEliminatedHandsKey);
        const apply = () =>
          progress.accept(
            input,
            result.state,
            { type: "eliminate", side: "south", reason },
            Date.now(),
            true,
          );
        expect(() =>
          ctx.storage.transactionSync(() => {
            apply();
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(ctx.storage.kv.get(shogiEliminatedHandsKey)).toBeUndefined();
        ctx.storage.transactionSync(apply);
        expect(progress.displayHands(input, true)).toHaveProperty(
          "eliminatedHands.hands.south",
          hand,
        );
        expect(progress.displayHands(input, false)).toEqual({});
        expect(
          progress.displayHands({ ...input, roundId: crypto.randomUUID() }, true),
        ).toHaveProperty("eliminatedHands.hands", {});
      }
    ctx.storage.kv.delete(shogiEliminatedHandsKey);
    expect(progress.displayHands(room, true)).toHaveProperty("eliminatedHands.hands", {});
  });
});

test("待機中の表示用要求はnull、他ゲームには付加せず、未対応クライアントのroom形状を保つ", async () => {
  const created = await create();
  expect(
    await (await request(`/rooms/${created.room.id}?eliminatedHands=1`)).json(),
  ).toHaveProperty("eliminatedHands", null);
  expect(
    await (
      await connect(created.room.id, undefined, false, true)
    ).until((m) => m.type === "room.snapshot"),
  ).toHaveProperty("eliminatedHands", null);
  const other = createRoomContract.response.parse(
    await (
      await request(
        "/rooms",
        json({ name: "別ゲーム", game: "four-reversi", quickPlay: false, mode: "singles" }),
      )
    ).json(),
  );
  expect(
    await (await request(`/rooms/${other.room.id}?eliminatedHands=1`)).json(),
  ).not.toHaveProperty("eliminatedHands");
});
