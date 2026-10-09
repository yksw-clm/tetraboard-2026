import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  isReversiRoom,
  publicReversiMatchDetailSchema,
  reversiAccountStatsSchema,
  reversiRankingsSchema,
} from "@tetraboard/protocol";
import { getLegalMoves, applyAction } from "@tetraboard/reversi";
import { RoomBoundaryFixtures, boundaryRequest, boundaryJson } from "./roomBoundaryFixtures";
let fixtures: RoomBoundaryFixtures;
beforeEach(() => {
  fixtures = new RoomBoundaryFixtures();
});
afterEach(async () => {
  await fixtures.dispose();
});
function standard(room: Awaited<ReturnType<RoomBoundaryFixtures["snapshot"]>>["room"]) {
  if (!isReversiRoom(room)) throw Error("Wrong game");
  return room;
}
async function setup(quick = false) {
  const entry = await fixtures.create({ name: "ホスト", game: "reversi", quickPlay: quick });
  const host = await fixtures.connect(entry);
  const joined = quick ? null : await fixtures.join(entry.room.id, "相手");
  const guest = joined ? await fixtures.connect(joined) : null;
  if (guest && joined) {
    guest.send({ type: "room.ready.set", ready: true });
    await host.waitFor(
      "room.snapshot",
      (m) => m.room.players.find((p) => p.id === joined.membership.playerId)?.ready === true,
    );
  }
  host.send({ type: "room.ready.set", ready: true });
  await host.waitFor(
    "room.snapshot",
    (m) => m.room.players.find((p) => p.id === entry.membership.playerId)?.ready === true,
  );
  host.send({ type: "room.game.start" });
  const room = standard(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "playing")).room,
  );
  return { entry, joined, host, guest, room };
}
test("通常リバーシはモード不要で2席、3人目を拒否し、公開一覧も定員2", async () => {
  const entry = await fixtures.create({ game: "reversi", name: "ホスト", quickPlay: false });
  await fixtures.connect(entry);
  expect(entry.room.settings).not.toHaveProperty("mode");
  await fixtures.join(entry.room.id, "相手");
  const full = await boundaryRequest(
    `/rooms/${entry.room.id}/players`,
    boundaryJson({ name: "3人目" }),
  );
  expect(full.status).toBe(409);
  const response = await boundaryRequest("/rooms?game=reversi");
  expect(response.status).toBe(200);
  const { rooms } = (await response.json()) as {
    rooms: { id: string; capacity: number; openSeats: number; mode?: string }[];
  };
  expect(rooms.find((r) => r.id === entry.room.id)).toMatchObject({ capacity: 2, openSeats: 0 });
  expect(rooms.find((r) => r.id === entry.room.id)).not.toHaveProperty("mode");
  for (const mode of ["singles", "doubles"])
    expect(
      (
        await boundaryRequest(
          "/rooms",
          boundaryJson({ game: "reversi", name: "不正", quickPlay: false, mode }),
        )
      ).status,
    ).toBe(400);
});
test("2人が合法手で終局まで進み、棋譜を保存して再戦待機へ戻る", async () => {
  const { entry, joined, host, guest } = await setup();
  let room = standard((await fixtures.snapshot(entry.room.id)).room);
  let moves = 0;
  while (room.status === "playing") {
    const turn = room.game.turn;
    const current = room.players.find((p) => p.color === turn)!;
    const client = current.id === entry.membership.playerId ? host : guest!;
    const move = getLegalMoves(room.game)[0];
    const result = applyAction(room.game, { type: "placeStone", position: move });
    if (!result.ok) throw Error("illegal");
    const expected = result.state;
    client.send({ type: "room.game.action", action: { type: "placeStone", position: move } });
    room = standard(
      (
        await host.waitFor(
          "room.snapshot",
          (m) =>
            m.room.status === "waiting" ||
            (m.room.status === "playing" && m.room.game.moveNumber > moves),
        )
      ).room,
    );
    expect(room.status === "playing" ? room.game.board : room.lastRound?.game.board).toEqual(
      expected.board,
    );
    if (++moves > 60) throw Error("Too many moves");
  }
  expect(room.players).toHaveLength(2);
  expect(room.players.every((p) => !p.ready)).toBe(true);
  expect(room.lastRound?.replay.steps.filter((s) => s.action.type === "place")).toHaveLength(moves);
  const id = room.lastRound!.replay.id;
  await fixtures.snapshot(entry.room.id);
  const response = await boundaryRequest(`/matches/${id}`);
  expect(response.status).toBe(200);
  const { match } = (await response.json()) as { match: unknown };
  const saved = publicReversiMatchDetailSchema.parse(match);
  expect(saved.game).toEqual(room.lastRound!.game);
  expect(saved.settings).not.toHaveProperty("mode");
  const list = await boundaryRequest("/matches?game=reversi&humanOnly=true");
  expect(list.status).toBe(200);
  expect(JSON.stringify(await list.json())).toContain(id);
  host.send({ type: "room.ready.set", ready: true });
  guest!.send({ type: "room.ready.set", ready: true });
  await host.waitFor("room.snapshot", (m) => m.room.players.every((p) => p.ready));
  host.send({ type: "room.game.start" });
  const restarted = standard(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "playing")).room,
  );
  expect(restarted.lastRound).toBeNull();
  expect(restarted.players.map((p) => ("color" in p ? p.color : null)).sort()).toEqual([
    "black",
    "white",
  ]);
  expect(joined).not.toBeNull();
});
test("手番外の投了は拒否し、手番本人の投了で相手が勝つ", async () => {
  const { entry, host, guest, room } = await setup();
  if (room.status !== "playing") throw Error("not playing");
  const black = room.players.find((p) => p.color === "black")!;
  const current = black.id === entry.membership.playerId ? host : guest!;
  const other = current === host ? guest! : host;
  other.send({ type: "room.game.resign" });
  expect((await other.waitFor("room.error")).error).toBe("not_your_turn");
  current.send({ type: "room.game.resign" });
  const ended = standard(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "waiting")).room,
  );
  expect(ended.lastRound?.game.result).toMatchObject({ winner: "white", reason: "last_player" });
  expect(ended.lastRound?.replay.steps.at(-1)?.action).toMatchObject({
    type: "eliminate",
    reason: "resigned",
    color: "black",
  });
});
test.each([1, 2] as const)("CPUレベル%dは期限を保存境界で進めると合法手を指す", async (level) => {
  const entry = await fixtures.create({ game: "reversi", name: "ホスト", quickPlay: true });
  const host = await fixtures.connect(entry);
  const waiting = standard(entry.room);
  expect(waiting.players).toHaveLength(2);
  expect(waiting.players[1]).toMatchObject({ kind: "cpu", level: 1 });
  const cpu = waiting.players.find((p) => p.kind === "cpu")!;
  host.send({ type: "room.cpu.level.set", playerId: cpu.id, level });
  await host.waitFor("room.snapshot", (m) =>
    m.room.players.some((p) => p.kind === "cpu" && p.level === level),
  );
  host.send({ type: "room.game.start" });
  let room = standard(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "playing")).room,
  );
  if (room.status !== "playing") throw Error("not playing");
  const turn = room.game.turn;
  if (room.players.find((p) => p.color === turn)?.kind === "human") {
    host.send({
      type: "room.game.action",
      action: { type: "placeStone", position: getLegalMoves(room.game)[0] },
    });
    room = standard(
      (
        await host.waitFor(
          "room.snapshot",
          (m) => m.room.status === "playing" && m.room.game.moveNumber > 0,
        )
      ).room,
    );
  }
  if (room.status !== "playing") throw Error("not playing");
  const before = room.game.moveNumber;
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  await runInDurableObject(stub, (_instance, state) => {
    const saved = standard(state.storage.kv.get("room") as typeof room);
    if (saved.status !== "playing") throw Error("not playing");
    saved.clock.turnStartedAt = Date.now() - 2001;
    state.storage.kv.put("room", saved);
  });
  await fixtures.snapshot(entry.room.id);
  const updated = standard(
    (
      await host.waitFor(
        "room.snapshot",
        (m) => m.room.status === "playing" && m.room.game.moveNumber > before,
      )
    ).room,
  );
  expect(updated.status === "playing" && updated.game.moveNumber).toBe(before + 1);
});
test("時計の期限ちょうどで敗北し、棋譜へ時間切れを1回だけ記録する", async () => {
  const { entry, host } = await setup();
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  await runInDurableObject(stub, (_instance, state) => {
    const saved = standard(
      state.storage.kv.get("room") as Awaited<ReturnType<RoomBoundaryFixtures["snapshot"]>>["room"],
    );
    if (saved.status !== "playing") throw Error("not playing");
    saved.clock.turnExpiresAt = Date.now();
    state.storage.kv.put("room", saved);
  });
  await runDurableObjectAlarm(stub);
  const ended = standard(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "waiting")).room,
  );
  expect(ended.lastRound?.game.result.winner).toBe("white");
  expect(ended.lastRound?.replay.steps.filter((s) => s.action.type === "eliminate")).toHaveLength(
    1,
  );
  expect(ended.lastRound?.replay.steps[0].action).toMatchObject({ reason: "timeout" });
  const ranking = await boundaryRequest("/games/reversi/rankings");
  expect(ranking.status).toBe(200);
  reversiRankingsSchema.parse(await ranking.json());
  expect(reversiAccountStatsSchema.parse({ total: 1, wins: 0, losses: 0, draws: 1 }).total).toBe(1);
});

test("保存失敗後に部屋を閉鎖しても保存待ちを保持し、復旧後の再送で1局だけ保存する", async () => {
  const { entry, host, guest, room } = await setup();
  if (room.status !== "playing") throw Error("not playing");
  const turn = room.game.turn;
  const player = room.players.find((p) => p.color === turn)!;
  const current = player.id === entry.membership.playerId ? host : guest!;
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  let id = "";
  await env.APP_DB.exec("ALTER TABLE matches RENAME TO reversi_save_unavailable");
  try {
    current.send({ type: "room.game.resign" });
    const ended = standard(
      (await host.waitFor("room.snapshot", (m) => m.room.status === "waiting")).room,
    );
    id = ended.lastRound!.replay.id;
    await fixtures.snapshot(entry.room.id);
    const pending = await runInDurableObject(stub, (_instance, state) =>
      state.storage.kv.get<{ record: { id: string }; retryAtMs: number }>(`match-pending:${id}`),
    );
    expect(pending?.record.id).toBe(id);
    expect(pending?.retryAtMs).toBeGreaterThan(Date.now());
    await fixtures.dispose();
    fixtures = new RoomBoundaryFixtures();
    expect(
      await runInDurableObject(stub, (_instance, state) => state.storage.kv.get("room")),
    ).toBeUndefined();
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.kv.get(`match-pending:${id}`),
      ),
    ).toBeDefined();
  } finally {
    await env.APP_DB.exec("ALTER TABLE reversi_save_unavailable RENAME TO matches");
  }
  await runInDurableObject(stub, async (_instance, state) => {
    const key = `match-pending:${id}`;
    const job = state.storage.kv.get<{ record: unknown; retryAtMs: number }>(key);
    if (!job) throw Error("Missing pending save");
    state.storage.kv.put(key, { ...job, retryAtMs: Date.now() - 1 });
    await state.storage.setAlarm(Date.now());
  });
  await runDurableObjectAlarm(stub);
  await vi.waitFor(async () => {
    expect(
      await env.APP_DB.prepare("SELECT COUNT(*) AS count FROM matches WHERE id=?").bind(id).first(),
    ).toEqual({ count: 1 });
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.kv.get(`match-pending:${id}`),
      ),
    ).toBeUndefined();
  });
  expect((await boundaryRequest(`/matches/${id}`)).status).toBe(200);
});
