import { expect, test } from "bun:test";
import {
  join,
  leaveAccount,
  purgeAccount,
  tick,
  status,
  control,
  takeover,
  cleanupReleasedGroups,
  previousRoom,
} from "../src";
import { MemoryMatchmaking } from "./memory";
import { policies } from "./policies";

async function enter(m: MemoryMatchmaking, id: string) {
  m.account(id);
  return join(m.r, m.state, id, `search-${id}`, `tab-${id}`);
}

test("参加と同じ操作の再送は待機開始・採番を保ち、別の操作は拒否する", async () => {
  const m = new MemoryMatchmaking();
  expect(await enter(m, "a")).toEqual({
    ok: true,
    state: {
      status: "waiting",
      serverNowMs: 100_000,
      operationId: "search-a",
      controllerId: "tab-a",
      version: 1,
      joinedAtMs: 100_000,
      expiresAtMs: 145_000,
    },
  });
  m.now = 101_000;
  expect(await join(m.r, m.state, "a", "search-a", "tab-a")).toMatchObject({
    ok: true,
    state: { joinedAtMs: 100_000, expiresAtMs: 145_000 },
  });
  expect(await join(m.r, m.state, "a", "new-search", "tab-a")).toEqual({
    ok: false,
    message: "別のタブやルームで対局または待機中です。",
  });
  expect(m.state.nextSequence).toBe(1);
  expect(m.events).toEqual([{ operationId: "search-a", stage: "accepted", reason: null }]);
});

test("4人揃った参加で1部屋が成立し、資格・席・応答に元の情報を渡す", async () => {
  const m = new MemoryMatchmaking();
  for (const id of ["a", "b", "c", "d"]) await enter(m, id);
  expect(m.state.waiting).toEqual([]);
  expect(m.state.groups).toHaveLength(1);
  expect([...m.rooms.values()][0]).toEqual({
    game: "four-reversi",
    matchId: "id-1",
    roomId: "00002",
    instanceId: "id-3",
    preparedAtMs: 100_000,
    expiresAtMs: 130_000,
    players: ["a", "b", "c", "d"].map((id, i) => ({
      admission: {
        accountId: id,
        operationId: `id-1:${id}`,
        roomId: "00002",
        instanceId: "id-3",
        playerId: `id-${4 + i}`,
        name: id,
        avatarKey: null,
        avatarPresetId: null,
      },
      tokenHash: `hash:search-${id}:1`,
      version: 1,
      search: { operationId: `search-${id}`, joinedAtMs: 100_000, isTest: false },
    })),
  });
  expect(await status(m.r, m.state, "a", "tab-a")).toMatchObject({
    status: "matched",
    assignment: { membership: { playerId: "id-4", token: "token:search-a:1", role: "host" } },
  });
  expect(await previousRoom(m.state, "a", "id-1")).toEqual({ roomId: "00002", instanceId: "id-3" });
  expect(await previousRoom(m.state, "outsider", "id-1")).toBeNull();
});

test("状態参照では割り当てず、旧列の30秒到達のtickだけが不足席を補充する", async () => {
  const m = new MemoryMatchmaking();
  await enter(m, "a");
  m.now = 129_999;
  await tick(m.r, m.state);
  expect(m.rooms.size).toBe(0);
  m.now = 130_000;
  expect((await status(m.r, m.state, "a", "tab-a")).status).toBe("waiting");
  expect(m.rooms.size).toBe(0);
  await tick(m.r, m.state);
  expect([...m.rooms.values()].map((room) => room.players.length)).toEqual([1]);
  expect(m.state.groups[0]!.phase).toBe("matched");
});

test("退出・取消の後には旧操作を復活させず、新しい操作では再参加できる", async () => {
  const m = new MemoryMatchmaking();
  await enter(m, "a");
  await leaveAccount(m.r, m.state, "a");
  expect(m.state.waiting).toEqual([]);
  expect(m.leases.size).toBe(0);
  expect(await join(m.r, m.state, "a", "search-a", "tab-a")).toEqual({
    ok: false,
    message: "この待機は終了しています。もう一度操作してください。",
  });
  expect(await join(m.r, m.state, "a", "new", "tab-a")).toMatchObject({ ok: true });
  expect(
    await control(
      m.r,
      m.state,
      "a",
      { operationId: "new", controllerId: "tab-a", version: 1 },
      "cancel",
    ),
  ).toMatchObject({ ok: true, state: { status: "idle" } });
});

test("heartbeatは開始時刻を変えず期限だけ更新し、引き継ぎ後の旧操作元を拒否する", async () => {
  const m = new MemoryMatchmaking();
  await enter(m, "a");
  m.now = 110_000;
  expect(
    await control(
      m.r,
      m.state,
      "a",
      { operationId: "search-a", controllerId: "tab-a", version: 1 },
      "heartbeat",
    ),
  ).toMatchObject({ ok: true, state: { joinedAtMs: 100_000, expiresAtMs: 155_000 } });
  expect(await takeover(m.r, m.state, "a", "search-a", "tab-new", 1)).toMatchObject({
    ok: true,
    state: { version: 2, controllerId: "tab-new" },
  });
  expect(
    await control(
      m.r,
      m.state,
      "a",
      { operationId: "search-a", controllerId: "tab-a", version: 1 },
      "cancel",
    ),
  ).toEqual({ ok: false, message: "待機の操作元が変わったか、有効期限が切れました。" });
});

test("退会消去は待機と未開始の組を解放し、残る参加者を元の順序へ戻す", async () => {
  const m = new MemoryMatchmaking();
  for (const id of ["a", "b", "c", "d"]) await enter(m, id);
  await purgeAccount(m.r, m.state, "a");
  expect(m.state.groups).toEqual([]);
  expect(m.state.waiting.map((w) => [w.accountId, w.sequence, w.joinedAtMs])).toEqual([
    ["b", 2, 100_000],
    ["c", 3, 100_000],
    ["d", 4, 100_000],
  ]);
  expect(m.seats.size).toBe(0);
  expect(m.ended.has("search-a")).toBe(true);
  await purgeAccount(m.r, m.state, "b");
  expect(m.state.waiting.map((w) => w.accountId)).toEqual(["c", "d"]);
});

test("対局中の退会消去は他の参加者の割当を保持し、解放済みの組を掃除する", async () => {
  const m = new MemoryMatchmaking();
  for (const id of ["a", "b", "c", "d"]) await enter(m, id);
  m.state.groups[0]!.phase = "playing";
  await leaveAccount(m.r, m.state, "a");
  expect(m.state.groups[0]!.players).toHaveLength(4);
  await purgeAccount(m.r, m.state, "a");
  expect(m.state.groups[0]!.players.map((p) => p.accountId)).toEqual(["b", "c", "d"]);
  m.seats.clear();
  await cleanupReleasedGroups(m.r, m.state);
  expect(m.state.groups).toEqual([]);
  expect([...m.ended].sort()).toEqual(["search-b", "search-c", "search-d"]);
});

test("レートの読み取りを待機に反映し、前局が保存待ちになった旧待機を除く", async () => {
  const m = new MemoryMatchmaking();
  m.r.legacy = false;
  m.r.ratingPolicy = policies["four-reversi"];
  m.r.queueRules.fillAfterMs = 20_000;
  m.latest.set("a", { rating_after: 28, sigma_after: 2, rated_games: 12 });
  await enter(m, "a");
  expect(m.state.waiting[0]).toMatchObject({ rating: 28, sigma: 2, ratedGames: 12 });
  expect(await status(m.r, m.state, "a", "tab-a")).toMatchObject({
    waitingCount: 13,
    estimatedMatchAtMs: 120_000,
  });
  expect(await status(m.r, m.state, "a", "another-tab")).not.toHaveProperty("estimatedMatchAtMs");
  m.pending.add("a");
  await tick(m.r, m.state);
  expect(m.state.waiting).toEqual([]);
  expect(m.events.at(-1)).toEqual({
    operationId: "search-a",
    stage: "failed",
    reason: "invalidated",
  });
});

test("CPU枠待ちは開始時刻とleaseを保って2秒後に再試行し、成立後の取消は割当を保持する", async () => {
  const m = new MemoryMatchmaking();
  m.r.legacy = false;
  m.r.ratingPolicy = policies["four-reversi"];
  m.r.queueRules.fillAfterMs = 20_000;
  m.prepareResult = "cpu_capacity_full";
  await enter(m, "a");
  m.now = 120_000;
  await tick(m.r, m.state);
  expect(m.state.waiting[0]).toMatchObject({ joinedAtMs: 100_000, expiresAtMs: 145_000 });
  expect(m.state.cpuRetryAtMs).toBe(122_000);
  expect(m.rooms.size).toBe(0);
  m.prepareResult = "prepared";
  m.now = 121_999;
  await tick(m.r, m.state);
  expect(m.rooms.size).toBe(0);
  m.now++;
  await tick(m.r, m.state);
  expect(m.rooms.size).toBe(1);
  expect(m.state.cpuRetryAtMs).toBeUndefined();
  expect(
    await control(
      m.r,
      m.state,
      "a",
      { operationId: "search-a", controllerId: "tab-a", version: 1 },
      "cancel",
    ),
  ).toMatchObject({ ok: true, state: { status: "matched" } });
});
