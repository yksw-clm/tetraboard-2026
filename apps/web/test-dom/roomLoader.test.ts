import { expect, test } from "bun:test";
import { RouterContextProvider } from "react-router";
import { roomLoader } from "../src/features/room/roomLoader";
import { waitingRoom, membership, token, now } from "../test/fixtures/rooms";
import { waitingShogiRoom } from "../test/fixtures/fourShogiFixtures";
import {
  readTournamentRoom,
  saveTournamentRoom,
} from "../src/features/tournaments/tournamentQueueStorage";
import { recoverTournamentRoom } from "../src/features/tournaments/tournamentRoomRecovery";
import {
  TournamentDocumentController,
  tournamentDocumentController,
} from "../src/features/tournaments/tournamentController";
import { profile } from "../test/fixtures/account";
import { flush, requests } from "./harness";

const args = (path: string, id = "12345", signal?: AbortSignal) => ({
  params: { id },
  request: new Request(`https://tetraboard.test${path}`, { signal }),
  context: new RouterContextProvider(),
  url: new URL(`https://tetraboard.test${path}`),
  pattern: "/rooms/:id",
});
const snapshot = (room: ReturnType<typeof waitingRoom> | ReturnType<typeof waitingShogiRoom>) => ({
  room,
  presence: { hostPlayerId: room.players[0]!.id, connectedPlayerIds: [] },
  serverNowMs: now,
});

test("直接アクセス・再読み込みはゲームを判別し、招待世代と本人確認を維持", async () => {
  for (const room of [waitingRoom(), waitingShogiRoom()]) {
    for (let repeat = 0; repeat < 2; repeat++) {
      sessionStorage.setItem("tetraboard:room:12345:membership", token);
      const count = requests.length;
      const input = args(`/rooms/12345?invite=${room.instanceId}`),
        pending = roomLoader(input);
      expect(requests.at(-1)!.url).toBe(
        "/api/rooms/12345?formationAnalysis=1&stamps=1&eliminatedHands=1",
      );
      requests.at(-1)!.respond({
        ...snapshot(room),
        ...(room.settings.game === "four-shogi" ? { formationAnalysis: null } : {}),
      });
      await flush();
      expect(requests.at(-1)!.url).toBe("/api/rooms/12345/me");
      expect(requests.at(-1)!.init.signal).toBe(input.request.signal);
      requests.at(-1)!.respond(membership);
      const loaded = await pending;
      expect(loaded.game).toBe(room.settings.game);
      expect(loaded.room).toEqual(room);
      expect(loaded.invited).toBe(true);
      expect(loaded.membership).toEqual(membership);
      expect(requests).toHaveLength(count + 2);
      if (loaded.game === "four-shogi") expect(loaded.formationAnalysisSupported).toBe(true);
    }
  }
});
test("不正なID・招待・再利用された世代・不一致な本人は対象ルームへ進めない", async () => {
  for (const input of [
    args("/rooms/bad", "bad"),
    args("/rooms/12345?invite=bad"),
    args(`/rooms/12345?invite=${waitingRoom().instanceId}&invite=${waitingRoom().instanceId}`),
  ])
    await expect(roomLoader(input)).rejects.toMatchObject({ status: 400 });
  expect(requests).toHaveLength(0);
  let pending = roomLoader(args(`/rooms/12345?invite=${crypto.randomUUID()}`));
  requests.at(-1)!.respond(snapshot(waitingRoom()));
  await expect(pending).rejects.toMatchObject({ status: 410 });
  expect(requests).toHaveLength(1);
  sessionStorage.setItem("tetraboard:room:12345:membership", token);
  pending = roomLoader(args("/rooms/12345"));
  requests.at(-1)!.respond(snapshot(waitingRoom()));
  await flush();
  requests.at(-1)!.respond({ ...membership, playerId: crypto.randomUUID() });
  await expect(pending).rejects.toMatchObject({ status: 503 });
});
test("本人資格が失効した読み込みは資格を消去して観戦へ戻る", async () => {
  sessionStorage.setItem("tetraboard:room:12345:membership", token);
  const pending = roomLoader(args("/rooms/12345"));
  requests.at(-1)!.respond(snapshot(waitingRoom()));
  await flush();
  requests.at(-1)!.respond({ error: "unauthorized" }, 401);
  expect((await pending).membership).toBeNull();
  expect(sessionStorage.getItem("tetraboard:room:12345:membership")).toBeNull();
});

test("旧Workerの400では表示用クエリだけを外して一度再取得する", async () => {
  const pending = roomLoader(args("/rooms/12345"));
  requests.at(-1)!.respond({ error: "invalid_request" }, 400);
  await flush();
  expect(requests.at(-1)!.url).toBe("/api/rooms/12345?formationAnalysis=1&stamps=1");
  requests.at(-1)!.respond(snapshot(waitingShogiRoom()));
  const loaded = await pending;
  expect(loaded.game).toBe("four-shogi");
  expect(loaded.eliminatedHands).toBeUndefined();
});

test.each(["matched", "playing"] as const)(
  "大会%sの保存先は本人の所有世代を照合し、復旧した資格で読み込む",
  async (status) => {
    const room = { ...waitingShogiRoom(), tournamentId: 1 };
    const reference = {
      tournamentId: 1,
      identity: profile.username!,
      operationId: crypto.randomUUID(),
      roomId: room.id,
      instanceId: room.instanceId,
    };
    saveTournamentRoom(reference);
    tournamentDocumentController.remember(`1:${reference.identity}`, reference.operationId, 2);
    const participation = {
      entered: true,
      status,
      controller: "self",
      controllerVersion: 2,
      operationId: reference.operationId,
      roomId: room.id,
      instanceId: room.instanceId,
    };
    const pending = roomLoader(args(`/rooms/12345?invite=${room.instanceId}`));
    expect(new Headers(requests.at(-1)!.init.headers).get("X-Tournament-Controller")).toBe(
      tournamentDocumentController.getIdentity(),
    );
    requests.at(-1)!.respond(participation);
    await flush();
    expect(JSON.parse(requests.at(-1)!.init.body as string)).toEqual({
      operationId: reference.operationId,
      controllerId: tournamentDocumentController.getIdentity(),
      takeover: false,
      expectedControllerVersion: 2,
    });
    requests.at(-1)!.respond({ participation, token });
    await flush();
    requests.at(-1)!.respond(snapshot(room));
    await flush();
    expect(new Headers(requests.at(-1)!.init.headers).get("Authorization")).toBe(`Bearer ${token}`);
    requests.at(-1)!.respond(membership);
    expect((await pending).membership).toEqual(membership);
  },
);

test("大会の失敗した旧ルームは通知を受け取れなくても大会へ戻る", async () => {
  const room = { ...waitingShogiRoom(), tournamentId: 1 };
  const reference = {
    tournamentId: 1,
    identity: profile.username!,
    operationId: crypto.randomUUID(),
    roomId: room.id,
    instanceId: room.instanceId,
  };
  saveTournamentRoom(reference);
  const pending = roomLoader(args(`/rooms/12345?invite=${room.instanceId}`));
  requests.at(-1)!.respond({
    entered: true,
    status: "waiting",
    controller: "other",
    controllerVersion: 2,
    operationId: reference.operationId,
  });
  const result = await pending.catch((error) => error as Response);
  expect((result as Response).status).toBe(302);
  expect((result as Response).headers.get("Location")).toBe("/tournaments/1?return=unavailable");
  expect(requests.some((request) => request.url.startsWith("/api/rooms"))).toBe(false);
});

test.each([404, 410])(
  "入室確認後に大会ルームが%sになった場合も保存した大会へ戻る",
  async (status) => {
    const room = { ...waitingShogiRoom(), tournamentId: 1 };
    const reference = {
      tournamentId: 1,
      identity: profile.username!,
      operationId: crypto.randomUUID(),
      roomId: room.id,
      instanceId: room.instanceId,
    };
    saveTournamentRoom(reference);
    tournamentDocumentController.remember(`1:${reference.identity}`, reference.operationId, 2);
    const participation = {
      entered: true,
      status: "matched",
      controller: "self",
      controllerVersion: 2,
      operationId: reference.operationId,
      roomId: room.id,
      instanceId: room.instanceId,
    };
    const pending = roomLoader(args(`/rooms/12345?invite=${room.instanceId}`));
    requests.at(-1)!.respond(participation);
    await flush();
    requests.at(-1)!.respond({ participation, token });
    await flush();
    requests.at(-1)!.respond({ error: status === 404 ? "not_found" : "room_changed" }, status);
    const result = await pending.catch((error) => error as Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("Location")).toBe("/tournaments/1?return=unavailable");
  },
);

test("公開観戦でルームが消えた場合は大会へ自動復帰せず通常の404を維持する", async () => {
  const pending = roomLoader(args("/rooms/12345?watch=1"));
  requests.at(-1)!.respond({ error: "not_found" }, 404);
  await expect(pending).rejects.toMatchObject({ status: 404 });
});

test("中断した大会room復旧のGET応答からは引継ぎPOSTを送らない", async () => {
  const room = { ...waitingShogiRoom(), tournamentId: 1 };
  saveTournamentRoom({
    tournamentId: 1,
    identity: profile.username!,
    operationId: crypto.randomUUID(),
    roomId: room.id,
    instanceId: room.instanceId,
  });
  const abort = new AbortController();
  const pending = roomLoader(args(`/rooms/12345?invite=${room.instanceId}`, room.id, abort.signal));
  abort.abort();
  requests
    .at(-1)!
    .respond({ entered: true, status: "idle", controller: "none", controllerVersion: 0 });
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(requests.some((request) => request.url.endsWith("/controller"))).toBe(false);
});

test("復旧claimが失敗したら、この復旧が取得した生存確認lockを解放する", async () => {
  let held = false;
  const locks = {
    request: async (
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => Promise<void>,
    ) => {
      if (held) return callback(null);
      held = true;
      try {
        await callback({ name: "test", mode: "exclusive" } as Lock);
      } finally {
        held = false;
      }
    },
  } as LockManager;
  const controller = new TournamentDocumentController({
    isReload: () => true,
    locks: () => locks,
    channel: () => null,
  });
  const room = { ...waitingShogiRoom(), tournamentId: 1 };
  const reference = {
    tournamentId: 1,
    identity: profile.username!,
    operationId: crypto.randomUUID(),
    roomId: room.id,
    instanceId: room.instanceId,
    controllerVersion: 2,
  };
  saveTournamentRoom(reference);
  const pending = recoverTournamentRoom(
    room.id,
    room.instanceId,
    new AbortController().signal,
    controller,
  );
  requests.at(-1)!.respond({
    entered: true,
    status: "matched",
    controller: "other",
    controllerVersion: 2,
    operationId: reference.operationId,
    roomId: room.id,
    instanceId: room.instanceId,
  });
  await flush();
  expect(held).toBe(true);
  requests.at(-1)!.respond({ message: "世代が変わりました" }, 409);
  await expect(pending).rejects.toThrow("世代が変わりました");
  await flush();
  expect(held).toBe(false);
});

test("旧大会のルーム番号が再利用された招待無しURLでは、新instanceの通常ルームを表示する", async () => {
  const old = waitingShogiRoom();
  saveTournamentRoom({
    tournamentId: 1,
    identity: profile.username!,
    operationId: crypto.randomUUID(),
    roomId: old.id,
    instanceId: old.instanceId,
    controllerVersion: 1,
  });
  const room = { ...old, instanceId: crypto.randomUUID() };
  const pending = roomLoader(args(`/rooms/${room.id}`));
  requests.at(-1)!.respond(snapshot(room));
  const loaded = await pending;
  expect(loaded.room.instanceId).toBe(room.instanceId);
  expect(requests.some((request) => request.url.startsWith("/api/tournaments"))).toBe(false);
});

test.each([undefined, 1])(
  "roomの旧保存版%sでは別端末へ移譲済みの版を自動で奪い返さない",
  async (controllerVersion) => {
    const controller = new TournamentDocumentController({
      isReload: () => true,
      locks: () => undefined,
      channel: () => null,
    });
    const room = { ...waitingShogiRoom(), tournamentId: 1 };
    const reference = {
      tournamentId: 1,
      identity: profile.username!,
      operationId: crypto.randomUUID(),
      roomId: room.id,
      instanceId: room.instanceId,
      controllerVersion,
    };
    saveTournamentRoom(reference);
    const pending = recoverTournamentRoom(
      room.id,
      room.instanceId,
      new AbortController().signal,
      controller,
    );
    requests.at(-1)!.respond({
      entered: true,
      status: "matched",
      controller: "other",
      controllerVersion: 2,
      operationId: reference.operationId,
      roomId: room.id,
      instanceId: room.instanceId,
    });
    const result = await pending.catch((error) => error as Response);
    expect((result as Response).headers.get("Location")).toBe("/tournaments/1?return=transferred");
    expect(requests.some((request) => request.url.endsWith("/controller"))).toBe(false);
  },
);

test("大会roomを連続reloadしても成功した所有版と資格を保存し次の復旧へ引き継ぐ", async () => {
  let held = false;
  const locks = {
    request: async (
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => Promise<void>,
    ) => {
      if (held) return callback(null);
      held = true;
      try {
        await callback({ name: "test", mode: "exclusive" } as Lock);
      } finally {
        held = false;
      }
    },
  } as LockManager;
  const room = { ...waitingShogiRoom(), tournamentId: 1 };
  const reference = {
    tournamentId: 1,
    identity: profile.username!,
    operationId: crypto.randomUUID(),
    roomId: room.id,
    instanceId: room.instanceId,
    controllerVersion: 1,
  };
  saveTournamentRoom(reference);
  for (const version of [1, 2]) {
    const controller = new TournamentDocumentController({
      isReload: () => true,
      locks: () => locks,
      channel: () => null,
    });
    const pending = recoverTournamentRoom(
      room.id,
      room.instanceId,
      new AbortController().signal,
      controller,
    );
    const participation = {
      entered: true,
      status: "matched",
      controller: "other",
      controllerVersion: version,
      operationId: reference.operationId,
      roomId: room.id,
      instanceId: room.instanceId,
    };
    requests.at(-1)!.respond(participation);
    await flush();
    expect(JSON.parse(requests.at(-1)!.init.body as string).expectedControllerVersion).toBe(
      version,
    );
    requests
      .at(-1)!
      .respond({
        participation: { ...participation, controller: "self", controllerVersion: version + 1 },
        token: String(version).repeat(64),
      });
    await pending;
    expect(readTournamentRoom(room.id, room.instanceId)?.controllerVersion).toBe(version + 1);
    controller.release(`1:${profile.username}`);
    await flush();
  }
});
