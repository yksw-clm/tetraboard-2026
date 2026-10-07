import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { roomSchema, roomTimeControl } from "@tetraboard/protocol";
import type { LoaderFunctionArgs } from "react-router";
import { roomLoader } from "../src/features/room/roomLoader";
import {
  assertRoomIdentity,
  fetchRoom,
  joinRoom,
  roomEntryErrorMessage,
  roomInvitationPath,
} from "../src/shared/roomAccess";
import { readRoomMembershipToken, saveRoomMembershipToken } from "../src/shared/roomMembership";

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const token = "a".repeat(64);
const playerId = crypto.randomUUID();
const room = roomSchema.parse({
  id: "12345",
  instanceId: crypto.randomUUID(),
  status: "waiting",
  settings: { game: "four-reversi", mode: "singles", timeControl: roomTimeControl },
  publicUpdatedAtMs: 0,
  lastActivityAtMs: 0,
  players: [
    {
      id: playerId,
      name: "参加者",
      kind: "human",
      ready: false,
      color: null,
      reconnectDeadline: null,
    },
  ],
  game: null,
  clock: null,
  lastRound: null,
});
const snapshot = {
  room,
  presence: { hostPlayerId: playerId, connectedPlayerIds: [] },
  serverNowMs: 0,
};
const membership = { playerId, role: "player" as const, token };
function load(search = "") {
  return roomLoader({
    params: { id: room.id },
    request: new Request(`https://example.com/rooms/${room.id}${search}`),
  } as LoaderFunctionArgs);
}
function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fetcher = mock((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  globalThis.fetch = fetcher as unknown as typeof fetch;
  return fetcher;
}
beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
});

test("招待は同じ部屋だけ読み込み、不正・期限切れリンクから別の部屋へ進まない", async () => {
  const fetcher = stubFetch(() => Response.json(snapshot));
  expect((await load(`?invite=${room.instanceId}`)).invited).toBe(true);
  expect((await load()).invited).toBe(false);
  await expect(load(`?invite=${crypto.randomUUID()}`)).rejects.toMatchObject({ status: 410 });
  const before = fetcher.mock.calls.length;
  for (const query of [
    "?invite=",
    "?invite=bad",
    `?invite=${room.instanceId}&invite=${room.instanceId}`,
  ]) {
    await expect(load(query)).rejects.toMatchObject({ status: 400 });
  }
  expect(fetcher.mock.calls.length).toBe(before);
  expect(roomInvitationPath(room)).toBe(`/rooms/12345?invite=${room.instanceId}`);
  stubFetch(() => Response.json({ error: "not_found" }, { status: 404 }));
  await expect(load(`?invite=${room.instanceId}`)).rejects.toMatchObject({ status: 404 });
});

test("再接続のGETと受信スナップショットは同じ番号の別世代を拒否する", async () => {
  const other = { ...room, instanceId: crypto.randomUUID() };
  stubFetch(() => Response.json({ ...snapshot, room: other }));
  await expect(fetchRoom(room.id, undefined, room.instanceId)).rejects.toMatchObject({
    status: 410,
  });
  expect(() => assertRoomIdentity(other, room.id, room.instanceId)).toThrow();
  expect(() => assertRoomIdentity(room, room.id, room.instanceId)).not.toThrow();
});

test("招待の参加は世代を送信し、検証した資格を保存する", async () => {
  const fetcher = stubFetch((_url, init) =>
    init?.method === "POST" ? Response.json({ room, membership }) : Response.json(snapshot),
  );
  const joined = await joinRoom(room.id, "  招待された人  ", room.instanceId);
  expect(joined).toMatchObject({ joined: true, room, membership });
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
    name: "招待された人",
    instanceId: room.instanceId,
  });
  expect(readRoomMembershipToken(room.id)).toBe(token);
});

test("同じタブのホスト・参加者資格は再利用し、POSTしない", async () => {
  for (const role of ["host", "player"] as const) {
    saveRoomMembershipToken(room.id, token);
    const fetcher = stubFetch((url) =>
      Response.json(url.endsWith("/me") ? { playerId, role } : snapshot),
    );
    expect(await joinRoom(room.id, "", room.instanceId)).toEqual({ joined: false });
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(readRoomMembershipToken(room.id)).toBe(token);
  }
});

test("旧招待は有効な新世代の資格があっても再利用せず、席を作らない", async () => {
  saveRoomMembershipToken(room.id, token);
  const fetcher = stubFetch(() => Response.json(snapshot));
  await expect(joinRoom(room.id, "参加", crypto.randomUUID())).rejects.toMatchObject({
    status: 410,
  });
  expect(fetcher.mock.calls).toHaveLength(1);
  expect(readRoomMembershipToken(room.id)).toBe(token);
});

test("空白・11文字の名前、保存不可、本人確認の通信失敗では参加しない", async () => {
  const fetcher = stubFetch(() => Response.json(snapshot));
  for (const name of [" ", "あいうえおかきくけこさ"]) {
    await expect(joinRoom(room.id, name)).rejects.toThrow("1〜10文字");
  }
  expect(fetcher.mock.calls).toHaveLength(0);
  saveRoomMembershipToken(room.id, token);
  stubFetch(() => {
    throw new Error("network");
  });
  await expect(joinRoom(room.id, "参加")).rejects.toMatchObject({ status: 503 });
  expect(readRoomMembershipToken(room.id)).toBe(token);
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get: () => {
      throw new Error("disabled");
    },
  });
  await expect(joinRoom(room.id, "参加")).rejects.toThrow("参加情報を保存できません");
});

test("入力後の満室・開始・閉鎖・世代変更は日本語で案内し資格を保存しない", async () => {
  for (const [error, expected] of [
    ["room_full", "満室"],
    ["room_started", "始まっています"],
    ["not_found", "見つかりません"],
    ["room_changed", "閉鎖"],
  ]) {
    stubFetch((_url, init) =>
      init?.method === "POST"
        ? Response.json(
            { error },
            { status: error === "not_found" ? 404 : error === "room_changed" ? 410 : 409 },
          )
        : Response.json(snapshot),
    );
    try {
      await joinRoom(room.id, "参加", room.instanceId);
      throw new Error("Expected rejection");
    } catch (caught) {
      expect(roomEntryErrorMessage(caught)).toContain(expected);
    }
    expect(readRoomMembershipToken(room.id)).toBeNull();
  }
});

test("参加応答が別世代なら資格を保存しない", async () => {
  stubFetch((_url, init) =>
    init?.method === "POST"
      ? Response.json({ room: { ...room, instanceId: crypto.randomUUID() }, membership })
      : Response.json(snapshot),
  );
  await expect(joinRoom(room.id, "参加", room.instanceId)).rejects.toMatchObject({ status: 410 });
  expect(readRoomMembershipToken(room.id)).toBeNull();
});
