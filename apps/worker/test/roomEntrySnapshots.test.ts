import { env } from "cloudflare:workers";
import {
  createRoomContract,
  getRoomContract,
  getRoomMembershipContract,
  joinRoomContract,
} from "@tetraboard/protocol";
import { expect, test, vi } from "vitest";
import { roomRoutes } from "../src/routes/roomRoutes";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { accountFixture, origin } from "./accountFixtures";
import { request } from "./accountRoomsFixtures";

const createBody = { name: "ホスト", quickPlay: false, mode: "singles" };
const joinBody = { name: "参加者" };

function post(body: unknown, headers: HeadersInit = { "Content-Type": "application/json" }) {
  return { method: "POST", headers, body: JSON.stringify(body) };
}

type EntryResponse = ReturnType<typeof createRoomContract.responseWithSnapshot.parse>;

async function expectEntryMatchesReads(entry: EntryResponse) {
  const [loaded, me] = await Promise.all([
    request(`/rooms/${entry.room.id}?stamps=1&eliminatedHands=1`),
    request(`/rooms/${entry.room.id}/me`, {
      headers: { Authorization: `Bearer ${entry.membership.token}` },
    }),
  ]);
  expect(loaded.status).toBe(200);
  expect(me.status).toBe(200);
  const snapshot = getRoomContract.response.parse(await loaded.json());
  expect(entry.snapshot).toEqual({ ...snapshot, serverNowMs: expect.any(Number) });
  expect(entry.currentMembership).toEqual(
    getRoomMembershipContract.response.parse(await me.json()),
  );
}

test("指定なしの作成と参加を旧クライアントの strict schema が受理する", async () => {
  const created = await request("/rooms", post(createBody));
  expect(created.status).toBe(201);
  const entry = createRoomContract.response.parse(await created.json());
  expect(Object.keys(entry).sort()).toEqual(["membership", "room"]);
  const joined = await request(`/rooms/${entry.room.id}/players`, post(joinBody));
  expect(joined.status).toBe(200);
  expect(Object.keys(joinRoomContract.response.parse(await joined.json())).sort()).toEqual([
    "membership",
    "room",
  ]);
});

test.each(["four-reversi", "four-shogi"])(
  "%s の作成と参加はスナップショットと発行した資格の本人情報を GET と同じ形で返す",
  async (game) => {
    const host = await accountFixture();
    const created = await request("/rooms?snapshot=1", post({ ...createBody, game }, host.headers));
    expect(created.status).toBe(201);
    const entry = createRoomContract.responseWithSnapshot.parse(await created.json());
    expect(entry.currentMembership).toMatchObject({
      playerId: entry.membership.playerId,
      role: "host",
      accountLinked: true,
    });
    await expectEntryMatchesReads(entry);

    const joined = await request(
      `/rooms/${entry.room.id}/players?snapshot=1`,
      post({ ...joinBody, instanceId: entry.room.instanceId }),
    );
    expect(joined.status).toBe(200);
    const participant = joinRoomContract.responseWithSnapshot.parse(await joined.json());
    expect(participant.currentMembership).toEqual({
      playerId: participant.membership.playerId,
      role: "player",
    });
    await expectEntryMatchesReads(participant);
    if (game === "four-reversi") {
      for (const value of [entry, participant]) {
        expect(value.room).not.toHaveProperty("roundId");
        expect(value.room).not.toHaveProperty("positionRevision");
        expect(value.snapshot?.room).toMatchObject({ roundId: null, positionRevision: 0 });
      }
    }
  },
);

test("不正な snapshot 指定は作成と参加のどちらも 400 になる", async () => {
  for (const [path, body] of [
    ["/rooms", createBody],
    ["/rooms/12345/players", joinBody],
  ] as const) {
    const response = await request(`${path}?snapshot=0`, post(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  }
});

test.each(["例外", "取得不能"])(
  "追加読み取りが%sでも作成と参加は有効な資格を返す",
  async (failure) => {
    const getRoomEntrySnapshot = vi.fn(() => {
      if (failure === "例外") throw new Error("Snapshot unavailable");
      return null;
    });
    const rooms = {
      getByName(code: string) {
        const stub = env.GAME_ROOM.getByName(code);
        return {
          createRoom: (...args: Parameters<typeof stub.createRoom>) => stub.createRoom(...args),
          joinRoom: (...args: Parameters<typeof stub.joinRoom>) => stub.joinRoom(...args),
          getRoomEntrySnapshot,
        };
      },
    } as unknown as Env["GAME_ROOM"];
    const send = (path: string, body: unknown) =>
      roomRoutes.fetch(new AcceptedGameRequest(`${origin}${path}?snapshot=1`, post(body)), {
        ...env,
        GAME_ROOM: rooms,
      });
    const created = await send("/rooms", createBody);
    expect(created.status).toBe(201);
    const entry = createRoomContract.response.parse(await created.json());
    const joined = await send(`/rooms/${entry.room.id}/players`, joinBody);
    expect(joined.status).toBe(200);
    const participant = joinRoomContract.response.parse(await joined.json());
    expect(getRoomEntrySnapshot).toHaveBeenCalledTimes(2);
    for (const { membership } of [entry, participant]) {
      const me = await request(`/rooms/${entry.room.id}/me`, {
        headers: { Authorization: `Bearer ${membership.token}` },
      });
      expect(me.status).toBe(200);
      expect(await me.json()).toEqual({ playerId: membership.playerId, role: membership.role });
    }
  },
);
