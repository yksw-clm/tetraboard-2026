import { expect, test } from "bun:test";
import { roomForEntryResponse, type AccountProfile } from "@tetraboard/protocol";
import { createMemoryRouter, RouterProvider, useLoaderData } from "react-router";
import { useRoomEntry } from "../src/features/lobby/useRoomEntry";
import { roomLoader, type RoomLoaderData } from "../src/features/room/roomLoader";
import { AccountContext } from "../src/features/account/useAccount";
import { saveMatchmakingRoom } from "../src/features/matchmaking/matchmakingStorage";
import { saveTournamentRoom } from "../src/features/tournaments/tournamentQueueStorage";
import { readRoomMembershipToken, saveRoomMembershipToken } from "../src/shared/roomMembership";
import { profile } from "../test/fixtures/account";
import { membership, now, token, waitingRoom } from "../test/fixtures/rooms";
import { completeGuestAccount, guestProfile } from "./guestAccountFixtures";
import { act, clock, flush, press, render, requests } from "./harness";

const room = waitingRoom();
const snapshot = {
  room,
  presence: { hostPlayerId: membership.playerId, connectedPlayerIds: [] },
  serverNowMs: now,
  stampsSupported: true,
};
const currentMembership = { ...membership, accountLinked: true };
const entry = {
  room: roomForEntryResponse(room),
  membership: { ...membership, token },
  snapshot,
  currentMembership,
};

function mountEntry(
  user: AccountProfile | null,
  intent: "create" | "quick" | "join",
  loader = roomLoader,
) {
  function Lobby() {
    const entry = useRoomEntry();
    return (
      <button onClick={() => void entry.submitRoom(intent, room.id, room.instanceId)}>進む</button>
    );
  }
  function Room() {
    const data = useLoaderData<RoomLoaderData>();
    return <output>{data.membership?.playerId}</output>;
  }
  const router = createMemoryRouter([
    { path: "/", element: <Lobby /> },
    { id: "room", path: "/rooms/:id", loader, element: <Room /> },
  ]);
  localStorage.setItem("tetraboard:guest-name", "参加者");
  const view = render(
    <AccountContext.Provider
      value={{ user, loading: false, error: null, refresh: async () => {}, update: () => {} }}
    >
      <RouterProvider router={router} />
    </AccountContext.Provider>,
  );
  return { router, view };
}

function httpRequests() {
  return requests.map(({ url, init }) => [init.method ?? "GET", url]);
}

test("初回ゲストは Cookie の読み戻しを含む HTTP 4 回でルームへ進む", async () => {
  const chunk = Promise.withResolvers<void>();
  const { router, view } = mountEntry(null, "create", async (args) => {
    await chunk.promise;
    return roomLoader(args);
  });
  press(view, "進む");
  const creation = await completeGuestAccount("参加者", 0);
  expect(httpRequests()).toEqual([
    ["GET", "/api/account/session"],
    ["POST", "/api/account/guest"],
    ["GET", "/api/account/session"],
    ["POST", "/api/rooms?snapshot=1"],
  ]);
  creation.respond(entry, 201);
  await flush();
  clock.advance(250);
  chunk.resolve();
  await flush();
  expect(router.state.location.pathname).toBe(`/rooms/${room.id}`);
  expect(view.querySelector("output")?.textContent).toBe(membership.playerId);
  expect(router.state.loaderData.room).toEqual({
    ...snapshot,
    game: "four-reversi",
    invited: false,
    membership: currentMembership,
    serverNowMs: now + 250,
  });
  expect(requests).toHaveLength(4);
});

test.each([
  { label: "設定済みゲスト", user: guestProfile(), intent: "create" },
  { label: "登録者", user: profile, intent: "quick" },
] as const)(
  "$label の $intent はセッション確認と作成の HTTP 2 回で進む",
  async ({ user, intent }) => {
    const { router, view } = mountEntry(user, intent);
    press(view, "進む");
    requests[0]!.respond({ user });
    await flush();
    expect(httpRequests()).toEqual([
      ["GET", "/api/account/session"],
      ["POST", "/api/rooms?snapshot=1"],
    ]);
    expect(JSON.parse(String(requests[1]!.init.body))).toMatchObject({
      quickPlay: intent === "quick",
    });
    expect(JSON.parse(String(requests[1]!.init.body))).not.toHaveProperty("name");
    requests[1]!.respond(entry, 201);
    await flush();
    expect(router.state.location.pathname).toBe(`/rooms/${room.id}`);
    expect(view.querySelector("output")?.textContent).toBe(membership.playerId);
    expect(requests).toHaveLength(2);
  },
);

test.each([true, false])(
  "ロック内で登録者が見つかったときに初回設定済みか確認する（%s）",
  async (profileCompleted) => {
    const lock = Promise.withResolvers<void>();
    const original = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        async request(_name: string, callback: () => Promise<AccountProfile>) {
          await lock.promise;
          return callback();
        },
      },
    });
    try {
      const { router, view } = mountEntry(null, "create");
      press(view, "進む");
      expect(requests).toHaveLength(0);
      lock.resolve();
      await flush();
      requests[0]!.respond({ user: { ...profile, profileCompleted } });
      await flush();
      expect(httpRequests()).toEqual([
        ["GET", "/api/account/session"],
        ...(profileCompleted ? [["POST", "/api/rooms?snapshot=1"]] : []),
      ]);
      if (profileCompleted) {
        expect(JSON.parse(String(requests[1]!.init.body))).not.toHaveProperty("name");
        requests[1]!.respond(entry, 201);
        await flush();
      }
      expect(router.state.location.pathname).toBe(profileCompleted ? `/rooms/${room.id}` : "/");
    } finally {
      if (original) Object.defineProperty(navigator, "locks", original);
      else Reflect.deleteProperty(navigator, "locks");
    }
  },
);

test("招待参加は投稿前に世代を確認し、遷移後の GET は省く。次の loader は GET する", async () => {
  const playerId = room.players[1]!.id;
  const participant = { playerId, role: "player" as const, accountLinked: true };
  const { router, view } = mountEntry(profile, "join");
  press(view, "進む");
  requests[0]!.respond({ user: profile });
  await flush();
  requests[1]!.respond(snapshot);
  await flush();
  const expected = [
    ["GET", "/api/account/session"],
    ["GET", `/api/rooms/${room.id}?stamps=1&eliminatedHands=1`],
    ["POST", `/api/rooms/${room.id}/players?snapshot=1`],
  ];
  expect(httpRequests()).toEqual(expected);
  requests[2]!.respond({
    ...entry,
    membership: { playerId, role: "player", token },
    currentMembership: participant,
  });
  await flush();
  expect(router.state.location.pathname).toBe(`/rooms/${room.id}`);
  expect(view.querySelector("output")?.textContent).toBe(playerId);
  expect(httpRequests()).toEqual(expected);

  act(() => void router.revalidate());
  requests[3]!.respond(snapshot);
  await flush();
  requests[4]!.respond(participant);
  await flush();
  expect(httpRequests()).toEqual([
    ...expected,
    ["GET", `/api/rooms/${room.id}?stamps=1&eliminatedHands=1`],
    ["GET", `/api/rooms/${room.id}/me`],
  ]);
  expect(view.querySelector("output")?.textContent).toBe(playerId);
});

test.each([
  { intent: "create", status: 201, invalid: { snapshot: { ...snapshot, serverNowMs: "invalid" } } },
  { intent: "join", status: 200, invalid: { snapshot: { ...snapshot, serverNowMs: "invalid" } } },
  {
    intent: "create",
    status: 201,
    invalid: { currentMembership: { ...currentMembership, accountLinked: "invalid" } },
  },
] as const)(
  "$status 応答の初期表示データが不正でも資格を保存し、遷移時に GET を2回送る",
  async ({ intent, status, invalid }) => {
    const { router, view } = mountEntry(profile, intent);
    press(view, "進む");
    requests[0]!.respond({ user: profile });
    await flush();
    const roomUrl = `/api/rooms/${room.id}?stamps=1&eliminatedHands=1`;
    const expected = [["GET", "/api/account/session"]];
    const issuedFor =
      intent === "create"
        ? currentMembership
        : { playerId: room.players[1]!.id, role: "player" as const, accountLinked: true };
    if (intent === "join") {
      expect(requests[1]?.url).toBe(roomUrl);
      requests[1]!.respond(snapshot);
      await flush();
      expected.push(["GET", roomUrl], ["POST", `/api/rooms/${room.id}/players?snapshot=1`]);
    } else {
      expected.push(["POST", "/api/rooms?snapshot=1"]);
    }
    expect(httpRequests()).toEqual(expected);
    requests.at(-1)!.respond(
      {
        ...entry,
        membership: { playerId: issuedFor.playerId, role: issuedFor.role, token },
        currentMembership: issuedFor,
        ...invalid,
      },
      status,
    );
    await flush();
    expect(readRoomMembershipToken(room.id)).toBe(token);
    expect(httpRequests()).toEqual([...expected, ["GET", roomUrl]]);
    requests.at(-1)!.respond(snapshot);
    await flush();
    expect(httpRequests()).toEqual([
      ...expected,
      ["GET", roomUrl],
      ["GET", `/api/rooms/${room.id}/me`],
    ]);
    expect(new Headers(requests.at(-1)!.init.headers).get("Authorization")).toBe(`Bearer ${token}`);
    requests.at(-1)!.respond(issuedFor);
    await flush();
    expect(router.state.location.pathname).toBe(`/rooms/${room.id}`);
    expect(view.querySelector("output")?.textContent).toBe(issuedFor.playerId);
    expect(requests).toHaveLength(expected.length + 2);
  },
);

const otherInstance = "00000000-0000-4000-8000-000000000099";
const otherToken = "b".repeat(64);

test.each([
  ["snapshot の省略", { snapshot: undefined }],
  ["本人資格の省略", { currentMembership: undefined }],
  ["応答内の部屋番号不一致", { snapshot: { ...snapshot, room: { ...room, id: "54321" } } }],
  [
    "応答内の世代不一致",
    { snapshot: { ...snapshot, room: { ...room, instanceId: otherInstance } } },
  ],
  [
    "応答内の本人ID不一致",
    { currentMembership: { ...currentMembership, playerId: otherInstance } },
  ],
  ["応答内の役割不一致", { currentMembership: { ...currentMembership, role: "player" } }],
  [
    "本人の席が消えた",
    { snapshot: { ...snapshot, room: { ...room, players: room.players.slice(1) } } },
  ],
  ["受信から10秒超過", {}],
  ["保存トークン不一致", {}],
  ["招待URLの世代不一致", {}],
  ["マッチングの復旧参照", {}],
  ["大会の復旧参照", {}],
] as const)("%s のときはルームと本人資格を再取得する", async (reason, fields) => {
  const chunk = Promise.withResolvers<void>();
  const invited = reason === "招待URLの世代不一致";
  const { router, view } = mountEntry(profile, "create", async (args) => {
    await chunk.promise;
    if (!invited) return roomLoader(args);
    const url = new URL(args.request.url);
    url.searchParams.set("invite", otherInstance);
    return roomLoader({ ...args, url, request: new Request(url, { signal: args.request.signal }) });
  });
  press(view, "進む");
  requests[0]!.respond({ user: profile });
  await flush();
  requests[1]!.respond({ ...entry, ...fields }, 201);
  await flush();
  if (reason === "受信から10秒超過") clock.advance(10_001);
  if (reason === "保存トークン不一致") saveRoomMembershipToken(room.id, otherToken);
  const reference = { roomId: room.id, instanceId: otherInstance, operationId: otherInstance };
  if (reason === "マッチングの復旧参照")
    expect(
      saveMatchmakingRoom({
        ...reference,
        identity: otherInstance,
        controllerId: otherInstance,
        version: 1,
      }),
    ).toBe(true);
  if (reason === "大会の復旧参照")
    expect(saveTournamentRoom({ ...reference, tournamentId: 1, identity: profile.username! })).toBe(
      true,
    );
  chunk.resolve();
  await flush();
  expect(requests[2]?.url).toBe(`/api/rooms/${room.id}?stamps=1&eliminatedHands=1`);
  const fetchedRoom = invited ? { ...room, instanceId: otherInstance } : room;
  requests[2]!.respond({ ...snapshot, room: fetchedRoom });
  await flush();
  expect(requests[3]?.url).toBe(`/api/rooms/${room.id}/me`);
  expect(new Headers(requests[3]!.init.headers).get("Authorization")).toBe(
    `Bearer ${reason === "保存トークン不一致" ? otherToken : token}`,
  );
  requests[3]!.respond(membership);
  await flush();
  expect(router.state.loaderData.room).toMatchObject({ room: fetchedRoom, membership, invited });
  expect(view.querySelector("output")?.textContent).toBe(membership.playerId);
  expect(requests).toHaveLength(4);
});
