import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import {
  matchmakingRules as rules,
  matchmakingStateSchema,
  roomSchema,
} from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { matchmakingCredential } from "../src/matchmaking/coordinator";
import { requestDeletion } from "../src/privacy/deletion";
import { requireGuestIdle } from "../src/accounts/guestLinking";
import { accountIdentity } from "../src/accounts/auth";
const stub = () => env.MATCHMAKING_COORDINATOR.getByName(rules.key);
const accounts: string[] = [];
const rooms = new Set<string>();
const sockets: WebSocket[] = [];
test("閲覧だけでゲストを作らず、名前確定したゲストは登録者と同じ列で参加できる", async () => {
  const count = () =>
    env.APP_DB.prepare("SELECT COUNT(*) AS n FROM user WHERE isAnonymous=1").first<{ n: number }>();
  const before = await count();
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/matchmaking/four-reversi`),
  );
  expect(response.status).toBe(200);
  expect((await count())?.n).toBe(before?.n);
  const registered = (await fixture(1))[0]!;
  const guest = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/account/guest`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "CF-Connecting-IP": crypto.randomUUID(),
      },
      body: JSON.stringify({ name: "ゲスト参加者" }),
    }),
  );
  expect(guest.status).toBe(201);
  const cookie = guest.headers
    .getSetCookie()
    .find((c) => c.startsWith("tetraboard-2026.guest="))!
    .split(";")[0]!;
  const user = await accountIdentity(new Request(origin, { headers: { Cookie: cookie } }), env);
  expect(user?.guestNameCustomized).toBeTruthy();
  accounts.push(user!.id);
  const operationId = crypto.randomUUID(),
    controllerId = crypto.randomUUID();
  expect((await stub().join(user!.id, operationId, controllerId)).ok).toBe(true);
  await fill();
  const matched = await stub().status(user!.id, controllerId);
  rooms.add(matched.assignment!.roomId);
  const room = roomSchema.parse(
    await env.GAME_ROOM.getByName(matched.assignment!.roomId).getRoom(),
  );
  expect(room.players.find((p) => p.name === "ゲスト参加者")).toMatchObject({
    kind: "human",
    isGuest: true,
  });
  expect(
    (await stub().status(registered.account.id, registered.controllerId)).assignment?.matchId,
  ).toBe(matched.assignment!.matchId);
});
async function fixture(count: number) {
  const users = [];
  for (let i = 0; i < count; i++) {
    const account = await accountFixture();
    accounts.push(account.id);
    users.push({ account, operationId: crypto.randomUUID(), controllerId: crypto.randomUUID() });
  }
  for (const user of users) {
    const result = await stub().join(user.account.id, user.operationId, user.controllerId);
    expect(result.ok).toBe(true);
  }
  return users;
}
async function fill() {
  await runInDurableObject(stub(), async (_instance, state) => {
    const current = state.storage.kv.get<{ waiting: { joinedAtMs: number }[] }>("state")!;
    for (const w of current.waiting) w.joinedAtMs = Date.now() - rules.fillAfterMs - 100;
    state.storage.kv.put("state", current);
  });
  await runInDurableObject(stub(), (instance) => instance.alarm());
}
async function connect(id: string, token: string) {
  const r = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/rooms/${id}/ws`, { headers: { Upgrade: "websocket" } }),
  );
  expect(r.status).toBe(101);
  const socket = r.webSocket!;
  socket.accept();
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (e) => {
      const v = JSON.parse(String(e.data));
      if (v.type === "room.authenticated") resolve();
      if (v.type === "room.error") reject(Error(v.error));
    });
    socket.send(JSON.stringify({ type: "room.auth", token }));
  });
  return socket;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of sockets.splice(0)) s.close();
  for (const id of rooms) {
    await runInDurableObject(env.GAME_ROOM.getByName(id), async (_instance, state) => {
      await state.storage.deleteAll();
    });
  }
  rooms.clear();
  for (const id of accounts.splice(0)) {
    await env.APP_DB.prepare("DELETE FROM tournament_wait_reservations WHERE account_id=?")
      .bind(id)
      .run();
    await env.APP_DB.prepare("DELETE FROM matchmaking_wait_reservations WHERE account_id=?")
      .bind(id)
      .run();
    await env.APP_DB.prepare(
      "DELETE FROM room_avatar_refs WHERE operation_id IN(SELECT operation_id FROM account_room_seats WHERE account_id=?)",
    )
      .bind(id)
      .run();
    await env.APP_DB.prepare("DELETE FROM account_room_seats WHERE account_id=?").bind(id).run();
  }
  await runInDurableObject(stub(), async (_instance, state) => {
    await state.storage.deleteAll();
  });
});

test("参照だけでは期限処理や組合せを実行せず、30秒のAlarmで成立する", async () => {
  let now = Date.now() + 60000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const [u] = await fixture(1);
  const joined = now;
  now += 20000;
  await stub().control(
    u!.account.id,
    { operationId: u!.operationId, controllerId: u!.controllerId, version: 1 },
    "heartbeat",
  );
  now = joined + 30000;
  for (let i = 0; i < 3; i++)
    expect((await stub().status(u!.account.id, u!.controllerId)).status).toBe("waiting");
  await runInDurableObject(stub(), (instance) => instance.alarm());
  const matched = await stub().status(u!.account.id, u!.controllerId);
  expect(matched.status).toBe("matched");
  rooms.add(matched.assignment!.roomId);
});

test("未接続者の入室期限で旧ルームを閉じ、接続済みの人間を元の優先度で再割当する", async () => {
  let now = Date.now() + 60000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const users = await fixture(4);
  const states = await Promise.all(users.map((u) => stub().status(u.account.id, u.controllerId)));
  const old = states[0]!.assignment!;
  rooms.add(old.roomId);
  for (const s of states.slice(0, 3)) await connect(old.roomId, s.assignment!.membership.token);
  now += rules.connectionGraceMs;
  await runInDurableObject(stub(), (instance) => instance.alarm());
  expect(await env.GAME_ROOM.getByName(old.roomId).getRoom()).toBeNull();
  expect((await stub().status(users[3]!.account.id, users[3]!.controllerId)).status).toBe("idle");
  const restored = await Promise.all(
    users.slice(0, 3).map((u) => stub().status(u.account.id, u.controllerId)),
  );
  for (let i = 0; i < 3; i++) {
    expect(restored[i]!.status).toBe("matched");
    expect(restored[i]!.operationId).toBe(states[i]!.operationId);
    expect(restored[i]!.joinedAtMs).toBe(states[i]!.joinedAtMs);
    expect(restored[i]!.assignment!.matchId).not.toBe(old.matchId);
    rooms.add(restored[i]!.assignment!.roomId);
  }
  expect(new Set(restored.map((s) => s.assignment!.matchId)).size).toBe(1);
});

test("対局中に資格更新が中断しても再起動後のAlarmで復旧し、旧資格を拒否する", async () => {
  let now = Date.now() + 60000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const users = await fixture(4),
    states = await Promise.all(users.map((u) => stub().status(u.account.id, u.controllerId)));
  const a = states[0]!.assignment!;
  rooms.add(a.roomId);
  const room = env.GAME_ROOM.getByName(a.roomId);
  for (const s of states) await connect(a.roomId, s.assignment!.membership.token);
  now += 5000;
  expect(roomSchema.parse(await room.getRoom()).status).toBe("playing");
  await runInDurableObject(stub(), (instance) => instance.alarm());
  // 資格の新世代を永続化した直後、ルームへ届ける前の中断地点から復旧します。
  const controllerId = crypto.randomUUID();
  await runInDurableObject(stub(), async (_, state) => {
    const value = state.storage.kv.get<any>("state");
    const player = value.groups[0].players[0];
    player.controllerId = controllerId;
    player.version++;
    player.credentialPending = true;
    player.tokenHash = (await matchmakingCredential(env, player)).tokenHash;
    state.storage.kv.put("state", value);
  });
  await evictDurableObject(stub());
  expect((await stub().status(users[0]!.account.id, controllerId)).assignment).toBeUndefined();
  await runInDurableObject(stub(), (instance) => instance.alarm());
  const recovered = await stub().status(users[0]!.account.id, controllerId);
  expect(recovered.status).toBe("playing");
  expect(recovered.assignment).toBeDefined();
  expect(recovered.assignment!.membership.token).not.toBe(a.membership.token);
  expect(
    await runInDurableObject(room, (_, state) => state.storage.getAlarm()),
  ).toBeLessThanOrEqual(now + 30000);
  await expect(connect(a.roomId, a.membership.token)).rejects.toThrow();
  await connect(a.roomId, recovered.assignment!.membership.token);
  expect(
    (await stub().status(users[0]!.account.id, users[0]!.controllerId)).assignment,
  ).toBeUndefined();
  const credentials = states.map((s, i) =>
    i === 0 ? recovered.assignment!.membership.token : s.assignment!.membership.token,
  );
  for (const token of credentials) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    await room.leaveRoom(
      Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join(""),
    );
  }
  await stub().cleanupReleasedGroups();
  for (const u of users)
    expect((await stub().status(u.account.id, u.controllerId)).status).toBe("idle");
  expect(
    await runInDurableObject(
      stub(),
      (_, state) => state.storage.kv.get<any>("state").groups.length,
    ),
  ).toBe(0);
});

test("入室後の操作元切替は開始予告を取り消し、全員の再接続から5秒を数え直す", async () => {
  let now = Date.now() + 60000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const users = await fixture(4),
    states = await Promise.all(users.map((u) => stub().status(u.account.id, u.controllerId)));
  const a = states[0]!.assignment!;
  rooms.add(a.roomId);
  const room = env.GAME_ROOM.getByName(a.roomId);
  for (const s of states) await connect(a.roomId, s.assignment!.membership.token);
  const initial = roomSchema.parse(await room.getRoom());
  expect("matchmaking" in initial && initial.matchmaking?.startsAtMs).toBe(now + 5000);
  now += 1000;
  const transfer = await stub().takeover(
    users[0]!.account.id,
    users[0]!.operationId,
    crypto.randomUUID(),
    1,
  );
  expect(transfer.ok).toBe(true);
  if (!transfer.ok) throw Error("引継ぎ");
  const waiting = roomSchema.parse(await room.getRoom());
  expect("matchmaking" in waiting && waiting.matchmaking?.startsAtMs).toBeUndefined();
  expect(transfer.state.assignment!.expiresAtMs).toBe(a.expiresAtMs);
  await connect(a.roomId, transfer.state.assignment!.membership.token);
  const reconnected = roomSchema.parse(await room.getRoom());
  expect("matchmaking" in reconnected && reconnected.matchmaking?.startsAtMs).toBe(now + 5000);
});

test("大会待機との相互排他をD1で守り、取消後だけ待機先を切り替えられる", async () => {
  const [u] = await fixture(1);
  const key = crypto.randomUUID(),
    now = Date.now();
  await env.APP_DB.prepare(
    "INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,created_at_ms,updated_at_ms) VALUES(?,(SELECT COALESCE(MAX(public_id),0)+1 FROM tournaments),'排他確認',?,?,1,?,?)",
  )
    .bind(key, now - 1, now + 60000, now, now)
    .run();
  const reserve = () =>
    env.APP_DB.prepare(
      "INSERT INTO tournament_wait_reservations(account_id,tournament_key,operation_id,lease_until_ms) VALUES(?,?,?,?)",
    )
      .bind(u!.account.id, key, crypto.randomUUID(), now + 30000)
      .run();
  try {
    await expect(reserve()).rejects.toThrow();
    await stub().control(
      u!.account.id,
      { operationId: u!.operationId, controllerId: u!.controllerId, version: 1 },
      "cancel",
    );
    await reserve();
    expect((await stub().join(u!.account.id, crypto.randomUUID(), u!.controllerId)).ok).toBe(false);
  } finally {
    await env.APP_DB.prepare("DELETE FROM tournament_wait_reservations WHERE account_id=?")
      .bind(u!.account.id)
      .run();
    await env.APP_DB.prepare("DELETE FROM tournaments WHERE key=?").bind(key).run();
  }
});

test("ログアウトで待機を解除し、退会・ゲスト連携は待機を越えて成立しない", async () => {
  const [u] = await fixture(1);
  await expect(requireGuestIdle(env, u!.account.id)).rejects.toThrow();
  const signedOut = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/auth/sign-out`, {
      method: "POST",
      headers: u!.account.headers,
      body: "{}",
    }),
  );
  expect(signedOut.status).toBe(200);
  expect((await stub().status(u!.account.id, u!.controllerId)).status).toBe("idle");
  const v = (await fixture(1))[0]!;
  expect(await requestDeletion(env, v.account.id, crypto.randomUUID())).toBe(true);
  await runInDurableObject(stub(), (instance) => instance.alarm());
  expect((await stub().status(v.account.id, v.controllerId)).status).toBe("idle");
  expect((await stub().join(v.account.id, crypto.randomUUID(), v.controllerId)).ok).toBe(false);
  await stub().purgeAccount(v.account.id);
});
for (const humans of [1, 2, 3, 4])
  test(`人間${humans}人で成立し3分切れ負け・不足席のヨミを固定する`, async () => {
    const users = await fixture(humans);
    if (humans < 4) {
      expect((await stub().status(users[0]!.account.id)).status).toBe("waiting");
      await fill();
    }
    const states = await Promise.all(users.map((u) => stub().status(u.account.id, u.controllerId)));
    for (const state of states) {
      expect(state.status).toBe("matched");
      expect(state.assignment).toBeDefined();
      rooms.add(state.assignment!.roomId);
    }
    expect(new Set(states.map((s) => s.assignment!.matchId)).size).toBe(1);
    const a = states[0]!.assignment!;
    const room = roomSchema.parse(await env.GAME_ROOM.getByName(a.roomId).getRoom());
    expect(room.settings.timeControl).toEqual({ mainTimeMs: 180000, byoyomiMs: 0 });
    expect(room.players.filter((p) => p.kind === "human")).toHaveLength(humans);
    const cpus = room.players.filter((p) => p.kind === "cpu");
    expect(cpus).toHaveLength(4 - humans);
    expect(cpus.map((p) => p.name)).toEqual(
      Array.from({ length: 4 - humans }, (_, i) => `ヨミ${i + 1}`),
    );
    for (const p of cpus) {
      expect(p.cpuProfile?.id).toBe("lv3-v1");
      expect(p.cpuProfile?.level).toBe(3);
      expect(p.cpuProfile?.style).toBe("多人数の先読み");
    }
    const outsiders = await exports.default.fetch(
      new AcceptedGameRequest(`${origin}/api/rooms/${a.roomId}/join`, {
        method: "POST",
        headers: users[0]!.account.headers,
        body: JSON.stringify({ name: "横入り" }),
      }),
    );
    expect(outsiders.status).not.toBe(200);
  });
test("待機・再読み込み・旧操作元の取消が重複割当や待機延長を起こさない", async () => {
  const [u] = await fixture(1);
  const before = await stub().status(u!.account.id, u!.controllerId);
  expect((await stub().join(u!.account.id, u!.operationId, u!.controllerId)).ok).toBe(true);
  await evictDurableObject(stub());
  const after = await stub().status(u!.account.id, u!.controllerId);
  expect(after.joinedAtMs).toBe(before.joinedAtMs);
  expect(after.operationId).toBe(before.operationId);
  const controllerId = crypto.randomUUID();
  const transfer = await stub().takeover(u!.account.id, u!.operationId, controllerId, 1);
  expect(transfer.ok).toBe(true);
  expect(
    (
      await stub().control(
        u!.account.id,
        { operationId: u!.operationId, controllerId: u!.controllerId, version: 1 },
        "cancel",
      )
    ).ok,
  ).toBe(false);
  expect((await stub().status(u!.account.id, controllerId)).status).toBe("waiting");
  expect((await stub().takeover(u!.account.id, u!.operationId, crypto.randomUUID(), 1)).ok).toBe(
    false,
  );
  expect(
    (
      await stub().control(
        u!.account.id,
        { operationId: u!.operationId, controllerId, version: 2 },
        "cancel",
      )
    ).ok,
  ).toBe(true);
  expect((await stub().join(u!.account.id, u!.operationId, controllerId)).ok).toBe(false);
});
test("全員の接続後だけカウントダウンし、再起動しても1回だけ開始する", async () => {
  const users = await fixture(4);
  const states = await Promise.all(users.map((u) => stub().status(u.account.id, u.controllerId)));
  const a = states[0]!.assignment!;
  rooms.add(a.roomId);
  const roomStub = env.GAME_ROOM.getByName(a.roomId);
  for (const s of states.slice(0, 3)) await connect(a.roomId, s.assignment!.membership.token);
  let room = roomSchema.parse(await roomStub.getRoom());
  expect(room.status).toBe("waiting");
  if (room.settings.game !== "four-reversi") throw Error("game");
  expect("matchmaking" in room && room.matchmaking?.startsAtMs).toBeUndefined();
  await connect(a.roomId, states[3]!.assignment!.membership.token);
  room = roomSchema.parse(await roomStub.getRoom());
  expect(room.status).toBe("waiting");
  expect("matchmaking" in room && room.matchmaking?.startsAtMs).toBeGreaterThan(Date.now());
  await runInDurableObject(roomStub, async (_instance, state) => {
    const r = roomSchema.parse(state.storage.kv.get("room"));
    if (!("matchmaking" in r) || !r.matchmaking) throw Error("metadata");
    r.matchmaking.startsAtMs = Date.now() - 1;
    state.storage.kv.put("room", r);
  });
  await evictDurableObject(roomStub);
  const playing = roomSchema.parse(await roomStub.getRoom());
  expect(playing.status).toBe("playing");
  expect(playing.clock?.remainingMainMs).toBeDefined();
  expect((await roomStub.getMatchmakingState(a.matchId, a.instanceId)).started).toBe(true);
  expect((await roomStub.abortMatchmakingRoom(a.matchId, a.instanceId)).status).toBe(
    "already_started",
  );
  expect(
    (
      await stub().control(
        users[0]!.account.id,
        { operationId: users[0]!.operationId, controllerId: users[0]!.controllerId, version: 1 },
        "cancel",
      )
    ).ok,
  ).toBe(false);
  expect((await stub().status(users[0]!.account.id, users[0]!.controllerId)).status).toBe(
    "playing",
  );
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM matchmaking_wait_reservations WHERE account_id=?")
      .bind(users[0]!.account.id)
      .first(),
  ).toBeNull();
});
test("待機中の通常ルーム参加を拒否し、取消後は参加できる", async () => {
  const [u] = await fixture(1);
  const create = () =>
    exports.default.fetch(
      new AcceptedGameRequest(`${origin}/api/rooms`, {
        method: "POST",
        headers: u!.account.headers,
        body: JSON.stringify({
          game: "four-reversi",
          mode: "singles",
          quickPlay: false,
          name: "参加者",
        }),
      }),
    );
  expect((await create()).status).toBe(409);
  expect(
    (
      await stub().control(
        u!.account.id,
        { operationId: u!.operationId, controllerId: u!.controllerId, version: 1 },
        "cancel",
      )
    ).ok,
  ).toBe(true);
  const response = await create();
  expect(response.status).toBe(201);
  const body = (await response.json()) as { room: { id: string } };
  rooms.add(body.room.id);
  expect((await stub().join(u!.account.id, crypto.randomUUID(), u!.controllerId)).ok).toBe(false);
});
test("Serviceの準備前は新しいマッチングを受け付けない", async () => {
  const account = await accountFixture();
  accounts.push(account.id);
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/matchmaking/four-reversi/join`, {
      method: "POST",
      headers: account.headers,
      body: JSON.stringify({ controllerId: crypto.randomUUID(), operationId: crypto.randomUUID() }),
    }),
  );
  expect(response.status).toBe(503);
  const state = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/matchmaking/four-reversi`, { headers: account.headers }),
  );
  expect(matchmakingStateSchema.parse(await state.json()).enabled).toBe(false);
});

test("席の確保が一時的に失敗しても、待機を消さず元の優先度で再試行する", async () => {
  const users = await fixture(3);
  const fourth = await accountFixture();
  accounts.push(fourth.id);
  const operationId = crypto.randomUUID(),
    controllerId = crypto.randomUUID();
  const before = await stub().status(users[0]!.account.id, users[0]!.controllerId);
  await env.APP_DB.exec(
    "CREATE TRIGGER fail_matchmaking_transfer BEFORE INSERT ON account_room_seats BEGIN SELECT RAISE(ABORT,'test matchmaking transfer'); END",
  );
  try {
    const result = await stub().join(fourth.id, operationId, controllerId);
    expect(result.ok).toBe(true);
    const pending = await stub().status(users[0]!.account.id, users[0]!.controllerId);
    expect(pending.status).toBe("waiting");
    expect(pending.joinedAtMs).toBe(before.joinedAtMs);
  } finally {
    await env.APP_DB.exec("DROP TRIGGER IF EXISTS fail_matchmaking_transfer");
  }
  await runInDurableObject(stub(), async (_, state) => {
    const value = state.storage.kv.get<{ waiting: { retryAtMs?: number }[] }>("state")!;
    for (const waiting of value.waiting) waiting.retryAtMs = Date.now() - 1;
    state.storage.kv.put("state", value);
  });
  await runInDurableObject(stub(), (instance) => instance.alarm());
  const recovered = await stub().status(fourth.id, controllerId);
  expect(recovered.status).toBe("matched");
  rooms.add(recovered.assignment!.roomId);
  expect(
    (await stub().status(users[0]!.account.id, users[0]!.controllerId)).assignment?.matchId,
  ).toBe(recovered.assignment!.matchId);
});

test("待機が失効した後の遅延更新・再参加は古い操作を復活させない", async () => {
  const [user] = await fixture(1);
  await runInDurableObject(stub(), async (_, state) => {
    const value = state.storage.kv.get<{ waiting: { expiresAtMs: number }[] }>("state")!;
    value.waiting[0]!.expiresAtMs = Date.now();
    state.storage.kv.put("state", value);
  });
  expect((await stub().status(user!.account.id, user!.controllerId)).status).toBe("idle");
  expect(
    (
      await stub().control(
        user!.account.id,
        { operationId: user!.operationId, controllerId: user!.controllerId, version: 1 },
        "heartbeat",
      )
    ).ok,
  ).toBe(false);
  expect((await stub().join(user!.account.id, user!.operationId, user!.controllerId)).ok).toBe(
    false,
  );
  expect((await stub().join(user!.account.id, crypto.randomUUID(), user!.controllerId)).ok).toBe(
    true,
  );
});
