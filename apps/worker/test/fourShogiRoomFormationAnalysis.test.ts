import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { createInitialState, getActionAvailability } from "@tetraboard/four-shogi";
import { getRoomContract, fourShogiRoomSchema, isFourShogiRoom } from "@tetraboard/protocol";
import { ShogiStore } from "../src/adapters/room/games/four-shogi/store";
import { GameRoom } from "../src/durableObjects/gameRoom/gameRoom";
import { formationAction, formationState } from "../../../test-fixtures/shogiFormations";
import { shogiMatchStartKey, type ActiveShogiMatch } from "../src/adapters/record/shogiMatchStore";
import {
  registerFourShogiRoomFixtures,
  create,
  request,
  connect,
  start,
  sideIndex,
  get,
  resignCurrent,
} from "./fourShogiRoomFixtures";

registerFourShogiRoomFixtures();

test("戦型解析は要求したHTTP・WebSocketだけへ付加し、待機中はnullを返す", async () => {
  const created = await create();
  const plain = await (await request(`/rooms/${created.room.id}`)).json();
  expect(plain).not.toHaveProperty("formationAnalysis");
  const analyzed = getRoomContract.response.parse(
    await (await request(`/rooms/${created.room.id}?formationAnalysis=1`)).json(),
  );
  expect(analyzed.formationAnalysis).toBeNull();
  expect(analyzed.room).not.toHaveProperty("formationAnalysis");
  const oldSocket = await connect(created.room.id);
  const newSocket = await connect(created.room.id, undefined, true);
  const oldSnapshot = await oldSocket.until((message) => message.type === "room.snapshot");
  const newSnapshot = await newSocket.until((message) => message.type === "room.snapshot");
  expect(oldSnapshot).not.toHaveProperty("formationAnalysis");
  expect(newSnapshot).toHaveProperty("formationAnalysis", null);
  expect((await request(`/rooms/${created.room.id}?formationAnalysis=2`)).status).toBe(400);
});

test.each([
  { id: "tenshukaku" as const, matches: [{ id: "tenshukaku", name: "天守閣玉" }] },
  { id: "five" as const, matches: [{ id: "five", name: "ファイブ" }] },
  {
    id: "lower-gold" as const,
    matches: [{ id: "lower-gold", name: "地下鉄飛車・下段金寄せ" }],
  },
  {
    id: "yuzuu-muge" as const,
    matches: [{ id: "yuzuu-muge", name: "地下鉄飛車・融通無碍" }],
  },
])(
  "$id: 確定局面の解析revision・混在配信・再接続・休止後の接続タグと保存分離",
  async ({ id, matches }) => {
    const prepared = await start();
    const stub = env.GAME_ROOM.getByName(prepared.id);
    await runInDurableObject(stub, (_instance, state) => {
      const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      const store = new ShogiStore(state.storage.sql);
      const game = formationState(
        createInitialState({ mode: room.settings.mode, players: room.game.players }),
        id,
        "south",
        false,
      );
      state.storage.kv.put(
        "room",
        fourShogiRoomSchema.parse({
          ...room,
          game: store.saveState(room.roundId, game),
          ...getActionAvailability(game),
          clock: { ...room.clock, turnStartedAt: Date.now(), turnExpiresAt: Date.now() + 300000 },
        }),
      );
    });
    const actor = prepared.clients[sideIndex(prepared, "south")];
    const analyzed = await connect(
      prepared.id,
      prepared.memberships[sideIndex(prepared, "west")].token,
      true,
    );
    actor.send({
      type: "room.game.action",
      roundId: prepared.room.roundId,
      positionRevision: 0,
      action: formationAction(id),
    });
    const accepted = await actor.room(
      (room) => room.status === "playing" && room.positionRevision === 1,
    );
    const snapshot = await analyzed.until(
      (message) =>
        message.type === "room.snapshot" &&
        isFourShogiRoom(message.room) &&
        message.room.positionRevision === 1,
    );
    if (snapshot.type !== "room.snapshot") throw new Error("No snapshot");
    expect(snapshot.formationAnalysis).toMatchObject({
      analyzerId: "four-shogi-formations",
      analysisVersion: 3,
      rulesVersion: 1,
      roundId: prepared.room.roundId,
      positionRevision: 1,
      matches: { south: matches, west: [], north: [], east: [] },
    });
    expect(snapshot.formationAnalysis?.matches.south).toHaveLength(matches.length);
    for (const match of snapshot.formationAnalysis!.matches.south)
      expect(match.matchedSquares).toHaveLength(9);
    const oldSnapshot = await prepared.clients[sideIndex(prepared, "north")].until(
      (message) =>
        message.type === "room.snapshot" &&
        isFourShogiRoom(message.room) &&
        message.room.positionRevision === 1,
    );
    expect(oldSnapshot).not.toHaveProperty("formationAnalysis");
    const http = getRoomContract.response.parse(
      await (await request(`/rooms/${prepared.id}?formationAnalysis=1`)).json(),
    );
    expect(http.formationAnalysis).toEqual(snapshot.formationAnalysis);
    expect(http.room).toEqual(accepted);

    // Durable Objectのインスタンスを作り直し、認証attachmentと休止対応タグだけで配信する。
    await runInDurableObject(stub, async (_instance, state) => {
      const socket = state.getWebSockets("formation-analysis-v1")[0];
      expect(state.getTags(socket)).toEqual(["formation-analysis-v1"]);
      expect(socket.deserializeAttachment()).not.toHaveProperty("formationAnalysis");
      await new GameRoom(state, env).webSocketMessage(
        socket,
        JSON.stringify({
          type: "room.game.draw.set",
          proposed: true,
          roundId: prepared.room.roundId,
          positionRevision: 1,
        }),
      );
      const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
      expect(JSON.stringify(room)).not.toContain("formationAnalysis");
      expect(
        state.storage.kv.get<ActiveShogiMatch>(shogiMatchStartKey)?.formationUsage?.bySide.south,
      ).toEqual(matches.map((match) => match.id));
      expect(
        JSON.stringify(
          new ShogiStore(state.storage.sql).loadState(prepared.room.roundId, room.game!),
        ),
      ).not.toContain(id);
    });
    const afterWake = await analyzed.until(
      (message) =>
        message.type === "room.snapshot" &&
        isFourShogiRoom(message.room) &&
        message.room.positionRevision === 2,
    );
    expect(afterWake).toHaveProperty("formationAnalysis.positionRevision", 2);
    analyzed.close();
    const reconnected = await connect(prepared.id, undefined, true);
    const restored = await reconnected.until((message) => message.type === "room.snapshot");
    expect(restored).toHaveProperty("formationAnalysis.matches.south.0.id", matches[0].id);
    let current = await get(prepared.id);
    while (current.status === "playing") current = await resignCurrent(prepared, current);
    expect(JSON.stringify(current)).not.toContain("formationAnalysis");
    await vi.waitFor(async () => {
      const stored = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
        .bind(prepared.room.roundId)
        .first<{ record_json: string }>();
      expect(stored).not.toBeNull();
      expect(stored?.record_json).not.toContain("formationAnalysis");
      expect(stored?.record_json).not.toContain(id);
      const usage = await env.APP_DB.prepare(
        "SELECT used_by_side_json FROM four_shogi_formation_usages WHERE match_id = ?",
      )
        .bind(prepared.room.roundId)
        .first<{ used_by_side_json: string }>();
      expect(JSON.parse(usage!.used_by_side_json).south).toEqual(matches.map((match) => match.id));
    });
  },
);

test("戦法履歴導入前の進行局は確定着手後も印を追加せず、通常の終局記録だけを保存する", async () => {
  const prepared = await start();
  const stub = env.GAME_ROOM.getByName(prepared.id);
  await runInDurableObject(stub, (_instance, state) => {
    const active = state.storage.kv.get<ActiveShogiMatch>(shogiMatchStartKey)!;
    delete active.formationUsage;
    state.storage.kv.put(shogiMatchStartKey, active);
    const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Not playing");
    const store = new ShogiStore(state.storage.sql);
    const game = formationState(
      createInitialState({ mode: "singles", players: room.game.players }),
      "tenshukaku",
      "south",
      false,
    );
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...room,
        game: store.saveState(room.roundId, game),
        ...getActionAvailability(game),
        clock: { ...room.clock, turnStartedAt: Date.now(), turnExpiresAt: Date.now() + 300000 },
      }),
    );
  });
  const actor = prepared.clients[sideIndex(prepared, "south")];
  actor.send({
    type: "room.game.action",
    roundId: prepared.room.roundId,
    positionRevision: 0,
    action: formationAction("tenshukaku"),
  });
  let room = await actor.room((next) => next.status === "playing" && next.positionRevision === 1);
  expect(
    await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.kv.get<ActiveShogiMatch>(shogiMatchStartKey)?.formationUsage,
    ),
  ).toBeUndefined();
  while (room.status === "playing") room = await resignCurrent(prepared, room);
  await vi.waitFor(async () =>
    expect(
      await env.APP_DB.prepare("SELECT id FROM matches WHERE id = ?")
        .bind(prepared.room.roundId)
        .first(),
    ).not.toBeNull(),
  );
  expect(
    await env.APP_DB.prepare("SELECT match_id FROM four_shogi_formation_usages WHERE match_id = ?")
      .bind(prepared.room.roundId)
      .first(),
  ).toBeNull();
});
