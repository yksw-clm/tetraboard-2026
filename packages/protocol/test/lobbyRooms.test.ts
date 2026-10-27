import { expect, test } from "bun:test";
import {
  lobbyRoomCardSchema,
  lobbyRoomCardsSchema,
  lobbyRoomsQuerySchema,
  lobbyRoomsSchema,
} from "../src/generalLobby";

const room = {
  id: "12345",
  instanceId: "11111111-1111-4111-8111-111111111111",
  game: "four-shogi",
  mode: "singles",
  timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
  status: "waiting",
  hostName: "募集者",
  hostAvatarUrl: null,
  humanCount: 1,
  cpuCount: 1,
  capacity: 4,
  openSeats: 2,
  updatedAtMs: 123,
} as const;
const participants = [
  {
    kind: "human",
    avatarUrl: null,
    profileTarget: {
      source: "room",
      roomId: room.id,
      instanceId: room.instanceId,
      playerId: "22222222-2222-4222-8222-222222222222",
    },
  },
  { kind: "cpu", level: 2 },
] as const;

test("カード表示は明示した場合だけ追加の取得条件を受け付ける", () => {
  expect(lobbyRoomsQuerySchema.parse({ capacity: "4" })).toEqual({ capacity: "4" });
  expect(
    lobbyRoomsQuerySchema.parse({
      view: "cards",
      game: "four-shogi",
      mode: "doubles",
      joinable: "true",
    }),
  ).toMatchObject({ view: "cards", mode: "doubles" });
  for (const query of [
    { game: "shogi" },
    { view: "cards", game: "shogi", mode: "singles" },
    { view: "cards", game: "unknown" },
    { view: "cards", joinable: "1" },
    { view: "cards", cursor: "3:100:12345" },
    { view: "cards", cursor: "0:9999999999999999:12345" },
  ])
    expect(lobbyRoomsQuerySchema.safeParse(query).success).toBe(false);
});

test("席画像は人数と一致し、公開プロフィール参照だけを人間の席に含める", () => {
  expect(
    lobbyRoomCardsSchema.parse({
      rooms: [{ ...room, participants }],
      nextCursor: null,
      totalCount: 1,
    }).rooms[0]?.participants,
  ).toEqual([...participants]);
  expect(lobbyRoomCardSchema.safeParse({ ...room, participants: [] }).success).toBe(false);
  expect(
    lobbyRoomCardSchema.safeParse({
      ...room,
      participants: [
        { kind: "cpu", level: 1 },
        { kind: "cpu", level: 2 },
      ],
    }).success,
  ).toBe(false);
  expect(
    lobbyRoomCardSchema.safeParse({
      ...room,
      participants: [{ kind: "human", avatarUrl: null }, participants[1]],
    }).success,
  ).toBe(false);
  expect(
    lobbyRoomCardSchema.safeParse({
      ...room,
      participants: [{ ...participants[0], retired: true, profileTarget: null }, participants[1]],
    }).success,
  ).toBe(true);
  expect(
    lobbyRoomCardSchema.safeParse({
      ...room,
      participants: [{ ...participants[0], retired: true }, participants[1]],
    }).success,
  ).toBe(false);
  expect(
    lobbyRoomCardSchema.safeParse({
      ...room,
      participants: [{ ...participants[0], accountId: "private" }, participants[1]],
    }).success,
  ).toBe(false);
  expect(
    lobbyRoomCardSchema.safeParse({
      ...room,
      participants: [
        { ...participants[0], playerId: participants[0].profileTarget.playerId },
        participants[1],
      ],
    }).success,
  ).toBe(false);
  expect(
    lobbyRoomCardSchema.safeParse({
      ...room,
      participants: [
        participants[0],
        { ...participants[1], profileTarget: participants[0].profileTarget },
      ],
    }).success,
  ).toBe(false);
  expect(lobbyRoomsSchema.parse({ rooms: [room], nextCursor: null }).rooms[0]).not.toHaveProperty(
    "participants",
  );
  expect(
    lobbyRoomsSchema.safeParse({ rooms: [{ ...room, participants }], nextCursor: null }).success,
  ).toBe(false);
});
