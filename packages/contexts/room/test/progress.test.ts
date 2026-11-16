import { expect, test } from "bun:test";
import {
  applyProgress,
  play,
  resign,
  declareShogi,
  setShogiDrawProposal,
  rematchPlayers,
  recordDeparture,
  closeIfNoHumanParticipants,
  closeRoom,
  releaseResultAvatars,
  type RoomOperation,
} from "../src";
import { MemoryPorts, finished, human, now, playing, waiting } from "./memoryPorts";

const operations: [string, (op: RoomOperation) => unknown][] = [
  [
    "play",
    (op) =>
      play(op, "host-token", {
        type: "room.game.action",
        action: { type: "placeStone", position: { x: 0, y: 0 } },
      }),
  ],
  ["resign", (op) => resign(op, "host-token")],
  [
    "declare",
    (op) =>
      declareShogi(op, "host-token", {
        type: "room.game.declare",
        roundId: "round",
        positionRevision: 1,
      }),
  ],
  [
    "draw",
    (op) =>
      setShogiDrawProposal(op, "host-token", {
        type: "room.game.draw.set",
        proposed: true,
        roundId: "round",
        positionRevision: 1,
      }),
  ],
];
test.each(operations)("%s は進行を保存し配信の効果を返す", (_, action) => {
  const m = new MemoryPorts();
  m.room = playing();
  const result = m.run(action);
  expect(result.value).toMatchObject({
    room: m.progress.kind === "playing" ? m.progress.room : null,
  });
  expect(m.calls).toEqual(["saveRoom"]);
  expect(result.effects).toEqual([{ type: "broadcastRoom", room: m.room! }]);
});

test.each(operations)("%s のルーム不在とゲームの拒否は保存と配信をしない", (_, action) => {
  const m = new MemoryPorts();
  m.room = null;
  expect(m.run(action)).toEqual({ value: { status: "not_found" }, effects: [] });
  m.room = playing();
  for (const error of [
    "unauthorized",
    "stale_position",
    "time_expired",
    "not_your_turn",
    "game_finished",
  ] as const) {
    m.progress = { kind: "rejected", error };
    expect(m.run(action)).toEqual({ value: { status: error }, effects: [] });
  }
  expect(m.calls).toEqual([]);
});

test("引分の同値は後処理も保存も呼ばず、変更後は後処理の終局まで適用する", () => {
  const m = new MemoryPorts();
  m.room = playing();
  m.progress = { kind: "unchanged", gameId: "reversi", room: m.room };
  const command = {
    type: "room.game.draw.set" as const,
    proposed: true,
    roundId: "round",
    positionRevision: 1,
  };
  expect(m.run((op) => setShogiDrawProposal(op, "host-token", command))).toEqual({
    value: { status: "unchanged", room: m.room },
    effects: [],
  });
  m.progress = { kind: "playing", gameId: "reversi", room: playing() };
  m.afterDrawResult = finished();
  const result = m.run((op) => setShogiDrawProposal(op, "host-token", command));
  expect(result.value.status).toBe("updated");
  expect(m.calls).toContain("finalize");
  expect(result.effects.map((e) => e.type)).toEqual(["usage", "chatChanged", "broadcastRoom"]);
});

test("終局は利用イベントの確定、棋譜保存待ち、席保持、待機生成の順を守る", () => {
  const m = new MemoryPorts();
  m.addGuest();
  m.room = playing();
  m.connections.delete("host-token");
  m.disconnected.set("host", now - 10_000);
  m.progress = finished();
  m.adapter.resign = () => {
    m.calls.push("transition");
    return m.progress;
  };
  m.state.clearDeparted = (id) => {
    m.calls.push(`retain:${id}`);
    m.departed.delete(id);
  };
  const result = m.run((op) => resign(op, "host-token"));
  expect(m.calls).toEqual([
    "transition",
    "finishTournament",
    "endUsage:completed",
    "finalize",
    "retain:host",
    "retain:guest",
    "waiting",
    "saveRoom",
  ]);
  expect(
    m.room?.players.map((p) => ({
      id: p.id,
      ready: p.ready,
      reconnectDeadline: p.reconnectDeadline,
    })),
  ).toEqual([
    { id: "host", ready: false, reconnectDeadline: now + 20_000 },
    { id: "guest", ready: false, reconnectDeadline: null },
  ]);
  expect(result.effects).toEqual([
    m.state.endMatchUsage("completed", now)[0],
    { type: "broadcastRoom", room: m.room! },
  ]);
});

test("終局の途中で例外になれば返せる効果はない", () => {
  const m = new MemoryPorts();
  m.addGuest();
  m.room = playing();
  m.failWaiting = true;
  m.progress = finished();
  expect(() => m.run((op) => resign(op, "host-token"))).toThrow("waiting failed");
  // 保存のロールバックは Worker の実 transaction のテストで確認します。
  expect(m.calls).not.toContain("saveRoom");
});

test("進行の unchanged と playing は元のルームを返し、rejected は例外にする", () => {
  const m = new MemoryPorts();
  for (const kind of ["unchanged", "playing"] as const) {
    const room = playing();
    expect(m.run((op) => applyProgress(op, { kind, gameId: "reversi", room }))).toEqual({
      value: room,
      effects: [],
    });
  }
  expect(() =>
    m.run((op) => applyProgress(op, { kind: "rejected", error: "unauthorized" })),
  ).toThrow("Rejected progress: unauthorized");
});

test("再戦は期限切れを除き、結果表示の画像を保持して資格を解放しホストを交代する", () => {
  const m = new MemoryPorts();
  m.addGuest();
  m.room = playing();
  m.connections.delete("host-token");
  m.disconnected.set("host", now - 30_000);
  const result = m.run((op) => rematchPlayers(op, playing().players, now));
  expect(result.value?.map((p) => p.id)).toEqual(["guest"]);
  expect(m.released).toEqual([["host", false]]);
  expect(m.memberships.has("host-token")).toBe(false);
  expect(m.memberships.get("guest-token")?.role).toBe("host");
  expect(result.effects).toEqual([{ type: "chatChanged" }]);
});

test("再戦の復帰期限は期限の1ms前まで保持し、退会・退室済みの席は除く", () => {
  const m = new MemoryPorts();
  m.addGuest();
  m.room = playing();
  m.connections.delete("guest-token");
  m.disconnected.set("guest", now - 29_999);
  const retained = m.run((op) => rematchPlayers(op, playing().players, now)).value!;
  expect(retained[1].reconnectDeadline).toBe(now + 1);
  m.departed.add("guest");
  expect(m.run((op) => rematchPlayers(op, playing().players, now)).value?.map((p) => p.id)).toEqual(
    ["host"],
  );
});

test("再戦に人間がいなければ閉鎖し、退出ログは進行中に一度だけ記録する", () => {
  const m = new MemoryPorts();
  m.room = playing();
  const departure = m.run((op) => {
    recordDeparture(op, playing().players[0]);
    recordDeparture(op, playing().players[0]);
  });
  expect(m.chat).toHaveLength(1);
  expect(departure.effects).toEqual([{ type: "chatChanged" }]);
  m.connections.clear();
  m.disconnected.clear();
  expect(m.run((op) => rematchPlayers(op, playing().players, now)).value).toBeNull();
  expect(m.room).toBeNull();
});

test("人間不在でもCPUの継続方針があれば保持し、それ以外は閉鎖する", () => {
  const m = new MemoryPorts();
  m.tokens.clear();
  m.keepWithoutHumans = true;
  const room = m.room!;
  expect(m.run((op) => closeIfNoHumanParticipants(op, room)).value).toBe(room);
  m.keepWithoutHumans = false;
  expect(m.run((op) => closeIfNoHumanParticipants(op, room)).value).toBeNull();
  expect(m.room).toBeNull();
  expect(m.run((op) => closeIfNoHumanParticipants(op, null))).toEqual({ value: null, effects: [] });
});

test("閉鎖は予約、前局画像、利用イベント、本人席、状態、ゲームの順で掃除する", () => {
  const m = new MemoryPorts();
  const previous = human("previous");
  m.room = {
    ...waiting(),
    lastRound: { ...finished(), players: [previous] },
  } as unknown as typeof m.room;
  const result = m.run(closeRoom);
  expect(m.calls).toEqual([
    "closeReservations",
    "release:previous:true",
    "endUsage:abandoned",
    "deleteIdentity:host",
    "release:host:true",
    "clearRoom",
    "closeGame",
  ]);
  expect(m.memberships.size).toBe(0);
  expect(m.tokens.size).toBe(0);
  expect(m.room).toBeNull();
  expect(result.effects.map((e) => e.type)).toEqual(["usage"]);
});

test("前局の画像参照は引き継ぐ人だけ残す", () => {
  const m = new MemoryPorts();
  const room = {
    ...waiting(),
    lastRound: { players: [human("retained"), human("removed")] },
  } as unknown as ReturnType<typeof waiting>;
  expect(m.run((op) => releaseResultAvatars(op, room, new Set(["retained"]))).effects).toEqual([]);
  expect(m.released).toEqual([["removed", true]]);
});
