import { expect, test } from "bun:test";
import { isFourShogiRoom, matchmakingRules, tournamentRules } from "@tetraboard/protocol";
import { nextRoomAlarmAt, type RoomAlarmInput } from "../src/adapters/room/roomAlarm";
import { roomFixture } from "./roomStateFixtures";

type Retry = { retryAtMs: number };
type Retries = {
  capacity?: { releaseAtMs: number | null };
  index?: Retry;
  accountCleanups?: Retry[];
  matches?: Retry[];
  shogiMatches?: Retry[];
  guestClaims?: Retry;
  tournamentStates?: Retry[];
};
function input(overrides: Partial<RoomAlarmInput> & Retries = {}): RoomAlarmInput {
  const {
    capacity,
    index,
    accountCleanups = [],
    matches = [],
    shogiMatches = [],
    guestClaims,
    tournamentStates = [],
    ...rest
  } = overrides;
  return {
    room: null,
    registrations: new Map(),
    usesIdleDeadline: false,
    cpuAlarmAt: null,
    jobs: [
      capacity?.releaseAtMs ?? null,
      ...[
        index,
        guestClaims,
        ...accountCleanups,
        ...matches,
        ...shogiMatches,
        ...tournamentStates,
      ].map((job) => job?.retryAtMs ?? null),
    ],
    tournament: null,
    matchmaking: undefined,
    ...rest,
  };
}

test("候補が空なら null、混在すると最も早い候補、過去もそのまま返す", () => {
  expect(nextRoomAlarmAt(input())).toBeNull();
  expect(
    nextRoomAlarmAt(input({ index: { retryAtMs: -100 }, guestClaims: { retryAtMs: 10 } })),
  ).toBe(-100);
});

test("人間の復帰期限だけを候補にし、登録中のプレイヤーは保持期限に置き換える", () => {
  const room = roomFixture("reversi", "waiting");
  for (const player of room.players) player.reconnectDeadline = player.kind === "human" ? 200 : 1;
  const human = room.players.find((player) => player.kind === "human")!;
  expect(nextRoomAlarmAt(input({ room }))).toBe(200);
  expect(
    nextRoomAlarmAt(input({ room, registrations: new Map([[human.id, { holdUntilMs: 500 }]]) })),
  ).toBe(500);
});

test("無操作の期限は24時間後、適用しないルームには加えない", () => {
  const room = roomFixture("reversi", "waiting");
  room.lastActivityAtMs = 123;
  expect(nextRoomAlarmAt(input({ room, usesIdleDeadline: true }))).toBe(86_400_123);
  expect(nextRoomAlarmAt(input({ room }))).toBeNull();
});

test("対局中は時計とCPUの期限を比較し、待機中はどちらも加えない", () => {
  const room = roomFixture("reversi");
  if (room.status !== "playing") throw Error();
  room.clock.turnExpiresAt = 800;
  expect(nextRoomAlarmAt(input({ room }))).toBe(800);
  expect(nextRoomAlarmAt(input({ room, cpuAlarmAt: 600 }))).toBe(600);
  expect(nextRoomAlarmAt(input({ room, cpuAlarmAt: 900 }))).toBe(800);
  expect(
    nextRoomAlarmAt(input({ room: roomFixture("reversi", "waiting"), cpuAlarmAt: 1 })),
  ).toBeNull();
});

test("外部AIの枠は解放期限だけを加え、進行中の予約は候補にしない", () => {
  expect(nextRoomAlarmAt(input({ capacity: { releaseAtMs: 300 } }))).toBe(300);
  expect(nextRoomAlarmAt(input({ capacity: { releaseAtMs: null } }))).toBeNull();
});

for (const key of ["accountCleanups", "matches", "shogiMatches", "tournamentStates"] as const)
  test(`${key}: 全ジョブから最も早い再送期限を選ぶ`, () => {
    expect(nextRoomAlarmAt(input({ [key]: [{ retryAtMs: 900 }, { retryAtMs: 500 }] }))).toBe(500);
  });
for (const key of ["index", "guestClaims"] as const)
  test(`${key}: 再送期限を加える`, () => {
    expect(nextRoomAlarmAt(input({ [key]: { retryAtMs: 400 } }))).toBe(400);
  });

function tournament(endsAtMs: number): NonNullable<RoomAlarmInput["tournament"]> {
  return {
    status: "waiting",
    preparedAtMs: 100,
    context: {
      endsAtMs,
    },
  };
}
test("大会の準備期限は接続猶予と大会終了の早い方、準備完了後は除外する", () => {
  expect(nextRoomAlarmAt(input({ tournament: tournament(1_000_000) }))).toBe(
    100 + tournamentRules.connectionGraceMs,
  );
  expect(nextRoomAlarmAt(input({ tournament: tournament(200) }))).toBe(200);
  expect(
    nextRoomAlarmAt(input({ tournament: { ...tournament(200), status: "playing" } })),
  ).toBeNull();
});

test("待機中の大会の開始時刻を加え、0と対局中は除外する", () => {
  const room = roomFixture("four-shogi", "waiting");
  if (!isFourShogiRoom(room) || room.status !== "waiting") throw Error();
  expect(nextRoomAlarmAt(input({ room: { ...room, tournamentStartsAtMs: 300 } }))).toBe(300);
  expect(nextRoomAlarmAt(input({ room: { ...room, tournamentStartsAtMs: 0 } }))).toBeNull();
  const playing = roomFixture("four-shogi");
  if (!isFourShogiRoom(playing) || playing.status !== "playing") throw Error();
  const playingWithCountdown = { ...playing, tournamentStartsAtMs: 1 };
  expect(nextRoomAlarmAt(input({ room: playingWithCountdown }))).toBe(playing.clock.turnExpiresAt);
});

function matchmaking(): NonNullable<RoomAlarmInput["matchmaking"]> {
  return {
    expiresAtMs: 10_000,
    phase: "waiting",
    aiWarmup: { state: "pending", nextAtMs: 2000 },
  };
}
test("レート戦の準備、開始、AI準備と開始前の最終期限を比較する", () => {
  const waiting = roomFixture("four-shogi", "waiting");
  if (!isFourShogiRoom(waiting) || waiting.status !== "waiting") throw Error();
  const room = {
    ...waiting,
    matchmaking: { id: "match", preparedAtMs: 100, rated: true as const },
  };
  expect(nextRoomAlarmAt(input({ room }))).toBe(100 + matchmakingRules.connectionGraceMs);
  expect(
    nextRoomAlarmAt(
      input({ room: { ...room, matchmaking: { ...room.matchmaking, startsAtMs: 1500 } } }),
    ),
  ).toBe(1500);
  const saved = matchmaking();
  expect(nextRoomAlarmAt(input({ room, matchmaking: saved }))).toBe(2000);
  expect(
    nextRoomAlarmAt(
      input({
        room,
        matchmaking: { ...saved, aiWarmup: { state: "pending", nextAtMs: 20_000 } },
      }),
    ),
  ).toBe(10_000 - matchmakingRules.countdownMs);
  for (const aiWarmup of [{ state: "ready" }, { state: "failed" }] as const)
    expect(nextRoomAlarmAt(input({ room, matchmaking: { ...saved, aiWarmup } }))).toBe(
      100 + matchmakingRules.connectionGraceMs,
    );
  expect(nextRoomAlarmAt(input({ room, matchmaking: { ...saved, phase: "playing" } }))).toBe(
    100 + matchmakingRules.connectionGraceMs,
  );
});

test("候補計算は入力を変更せず、対局中はレート戦の準備期限を加えない", () => {
  const room = roomFixture("four-shogi");
  if (!isFourShogiRoom(room) || room.status !== "playing") throw Error();
  const rated = { ...room, matchmaking: { id: "match", preparedAtMs: 0, rated: true as const } };
  const value = input({
    room: rated,
    matchmaking: matchmaking(),
    registrations: new Map([["absent", { holdUntilMs: 1 }]]),
  });
  const before = structuredClone(value);
  expect(nextRoomAlarmAt(value)).toBe(room.clock.turnExpiresAt);
  expect(value).toEqual(before);
});
