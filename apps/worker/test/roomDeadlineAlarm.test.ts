import { isReversiRoom, isShogiRoom } from "@tetraboard/protocol";
import { humanFixtureRecord } from "./matchFixtures";
import { humanShogiRecord } from "./shogiMatchFixtures";
import { pendingMatchPrefix, type PendingMatch } from "../src/rooms/matchStore";
import { pendingShogiMatchPrefix, type PendingShogiMatch } from "../src/rooms/shogiMatchStore";
import { analyticsActiveKey, type AnalyticsMatch } from "../src/usageEvents/matches";
import type { PendingRoomIndex } from "../src/adapters/room/roomIndexWrite";
import type { AccountAdmission } from "../src/flows/accountSeats/types";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import {
  getRoomContract,
  leaveRoomContract,
  isFourShogiRoom,
  fourShogiRoomSchema,
} from "@tetraboard/protocol";
import { getLegalActions } from "@tetraboard/four-shogi";
import { ShogiStore } from "../src/rooms/shogiStore";
import { boundaryRequest } from "./roomBoundaryFixtures";
import { origin } from "./accountFixtures";
import {
  registerRoomDeadlineBoundaryFixtures,
  start,
  roomSchema,
  type SavedCpuJob,
} from "./roomDeadlineBoundaryFixtures";

registerRoomDeadlineBoundaryFixtures();

// 保存待ちは実際の保存型で作り、将来の期限なので外部サービスを失敗させずに候補を検証する。
test.each(["時計", "復帰", "活動停止", "索引", "席解放", "リバーシ保存", "将棋保存"])(
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
      for (const prefix of [pendingMatchPrefix, pendingShogiMatchPrefix])
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

test.each(["リバーシCPU待ち", "将棋CPU待ち", "将棋の保存済み選択"])(
  "Alarm候補: %s の時刻を使う",
  async (source) => {
    const game = source === "リバーシCPU待ち" ? "four-reversi" : "four-shogi";
    const prepared = await start(game, true);
    const at = Date.now() + 60_000;
    await runInDurableObject(prepared.stub, async (instance, state) => {
      const room = roomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      if (isReversiRoom(room) || isShogiRoom(room)) throw Error("Expected existing game fixture");
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
      expect(await state.storage.getAlarm()).toBe(at + 2_000);
    });
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
