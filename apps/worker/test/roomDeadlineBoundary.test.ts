import { gameProgress } from "../src/rooms/gameProgress";
import { humanFixtureRecord } from "./matchFixtures";
import { humanShogiRecord } from "./shogiMatchFixtures";
import { pendingMatchPrefix, type PendingMatch } from "../src/rooms/matchStore";
import { pendingShogiMatchPrefix, type PendingShogiMatch } from "../src/rooms/shogiMatchStore";
import {
  analyticsActiveKey,
  analyticsPendingPrefix,
  type AnalyticsMatch,
  type AnalyticsJob,
} from "../src/analytics/store";
import type { PendingRoomIndex } from "../src/rooms/roomIndex";
import type { AccountAdmission } from "../src/accounts/roomAccounts";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import {
  createRoomContract,
  joinRoomContract,
  getRoomContract,
  leaveRoomContract,
  roomSocketContract,
  roomSchema,
  roomMembershipSchema,
  isFourShogiRoom,
  fourShogiRoomSchema,
  type GameId,
} from "@tetraboard/protocol";
import { getLegalActions, type Side, type FourShogiAction } from "@tetraboard/four-shogi";
import { ShogiStore } from "../src/rooms/shogiStore";
import { BoundarySocket, boundaryRequest, boundaryJson } from "./roomBoundaryFixtures";
import { accountFixture, origin } from "./accountFixtures";

const entries: ReturnType<typeof createRoomContract.response.parse>[] = [];
const sockets: BoundarySocket[] = [];
afterEach(async () => {
  try {
    for (const entry of entries.splice(0).reverse()) {
      const response = await boundaryRequest(leaveRoomContract.pathFor(entry.room.id), {
        method: "POST",
        headers: { Origin: origin, Authorization: `Bearer ${entry.membership.token}` },
      });
      // 期限で解放された資格・閉鎖済みルームも片付けの完了状態。
      expect([204, 401, 404]).toContain(response.status);
    }
  } finally {
    for (const socket of sockets.splice(0)) socket.close();
  }
});
async function connect(entry: (typeof entries)[number]) {
  const response = await boundaryRequest(roomSocketContract.pathFor(entry.room.id), {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Missing WebSocket");
  const socket = new BoundarySocket(response.webSocket);
  sockets.push(socket);
  await socket.waitFor("room.snapshot");
  socket.send({ type: "room.auth", token: entry.membership.token });
  await socket.waitFor(
    "room.authenticated",
    (message) => message.membership.playerId === entry.membership.playerId,
  );
  await socket.waitFor("room.snapshot", (message) =>
    message.presence.connectedPlayerIds.includes(entry.membership.playerId),
  );
  return socket;
}
async function snapshot(id: string) {
  const response = await boundaryRequest(getRoomContract.pathFor(id));
  expect(response.status).toBe(200);
  return getRoomContract.response.parse(await response.json());
}
async function start(game: GameId, quickPlay = false) {
  const members: (typeof entries)[number][] = [];
  for (let index = 0; index < (quickPlay ? 1 : 4); index++) {
    const account = await accountFixture();
    const response = await boundaryRequest(
      index === 0 ? createRoomContract.path : joinRoomContract.pathFor(members[0].room.id),
      {
        ...boundaryJson(index === 0 ? { game, mode: "singles", quickPlay } : {}),
        headers: account.headers,
      },
    );
    expect(response.status).toBe(index === 0 ? 201 : 200);
    const entry = (index === 0 ? createRoomContract.response : joinRoomContract.response).parse(
      await response.json(),
    );
    entries.push(entry);
    members.push(entry);
  }
  const clients = [];
  for (const entry of members) clients.push(await connect(entry));
  if (!quickPlay) {
    for (const [index, client] of clients.entries()) {
      client.send({ type: "room.ready.set", ready: true });
      await clients[0].waitFor(
        "room.snapshot",
        (message) => message.room.players.filter((player) => player.ready).length === index + 1,
      );
    }
  }
  clients[0].send({ type: "room.game.start" });
  const { room } = await clients[0].waitFor(
    "room.snapshot",
    (message) => message.room.status === "playing",
  );
  if (room.status !== "playing") throw new Error("Not playing");
  return { members, clients, room, stub: env.GAME_ROOM.getByName(room.id) };
}

for (const game of ["four-reversi", "four-shogi"] satisfies GameId[]) {
  test(`${game}: hibernation後も進行局・時計・資格・認証済み配信を保持する`, async () => {
    const prepared = await start(game);
    await evictDurableObject(prepared.stub, { webSockets: "hibernate" });
    const restored = await snapshot(prepared.room.id);
    expect(restored.room).toEqual(prepared.room);
    expect(restored.presence.connectedPlayerIds.toSorted()).toEqual(
      prepared.members.map((entry) => entry.membership.playerId).toSorted(),
    );
    // 再認証を送らず既存ソケットで投了し、復元したattachmentと全接続への配信を検証。
    const playing = prepared.room;
    const currentPlayer = isFourShogiRoom(playing)
      ? playing.players.find((player) => player.side === playing.game.turn)
      : playing.players.find((player) => player.color === playing.game.turn);
    const index = prepared.members.findIndex(
      (entry) => entry.membership.playerId === currentPlayer?.id,
    );
    if (index < 0) throw new Error("Missing current player");
    prepared.clients[index].send({ type: "room.game.resign" });
    for (const client of prepared.clients) {
      const { room } = await client.waitFor(
        "room.snapshot",
        (message) =>
          message.room.status === "playing" &&
          (isFourShogiRoom(message.room)
            ? message.room.positionRevision === 1
            : message.room.game.eliminatedColors.length === 1),
      );
      expect(room.players.map((player) => player.id)).toEqual(
        prepared.room.players.map((player) => player.id),
      );
    }
  });

  test(`${game}: 接続を閉じるDO再生成は復帰期限を付け、同じ資格で同じ席へ戻す`, async () => {
    const prepared = await start(game);
    await evictDurableObject(prepared.stub, { webSockets: "close" });
    const disconnected = await snapshot(prepared.room.id);
    expect(disconnected.presence.connectedPlayerIds).toEqual([]);
    for (const player of disconnected.room.players)
      expect(player.reconnectDeadline).toBeTypeOf("number");
    expect(disconnected.room.game).toEqual(prepared.room.game);
    expect(disconnected.room.clock).toEqual(prepared.room.clock);
    await connect(prepared.members[0]);
    const restored = await snapshot(prepared.room.id);
    expect(restored.room.players[0]).toEqual({
      ...prepared.room.players[0],
      reconnectDeadline: null,
    });
    expect(restored.room.players).toHaveLength(4);
    expect(restored.presence.connectedPlayerIds).toEqual([prepared.members[0].membership.playerId]);
    expect(restored.room.game).toEqual(prepared.room.game);
    expect(restored.room.clock).toEqual(prepared.room.clock);
  });

  test(`${game}: 遅延AlarmとDO復元を繰り返しても終局・保存・本人索引・計測を重複させない`, async () => {
    const prepared = await start(game);
    const roundId = await runInDurableObject(prepared.stub, (_instance, state) => {
      const room = roomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      const deadline = Date.now() - 90_001;
      // 全席の基本時間を消費済みとし、保存された期限から3人分を連続処理。
      const remainingMainMs = isFourShogiRoom(room)
        ? { south: 0, west: 0, north: 0, east: 0 }
        : { black: 0, white: 0, red: 0, blue: 0 };
      state.storage.kv.put(
        "room",
        roomSchema.parse({
          ...room,
          clock: { remainingMainMs, turnStartedAt: deadline - 30_000, turnExpiresAt: deadline },
        }),
      );
      const active = state.storage.kv.get<{ id: string }>("match-start");
      if (!isFourShogiRoom(room) && !active) throw new Error("Missing match");
      return isFourShogiRoom(room) ? room.roundId : active?.id;
    });
    if (!roundId) throw new Error("Missing round ID");
    await evictDurableObject(prepared.stub, { webSockets: "hibernate" });
    expect(await runDurableObjectAlarm(prepared.stub)).toBe(true);
    const finished = (await snapshot(prepared.room.id)).room;
    expect(finished.status).toBe("waiting");
    expect(finished.clock).toBeNull();
    if (!finished.lastRound) throw new Error("Missing last round");
    if (isFourShogiRoom(finished)) {
      expect(
        finished.lastRound.game.eliminations.map(({ side, reason }) => ({ side, reason })),
      ).toEqual([
        { side: "south", reason: "timeout" },
        { side: "west", reason: "timeout" },
        { side: "north", reason: "timeout" },
      ]);
    } else expect(finished.lastRound.game.eliminatedColors).toEqual(["black", "white", "red"]);
    const persisted = async () => {
      const match = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
        .bind(roundId)
        .first<{ record_json: string }>();
      expect(match).not.toBeNull();
      expect(
        await env.APP_DB.prepare(
          "SELECT COUNT(*) AS n FROM account_match_history WHERE match_id = ?",
        )
          .bind(roundId)
          .first(),
      ).toEqual({ n: 4 });
      expect(
        await env.APP_DB.prepare("SELECT status FROM analytics_matches WHERE id = ?")
          .bind(roundId)
          .first(),
      ).toEqual({ status: "completed" });
      expect(
        await env.APP_DB.prepare(
          "SELECT COUNT(*) AS n FROM analytics_participants WHERE match_id = ?",
        )
          .bind(roundId)
          .first(),
      ).toEqual({ n: 4 });
      return match;
    };
    await vi.waitFor(persisted);
    const record = await persisted();
    for (let index = 0; index < 2; index++) {
      await evictDurableObject(prepared.stub, { webSockets: "hibernate" });
      expect(await runDurableObjectAlarm(prepared.stub)).toBe(true);
      expect((await snapshot(prepared.room.id)).room).toEqual(finished);
      expect(await persisted()).toEqual(record);
      await runInDurableObject(prepared.stub, (_instance, state) => {
        expect(Array.from(state.storage.kv.list({ prefix: "match-pending:" })).length).toBe(0);
        expect(Array.from(state.storage.kv.list({ prefix: "shogi-match-pending:" })).length).toBe(
          0,
        );
      });
    }
  });
}

test.each(["同時刻", "切断が先", "時計が先", "切断同士"])(
  "将棋: %s の期限を確定時刻と席順で処理する",
  async (ordering) => {
    const prepared = await start("four-shogi");
    const started = fourShogiRoomSchema.parse(prepared.room);
    if (started.status !== "playing") throw new Error("Not playing");
    const selected =
      ordering === "切断同士"
        ? started.players.filter((player) => player.side === "west" || player.side === "north")
        : started.players.filter((player) => player.side === "east");
    const at = Date.now() - 10;
    await runInDurableObject(prepared.stub, (_instance, state) => {
      const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      state.storage.kv.put(
        "room",
        fourShogiRoomSchema.parse({
          ...room,
          clock: {
            ...room.clock,
            turnExpiresAt:
              ordering === "切断同士"
                ? Date.now() + 60_000
                : at + (ordering === "切断が先" ? 1 : 0),
          },
          players: room.players.map((player) =>
            selected.some((entry) => entry.id === player.id)
              ? { ...player, reconnectDeadline: at + (ordering === "時計が先" ? 1 : 0) }
              : player,
          ),
        }),
      );
    });
    expect(await runDurableObjectAlarm(prepared.stub)).toBe(true);
    const result = fourShogiRoomSchema.parse((await snapshot(started.id)).room);
    if (result.status !== "playing") throw new Error("Ended early");
    const expected =
      ordering === "切断同士"
        ? selected.map((player) => ({ side: player.side, reason: "disconnected" }))
        : ordering === "切断が先"
          ? [
              { side: "east", reason: "disconnected" },
              { side: "south", reason: "timeout" },
            ]
          : [
              { side: "south", reason: "timeout" },
              { side: "east", reason: "disconnected" },
            ];
    expect(result.game.eliminations.map(({ side, reason }) => ({ side, reason }))).toEqual(
      expected,
    );
    expect(result.positionRevision).toBe(2);
  },
);

type SavedCpuJob = {
  roundId: string;
  positionRevision: number;
  side: Side;
  action: FourShogiAction;
  applyAt: number;
};
test.each(["一致", "期限切れ", "別局", "revision違い", "手番違い"])(
  "将棋: DO再生成後の保存済みCPU選択を再検証する (%s)",
  async (condition) => {
    const prepared = await start("four-shogi", true);
    await runInDurableObject(prepared.stub, async (instance, state) => {
      const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      const cpu = room.players.find((player) => player.kind === "cpu");
      if (!cpu) throw new Error("Missing CPU");
      const store = new ShogiStore(state.storage.sql);
      const game = store.loadState(room.roundId, room.game);
      if (game.status !== "playing") throw new Error("Not playing");
      const next = { ...game, turn: cpu.side };
      state.storage.kv.put(
        "room",
        fourShogiRoomSchema.parse({
          ...room,
          game: store.saveState(room.roundId, next),
          legalActions: getLegalActions(next),
          clock: {
            ...room.clock,
            turnStartedAt: Date.now() - 1_000,
            turnExpiresAt: Date.now() + 300_000,
          },
        }),
      );
      await instance.alarm();
      const job = state.storage.kv.get<SavedCpuJob>("shogi-cpu-job");
      if (!job) throw new Error("No saved selection");
      state.storage.kv.put("shogi-cpu-job", {
        ...job,
        applyAt: Date.now() - 1,
        roundId: condition === "別局" ? crypto.randomUUID() : job.roundId,
        positionRevision:
          condition === "revision違い" ? job.positionRevision + 1 : job.positionRevision,
        side: condition === "手番違い" ? room.players[0].side : job.side,
      });
      if (condition === "期限切れ") {
        const selected = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
        state.storage.kv.put(
          "room",
          fourShogiRoomSchema.parse({
            ...selected,
            clock: { ...selected.clock, turnExpiresAt: Date.now() - 1 },
          }),
        );
      }
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await evictDurableObject(prepared.stub, { webSockets: "hibernate" });
    const applied = await runInDurableObject(prepared.stub, async (instance, state) => {
      await instance.alarm();
      expect(state.storage.kv.get("shogi-cpu-job")).toBeUndefined();
      const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      // 次の選択を作る自動Alarmを止め、再実行でこの選択を二重適用しないことを検査。
      state.storage.kv.put(
        "room",
        fourShogiRoomSchema.parse({
          ...room,
          clock: { ...room.clock, turnStartedAt: Date.now() + 60_000 },
        }),
      );
      await state.storage.setAlarm(Date.now() + 60_000);
      return room;
    });
    const result = fourShogiRoomSchema.parse((await snapshot(prepared.room.id)).room);
    if (result.status !== "playing") throw new Error("Ended early");
    expect(result.game).toEqual(applied.game);
    expect(result.game.moveNumber).toBe(condition === "一致" ? 1 : 0);
    expect(result.positionRevision).toBe(condition === "一致" || condition === "期限切れ" ? 1 : 0);
    if (condition === "期限切れ")
      expect(result.game.eliminations).toMatchObject([{ reason: "timeout" }]);
    await evictDurableObject(prepared.stub, { webSockets: "hibernate" });
    expect(await runDurableObjectAlarm(prepared.stub)).toBe(true);
    expect(
      fourShogiRoomSchema.parse((await snapshot(prepared.room.id)).room).game?.moveNumber,
    ).toBe(result.game.moveNumber);
  },
);

// 保存待ちは実際の保存型で作り、将来の期限なので外部サービスを失敗させずに候補を検証する。
test.each(["時計", "復帰", "活動停止", "索引", "席解放", "計測", "リバーシ保存", "将棋保存"])(
  "Alarm候補: %s が最小ならその保存時刻を選ぶ",
  async (source) => {
    const prepared = await start("four-reversi");
    const early = Date.now() + 60_000;
    const late = early + 60_000;
    const retry = (name: string) => (source === name ? early : late);
    const record = humanFixtureRecord(crypto.randomUUID(), 0);
    const shogi = humanShogiRecord(null).record;
    const metadata = await prepared.stub.getPublicMetadata();
    if (!metadata) throw new Error("Missing metadata");
    await runInDurableObject(prepared.stub, async (instance, state) => {
      const room = roomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      const active = state.storage.kv.get<AnalyticsMatch>(analyticsActiveKey);
      const reservation = state.storage.kv.get<AccountAdmission>(
        `seat-account:${room.players[0].id}`,
      );
      if (!active || !reservation) throw new Error("Missing stored identity");
      state.storage.kv.put(
        "room",
        roomSchema.parse({
          ...room,
          lastActivityAtMs: retry("活動停止") - 24 * 60 * 60 * 1_000,
          clock: { ...room.clock, turnExpiresAt: retry("時計") },
          players: room.players.map((player, index) => ({
            ...player,
            reconnectDeadline: index === 0 ? retry("復帰") : null,
          })),
        }),
      );
      state.storage.kv.put("room-index-pending", {
        revision: 1,
        closed: false,
        metadata,
        retryAtMs: retry("索引"),
      } satisfies PendingRoomIndex);
      state.storage.kv.put("account-cleanups", [
        { reservation, releaseAvatar: false, retryAtMs: retry("席解放") },
      ]);
      state.storage.kv.put(analyticsPendingPrefix + active.id, {
        record: active,
        revision: 1,
        retryAtMs: retry("計測"),
      } satisfies AnalyticsJob);
      state.storage.kv.put(pendingMatchPrefix + record.id, {
        record,
        retryAtMs: retry("リバーシ保存"),
      } satisfies PendingMatch);
      state.storage.kv.put(pendingShogiMatchPrefix + shogi.id, {
        record: shogi,
        progress: { phase: "upload", cursor: 0 },
        retryAtMs: retry("将棋保存"),
      } satisfies PendingShogiMatch);
      await instance.getRoom();
      expect(await state.storage.getAlarm()).toBe(early);
      // 自動再試行を残さず、通常の資格・ルーム解放へ戻す。
      for (const prefix of [pendingMatchPrefix, pendingShogiMatchPrefix, analyticsPendingPrefix])
        for (const [key] of state.storage.kv.list({ prefix })) state.storage.kv.delete(key);
      state.storage.kv.delete("room-index-pending");
      state.storage.kv.delete("account-cleanups");
      state.storage.kv.put("room", room);
    });
  },
);

test("部屋閉鎖後も対局保存をAlarmに残し、候補がなくなれば削除する", async () => {
  const prepared = await start("four-reversi");
  const record = humanFixtureRecord(crypto.randomUUID(), 0);
  const retryAtMs = Date.now() + 60_000;
  for (const member of prepared.members.toReversed()) {
    const response = await boundaryRequest(leaveRoomContract.pathFor(prepared.room.id), {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${member.membership.token}` },
    });
    expect(response.status).toBe(204);
  }
  await runInDurableObject(prepared.stub, async (instance, state) => {
    expect(state.storage.kv.get("room")).toBeUndefined();
    state.storage.kv.put(pendingMatchPrefix + record.id, {
      record,
      retryAtMs,
    } satisfies PendingMatch);
    await instance.alarm();
    expect(await state.storage.getAlarm()).toBe(retryAtMs);
    state.storage.kv.delete(pendingMatchPrefix + record.id);
    await instance.alarm();
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

for (const game of ["four-reversi", "four-shogi"] satisfies GameId[]) {
  test.each(["着手", "投了"])(
    `${game}: 保存期限後の%sは既存のエラーを返し、時間切れを一度だけ確定する`,
    async (operation) => {
      const prepared = await start(game);
      const playing = prepared.room;
      const current = isFourShogiRoom(playing)
        ? playing.players.find((player) => player.side === playing.game.turn)
        : playing.players.find((player) => player.color === playing.game.turn);
      const index = prepared.members.findIndex(
        (entry) => entry.membership.playerId === current?.id,
      );
      if (index < 0) throw new Error("Missing current player");
      await runInDurableObject(prepared.stub, (_instance, state) => {
        state.storage.kv.put(
          "room",
          roomSchema.parse({
            ...playing,
            clock: { ...playing.clock, turnExpiresAt: Date.now() - 1 },
          }),
        );
      });
      if (operation === "投了") prepared.clients[index].send({ type: "room.game.resign" });
      else if (isFourShogiRoom(playing)) {
        const action = playing.legalActions[0];
        if (!action) throw new Error("Missing action");
        prepared.clients[index].send({
          type: "room.game.action",
          action,
          roundId: playing.roundId,
          positionRevision: playing.positionRevision,
        });
      } else
        prepared.clients[index].send({
          type: "room.game.action",
          action: { type: "placeStone", position: { x: 0, y: 0 } },
        });
      expect((await prepared.clients[index].waitFor("room.error")).error).toBe(
        game === "four-shogi" && operation === "着手" ? "stale_position" : "already_eliminated",
      );
      const result = (await snapshot(playing.id)).room;
      if (result.status !== "playing") throw new Error("Ended early");
      if (isFourShogiRoom(result)) {
        expect(result.positionRevision).toBe(1);
        expect(result.game.eliminations).toMatchObject([
          { side: playing.game.turn, reason: "timeout" },
        ]);
      } else expect(result.eliminations).toEqual([{ color: playing.game.turn, reason: "timeout" }]);
      expect(result.game.moveNumber).toBe(0);
    },
  );
}

test.each(["リバーシCPU待ち", "将棋CPU待ち", "将棋の保存済み選択"])(
  "Alarm候補: %s の時刻を使う",
  async (source) => {
    const game = source === "リバーシCPU待ち" ? "four-reversi" : "four-shogi";
    const prepared = await start(game, true);
    const at = Date.now() + 60_000;
    await runInDurableObject(prepared.stub, async (instance, state) => {
      const room = roomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      if (isFourShogiRoom(room)) {
        const cpu = room.players.find((player) => player.kind === "cpu");
        if (!cpu) throw new Error("No CPU");
        const store = new ShogiStore(state.storage.sql);
        const full = store.loadState(room.roundId, room.game);
        if (full.status !== "playing") throw new Error("Not playing");
        const next = { ...full, turn: cpu.side };
        const actions = getLegalActions(next);
        state.storage.kv.put(
          "room",
          fourShogiRoomSchema.parse({
            ...room,
            game: store.saveState(room.roundId, next),
            legalActions: actions,
            clock: { ...room.clock, turnStartedAt: at, turnExpiresAt: at + 300_000 },
          }),
        );
        state.storage.kv.delete("shogi-cpu-job");
        if (source === "将棋の保存済み選択") {
          const action = actions[0];
          if (!action) throw new Error("No action");
          state.storage.kv.put("shogi-cpu-job", {
            roundId: room.roundId,
            positionRevision: room.positionRevision,
            side: cpu.side,
            action,
            applyAt: at + 1_000,
          } satisfies SavedCpuJob);
        }
      } else {
        const cpu = room.players.find((player) => player.kind === "cpu");
        if (!cpu) throw new Error("No CPU");
        state.storage.kv.put(
          "room",
          roomSchema.parse({
            ...room,
            game: { ...room.game, turn: cpu.color },
            clock: { ...room.clock, turnStartedAt: at, turnExpiresAt: at + 300_000 },
          }),
        );
      }
      await instance.getRoom();
      expect(await state.storage.getAlarm()).toBe(
        at + (source === "将棋の保存済み選択" ? 1_000 : 500),
      );
    });
  },
);

for (const game of ["four-reversi", "four-shogi"] satisfies GameId[]) {
  test(`${game}: 通常GETでのCPU進行はゲーム別の手順を維持する`, async () => {
    const prepared = await start(game, true);
    const before = await runInDurableObject(prepared.stub, async (_instance, state) => {
      const room = roomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      const cpu = room.players.find((player) => player.kind === "cpu");
      if (!cpu) throw new Error("Missing CPU");
      let next;
      if (isFourShogiRoom(room)) {
        if (!("side" in cpu)) throw new Error("Wrong CPU");
        const store = new ShogiStore(state.storage.sql);
        const full = store.loadState(room.roundId, room.game);
        if (full.status !== "playing") throw new Error("Not playing");
        const position = { ...full, turn: cpu.side };
        next = roomSchema.parse({
          ...room,
          game: store.saveState(room.roundId, position),
          legalActions: getLegalActions(position),
        });
      } else {
        if (!("color" in cpu)) throw new Error("Wrong CPU");
        next = roomSchema.parse({ ...room, game: { ...room.game, turn: cpu.color } });
      }
      const saved = roomSchema.parse({
        ...next,
        clock: {
          ...room.clock,
          turnStartedAt: Date.now() - 1_000,
          turnExpiresAt: Date.now() + 300_000,
        },
      });
      state.storage.kv.put("room", saved);
      await state.storage.setAlarm(Date.now() + 60_000);
      return saved;
    });
    const response = await snapshot(prepared.room.id);
    if (game === "four-shogi") {
      expect(response.room.game).toEqual(before.game);
      await runInDurableObject(prepared.stub, (_instance, state) => {
        expect(state.storage.kv.get("shogi-cpu-job")).toBeUndefined();
      });
    } else {
      expect(response.room.game).not.toEqual(before.game);
    }
  });
}

test.each(["four-reversi", "four-shogi"] as const)(
  "%s: 同じ資格の複数接続は最後の切断まで復帰期限を付けない",
  async (game) => {
    const prepared = await start(game);
    const second = await connect(prepared.members[0]);
    prepared.clients[0].close();
    const connected = await snapshot(prepared.room.id);
    expect(connected.presence.connectedPlayerIds).toContain(
      prepared.members[0].membership.playerId,
    );
    expect(
      connected.room.players.find((p) => p.id === prepared.members[0].membership.playerId)
        ?.reconnectDeadline,
    ).toBeNull();
    second.close();
    const message = await prepared.clients[1].waitFor(
      "room.snapshot",
      (event) =>
        !event.presence.connectedPlayerIds.includes(prepared.members[0].membership.playerId),
    );
    expect(
      message.room.players.find((p) => p.id === prepared.members[0].membership.playerId)
        ?.reconnectDeadline,
    ).toBeTypeOf("number");
  },
);

test("将棋: 活動停止は期限処理・CPUより先に閉鎖する", async () => {
  const prepared = await start("four-shogi", true);
  await runInDurableObject(prepared.stub, (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put(
      "room",
      roomSchema.parse({ ...room, lastActivityAtMs: Date.now() - 86_400_001 }),
    );
  });
  expect((await boundaryRequest(getRoomContract.pathFor(prepared.room.id))).status).toBe(404);
  await runInDurableObject(prepared.stub, (_instance, state) => {
    expect(state.storage.kv.get("shogi-cpu-job")).toBeUndefined();
    expect([...state.storage.kv.list({ prefix: pendingShogiMatchPrefix })]).toEqual([]);
  });
});

test("将棋: 再戦待機へ移行しても切断からの元の復帰期限を保持する", async () => {
  const prepared = await start("four-shogi");
  const disconnectedId = prepared.members[3].membership.playerId;
  prepared.clients[3].close();
  const disconnected = await prepared.clients[0].waitFor(
    "room.snapshot",
    (message) => !message.presence.connectedPlayerIds.includes(disconnectedId),
  );
  const deadline = disconnected.room.players.find(
    (player) => player.id === disconnectedId,
  )?.reconnectDeadline;
  expect(deadline).toBeTypeOf("number");
  for (const member of prepared.members.slice(0, 3)) {
    const response = await boundaryRequest(leaveRoomContract.pathFor(prepared.room.id), {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${member.membership.token}` },
    });
    expect(response.status).toBe(204);
  }
  const waiting = await snapshot(prepared.room.id);
  expect(waiting.room.status).toBe("waiting");
  expect(waiting.room.players.map((player) => player.id)).toEqual([disconnectedId]);
  expect(waiting.room.players[0].reconnectDeadline).toBe(deadline);
  expect(waiting.room.players[0].ready).toBe(false);
  await connect(prepared.members[3]);
  const restored = await snapshot(prepared.room.id);
  expect(restored.room.players[0].reconnectDeadline).toBeNull();
});

for (const game of ["four-reversi", "four-shogi"] satisfies GameId[]) {
  test(`${game}: 抽出した進行・終局のKVとSQLite更新はtransaction例外で全て戻る`, async () => {
    const prepared = await start(game);
    await runInDurableObject(prepared.stub, (_instance, state) => {
      const capture = () => ({
        kv: [...state.storage.kv.list()],
        sql:
          game === "four-shogi"
            ? {
                repetitions: state.storage.sql
                  .exec("SELECT * FROM shogi_repetitions ORDER BY round_id, position_key")
                  .toArray(),
                rounds: state.storage.sql
                  .exec("SELECT * FROM shogi_rounds ORDER BY round_id")
                  .toArray(),
                events: state.storage.sql
                  .exec("SELECT * FROM shogi_events ORDER BY round_id, event_index")
                  .toArray(),
                archives: state.storage.sql
                  .exec("SELECT * FROM shogi_archives ORDER BY round_id")
                  .toArray(),
              }
            : null,
      });
      const before = capture();
      const dependencies = {
        storage: state.storage,
        membership: (hash: string) => {
          const value = state.storage.kv.get(`membership:${hash}`);
          return value === undefined ? null : roomMembershipSchema.parse(value);
        },
        accountId: (playerId: string) =>
          state.storage.kv.get<AccountAdmission>(`seat-account:${playerId}`)?.accountId ?? null,
      };
      expect(() =>
        state.storage.transactionSync(() => {
          let room = roomSchema.parse(state.storage.kv.get("room"));
          if (isFourShogiRoom(room)) {
            const progress = gameProgress["four-shogi"].create(dependencies);
            for (let count = 0; count < 3; count++) {
              if (room.status !== "playing") throw new Error("Expected playing room");
              const turn = room.game.turn;
              const player = room.players.find((entry) => entry.side === turn);
              if (!player) throw new Error("Missing player");
              const result = progress.eliminate(room, player.id, "timeout", Date.now());
              if (result.kind === "finished") {
                const lastRound = progress.finalize(result);
                expect(
                  state.storage.kv.get(pendingShogiMatchPrefix + result.room.roundId),
                ).toBeDefined();
                expect(progress.store().eventCount(result.room.roundId)).toBe(3);
                expect(
                  state.storage.sql.exec("SELECT * FROM shogi_archives").toArray(),
                ).toHaveLength(1);
                state.storage.kv.put(
                  "room",
                  progress.waiting({ ...result, lastRound }, result.room.players),
                );
              } else if (result.kind === "playing") {
                room = result.room;
                state.storage.kv.put("room", room);
              } else throw new Error("Unexpected transition");
            }
          } else {
            const progress = gameProgress["four-reversi"].create(dependencies);
            for (let count = 0; count < 3; count++) {
              if (room.status !== "playing") throw new Error("Expected playing room");
              const turn = room.game.turn;
              const player = room.players.find((entry) => entry.color === turn);
              if (!player) throw new Error("Missing player");
              const result = progress.eliminate(room, player.id, "timeout", Date.now());
              if (result.kind === "finished") {
                const lastRound = progress.finalize(result);
                expect(lastRound.replay?.steps).toHaveLength(3);
                expect([...state.storage.kv.list({ prefix: pendingMatchPrefix })]).toHaveLength(1);
                state.storage.kv.put(
                  "room",
                  progress.waiting({ ...result, lastRound }, result.room.players),
                );
              } else if (result.kind === "playing") {
                room = result.room;
                state.storage.kv.put("room", room);
              } else throw new Error("Unexpected transition");
            }
          }
          throw new Error("Rollback game transition");
        }),
      ).toThrow("Rollback game transition");
      expect(capture()).toEqual(before);
    });
    expect((await snapshot(prepared.room.id)).room).toEqual(prepared.room);
  });
}
