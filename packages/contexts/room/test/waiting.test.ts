import { expect, test } from "bun:test";
import {
  createRoom,
  joinRoom,
  removeWaitingPlayer,
  setReady,
  setTimeControl,
  applySettings,
  updateGameSettings,
  prepareStart,
  startGame,
  type RoomAdmission,
} from "../src";
import { MemoryPorts, human, now, waiting, playing } from "./memoryPorts";

const admission: RoomAdmission = {
  instanceId: "instance",
  playerId: "host",
  name: "host",
  avatarUrl: null,
};
test("作成は本人資格と復帰期限、入室ログを保存する", () => {
  const m = new MemoryPorts();
  m.room = null;
  const outcome = m.run((op) => createRoom(op, waiting(), "host-token", "secret", admission));
  // 作成済みの資格がある場合も、新規ルームを作りません。
  expect(outcome.value).toBeNull();
  m.memberships.clear();
  const created = m.run((op) => createRoom(op, waiting(), "host-token", "secret", admission));
  expect(created.value?.players[0].reconnectDeadline).toBe(now + 30_000);
  expect(m.memberships.get("host-token")).toEqual({ playerId: "host", role: "host" });
  expect(m.disconnected.get("host")).toBe(now);
  expect(m.calls).toContain("admit:host");
  expect(m.chat).toEqual([{ event: "joined", text: "hostが入室しました", at: now }]);
  expect(created.effects).toEqual([{ type: "chatChanged" }]);
  expect(m.run((op) => createRoom(op, waiting(), "other", "secret")).value).toBeNull();
});

test("作成の入場資格がホストと一致しなければ拒否する", () => {
  const m = new MemoryPorts();
  m.room = null;
  m.memberships.clear();
  expect(() =>
    m.run((op) => createRoom(op, waiting(), "hash", "secret", { ...admission, name: "other" })),
  ).toThrow("Admission does not match host");
  expect(m.room).toBeNull();
  expect(m.chat).toEqual([]);
});

test("参加は設定した席を使い、ログの後に配信を返す", () => {
  const m = new MemoryPorts();
  const result = m.run((op) => joinRoom(op, "guest", "guest-token", "guest", "instance"));
  expect(result.value).toMatchObject({
    status: "joined",
    membership: { playerId: "guest", role: "player" },
  });
  expect(m.room?.players[1]).toEqual({ ...human("guest"), reconnectDeadline: now + 30_000 });
  expect(result.effects).toEqual([
    { type: "chatChanged" },
    { type: "broadcastRoom", room: m.room! },
  ]);
  expect(m.run((op) => joinRoom(op, "third", "third-token", "third")).value).toEqual({
    status: "room_full",
  });
});

test.each([
  "not_found",
  "room_changed",
  "matchmaking_required",
  "tournament_required",
  "room_started",
] as const)("参加の拒否: %s", (status) => {
  const m = new MemoryPorts();
  if (status === "not_found") m.room = null;
  if (status === "room_changed") m.room = { ...waiting(), instanceId: "other" };
  if (status === "matchmaking_required")
    m.room = { ...waiting(), matchmaking: { id: "match", preparedAtMs: 1, opponent: "human" } };
  if (status === "tournament_required")
    m.room = {
      ...waiting(),
      settings: {
        game: "four-reversi",
        mode: "singles",
        timeControl: waiting().settings.timeControl,
      },
      lastRound: null,
      matchmaking: undefined,
      tournamentId: 1,
    };
  if (status === "room_started") m.room = playing();
  expect(m.run((op) => joinRoom(op, "guest", "hash", "guest", "instance"))).toEqual({
    value: { status },
    effects: [],
  });
});

test("参加のトークン衝突と不一致の入場資格は保存前に拒否する", () => {
  const m = new MemoryPorts();
  expect(() => m.run((op) => joinRoom(op, "guest", "host-token", "guest"))).toThrow(
    "Membership token collision",
  );
  expect(() => m.run((op) => joinRoom(op, "guest", "hash", "guest", undefined, admission))).toThrow(
    "Admission does not match room",
  );
  expect(m.room?.players).toHaveLength(1);
});

test("待機のホスト退室は人間を先頭へ移し資格を昇格する", () => {
  const m = new MemoryPorts();
  m.addGuest();
  const result = m.run((op) =>
    removeWaitingPlayer(op, m.room as ReturnType<typeof waiting>, "host"),
  );
  expect(result.value?.players.map((p) => p.id)).toEqual(["guest"]);
  expect(m.memberships.get("guest-token")?.role).toBe("host");
  expect(m.memberships.has("host-token")).toBe(false);
  expect(m.released).toEqual([["host", true]]);
  expect(result.effects).toEqual([{ type: "chatChanged" }]);
});

test("最後の人間の待機退室はルームを閉じる", () => {
  const m = new MemoryPorts();
  expect(m.run((op) => removeWaitingPlayer(op, waiting(), "host")).value).toBeNull();
  expect(m.room).toBeNull();
  expect(m.calls).toContain("closeGame");
});

test("準備は本人だけ更新し、同値なら効果を返さない", () => {
  const m = new MemoryPorts();
  const result = m.run((op) => setReady(op, "host-token", true));
  expect(result.value.status).toBe("updated");
  expect(m.room?.players[0].ready).toBe(true);
  expect(result.effects).toEqual([{ type: "broadcastRoom", room: m.room! }]);
  expect(m.run((op) => setReady(op, "host-token", true))).toEqual({
    value: { status: "unchanged" },
    effects: [],
  });
});

test.each(["not_found", "already_started", "unauthorized", "registration_pending"] as const)(
  "準備の拒否: %s",
  (status) => {
    const m = new MemoryPorts();
    if (status === "not_found") m.room = null;
    if (status === "already_started") m.room = playing();
    if (status === "unauthorized") m.memberships.clear();
    if (status === "registration_pending") m.registrations.add("host");
    expect(m.run((op) => setReady(op, "host-token", true))).toEqual({
      value: { status },
      effects: [],
    });
  },
);

test("持ち時間変更は人間の準備を解除し公開版を単調に更新する", () => {
  const m = new MemoryPorts();
  m.room!.players[0].ready = true;
  m.room!.publicUpdatedAtMs = now + 1;
  const control = { mainTimeMs: 0, byoyomiMs: 30_000 } as const;
  const outcome = m.run((op) => setTimeControl(op, "host-token", control));
  expect(outcome.value.status).toBe("updated");
  expect(m.room).toMatchObject({
    publicUpdatedAtMs: now + 2,
    lastActivityAtMs: now,
    settings: { timeControl: control },
  });
  expect(m.room?.players[0].ready).toBe(false);
  expect(outcome.effects).toEqual([{ type: "broadcastRoom", room: m.room! }]);
  expect(m.run((op) => setTimeControl(op, "host-token", control)).value.status).toBe("unchanged");
});

test.each(["not_found", "already_started", "forbidden"] as const)(
  "持ち時間の拒否: %s",
  (status) => {
    const m = new MemoryPorts();
    if (status === "not_found") m.room = null;
    if (status === "already_started") m.room = playing();
    if (status === "forbidden") m.memberships.clear();
    expect(
      m.run((op) => setTimeControl(op, "host-token", { mainTimeMs: 0, byoyomiMs: 30_000 })),
    ).toEqual({ value: { status }, effects: [] });
  },
);

const command = {
  type: "room.settings.apply" as const,
  expectedPublicUpdatedAtMs: 10,
  timeControl: { mainTimeMs: 60_000 as const, byoyomiMs: 0 as const },
  cpus: [],
};
test.each([
  "invalid_request",
  "room_full",
  "room_changed",
  "cpu_not_found",
  "already_started",
  "unchanged",
] as const)("全設定のゲーム検証結果をそのまま返す: %s", (status) => {
  const m = new MemoryPorts();
  m.settingsResult = { status };
  expect(m.run((op) => applySettings(op, "host-token", command))).toEqual({
    value: { status },
    effects: [],
  });
});

test("全設定は権限を先に確認し、CPU削除と追加ログを順に保存する", () => {
  const m = new MemoryPorts();
  expect(m.run((op) => applySettings(op, "other", command)).value).toEqual({ status: "forbidden" });
  const old = {
    id: "old",
    name: "CPU 1",
    kind: "cpu" as const,
    level: 1 as const,
    ready: true as const,
    color: null,
    reconnectDeadline: null,
  };
  m.room = { ...waiting(), players: [human("host"), old] };
  m.settingsResult = {
    status: "updated",
    room: { ...waiting(), players: [human("host"), { ...old, id: "new", level: 2 }] },
  };
  const result = m.run((op) => applySettings(op, "host-token", command));
  expect(m.chat.map((x) => x.text)).toEqual(["CPU Lv1が退室しました", "CPU Lv2が入室しました"]);
  expect(result.effects.map((e) => e.type)).toEqual([
    "chatChanged",
    "chatChanged",
    "broadcastRoom",
  ]);
  expect(m.room === m.settingsResult.room).toBe(true);
});

test("個別設定の成功を保存して配信し、失敗は保存しない", () => {
  const m = new MemoryPorts();
  m.settingsResult = { status: "updated", room: { ...waiting(), lastActivityAtMs: now } };
  expect(
    m.run((op) => updateGameSettings(op, "host-token", { type: "room.cpu.add", level: 1 })).effects,
  ).toEqual([{ type: "broadcastRoom", room: m.settingsResult.room }]);
  m.calls = [];
  m.settingsResult = { status: "forbidden" };
  expect(
    m.run((op) => updateGameSettings(op, "other", { type: "room.cpu.add", level: 1 })),
  ).toEqual({ value: { status: "forbidden" }, effects: [] });
  expect(m.calls).toEqual([]);
});

test.each([
  "not_found",
  "already_started",
  "unauthorized",
  "forbidden",
  "registration_pending",
  "not_ready",
] as const)("開始の拒否: %s", (status) => {
  const m = new MemoryPorts();
  if (status === "not_found") m.room = null;
  if (status === "already_started") m.room = playing();
  if (status === "unauthorized") m.memberships.clear();
  if (status === "forbidden") m.memberships.set("host-token", { playerId: "host", role: "player" });
  if (status === "registration_pending") m.registrations.add("host");
  expect(m.run((op) => prepareStart(op, "host-token"))).toEqual({ value: { status }, effects: [] });
});

test("開始は人数・準備・接続を確認し、開始保存後に利用イベントと配信を返す", () => {
  const m = new MemoryPorts();
  m.addGuest();
  for (const p of m.room!.players) p.ready = true;
  m.connections.delete("guest-token");
  expect(m.run((op) => prepareStart(op, "host-token")).value.status).toBe("not_ready");
  m.connections.add("guest-token");
  const prepared = m.run((op) => prepareStart(op, "host-token")).value;
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") throw new Error("Expected ready");
  const result = m.run((op) => startGame(op, prepared.room));
  expect(result.value.status).toBe("started");
  expect(m.calls).toEqual(["start", "saveRoom", "startUsage"]);
  expect(result.effects.map((e) => e.type)).toEqual(["usage", "broadcastRoom"]);
});
