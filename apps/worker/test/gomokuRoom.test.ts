import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  isGomokuRoom,
  publicGomokuMatchDetailSchema,
  gomokuAccountStatsSchema,
  reversiRankingsSchema,
} from "@tetraboard/protocol";
import { getLegalMoves, applyAction } from "@tetraboard/gomoku";
import { RoomBoundaryFixtures, boundaryRequest, boundaryJson } from "./roomBoundaryFixtures";
let fixtures: RoomBoundaryFixtures;
beforeEach(() => {
  fixtures = new RoomBoundaryFixtures();
});
afterEach(async () => {
  await fixtures.dispose();
});
function standard(room: Awaited<ReturnType<RoomBoundaryFixtures["snapshot"]>>["room"]) {
  if (!isGomokuRoom(room)) throw Error("Wrong game");
  return room;
}

test("禁手設定は初期ON、ホストだけが待機中に変更でき、人間の準備を解除する", async () => {
  const entry = await fixtures.create({
    game: "gomoku",
    name: "ホスト",
    quickPlay: true,
    cpuLevel: 2,
  });
  const host = await fixtures.connect(entry);
  const waiting = standard(entry.room);
  expect(waiting.settings.forbiddenRules).toBe(true);
  expect(waiting.players[1]).toMatchObject({ kind: "cpu", level: 2, ready: true });
  host.send({ type: "room.gomoku-forbidden.set", enabled: false });
  const changed = standard(
    (
      await host.waitFor(
        "room.snapshot",
        (m) => isGomokuRoom(m.room) && !m.room.settings.forbiddenRules,
      )
    ).room,
  );
  expect(changed.players.map((p) => p.ready)).toEqual([false, true]);
  host.send({ type: "room.ready.set", ready: true });
  await host.waitFor("room.snapshot", (m) => m.room.players.every((p) => p.ready));
  host.send({ type: "room.game.start" });
  const started = standard(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "playing")).room,
  );
  expect(started.game?.forbiddenRules).toBe(false);
  host.send({ type: "room.gomoku-forbidden.set", enabled: true });
  expect((await host.waitFor("room.error")).error).toBe("already_started");
});

test("禁手拒否は本人だけへ理由を返し、局面・時計・棋譜を変えず、古い着手を拒否する", async () => {
  const { entry, host, guest } = await setup();
  let room = standard((await fixtures.snapshot(entry.room.id)).room);
  const observer = await fixtures.open(entry.room.id);
  for (const [x, y] of [
    [6, 7],
    [0, 0],
    [8, 7],
    [2, 0],
    [7, 6],
    [4, 0],
    [7, 8],
    [6, 0],
  ]) {
    if (room.status !== "playing") throw Error("finished early");
    const client =
      room.players.find((p) => p.color === room.game!.turn)!.id === entry.membership.playerId
        ? host
        : guest!;
    const revision = room.positionRevision;
    client.send({
      type: "room.game.action",
      roundId: room.roundId,
      positionRevision: revision,
      action: { type: "placeGomokuStone", position: { x, y } },
    });
    room = standard(
      (
        await host.waitFor(
          "room.snapshot",
          (m) => isGomokuRoom(m.room) && m.room.positionRevision > revision,
        )
      ).room,
    );
  }
  if (room.status !== "playing") throw Error("not playing");
  const black =
    room.players.find((p) => p.color === "black")!.id === entry.membership.playerId ? host : guest!;
  const white = black === host ? guest! : host;
  white.send({ type: "room.gomoku-forbidden.set", enabled: false });
  expect((await white.waitFor("room.error")).error).toBe("already_started");
  const before = structuredClone(room);
  const command = {
    type: "room.game.action" as const,
    roundId: room.roundId,
    positionRevision: room.positionRevision,
    action: { type: "placeGomokuStone" as const, position: { x: 7, y: 7 } },
  };
  black.send(command);
  expect((await black.waitFor("room.error")).error).toBe("gomoku_double_three");
  const after = standard((await fixtures.snapshot(entry.room.id)).room);
  expect(after.game).toEqual(before.game);
  expect(after.clock).toEqual(before.clock);
  expect(after.positionRevision).toBe(before.positionRevision);
  expect(observer.hasMessage("room.error")).toBe(false);
  black.send({ ...command, positionRevision: 0 });
  expect((await black.waitFor("room.error")).error).toBe("stale_position");
  black.send({ ...command, action: { type: "placeGomokuStone", position: { x: 14, y: 14 } } });
  const accepted = standard(
    (
      await host.waitFor(
        "room.snapshot",
        (m) => isGomokuRoom(m.room) && m.room.positionRevision > before.positionRevision,
      )
    ).room,
  );
  expect(accepted.game?.lastMove).toEqual({ x: 14, y: 14 });
  const replay = await runInDurableObject(
    env.GAME_ROOM.getByName(entry.room.id),
    (_instance, state) => state.storage.kv.get<{ steps: unknown[] }>("round-replay"),
  );
  expect(replay?.steps).toHaveLength(9);
});
async function setup(quick = false) {
  const entry = await fixtures.create({ name: "ホスト", game: "gomoku", quickPlay: quick });
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
test("五目並べはモード不要で2席、3人目を拒否し、公開一覧も定員2", async () => {
  const entry = await fixtures.create({ game: "gomoku", name: "ホスト", quickPlay: false });
  await fixtures.connect(entry);
  expect(entry.room.settings).not.toHaveProperty("mode");
  await fixtures.join(entry.room.id, "相手");
  const full = await boundaryRequest(
    `/rooms/${entry.room.id}/players`,
    boundaryJson({ name: "3人目" }),
  );
  expect(full.status).toBe(409);
  const response = await boundaryRequest("/rooms?game=gomoku");
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
          boundaryJson({ game: "gomoku", name: "不正", quickPlay: false, mode }),
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
    client.send({
      type: "room.game.action",
      roundId: room.roundId,
      positionRevision: room.positionRevision,
      action: { type: "placeGomokuStone", position: move },
    });
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
    if (++moves > 225) throw Error("Too many moves");
  }
  expect(room.players).toHaveLength(2);
  expect(room.players.every((p) => !p.ready)).toBe(true);
  expect(room.lastRound?.replay.steps.filter((s) => s.action.type === "place")).toHaveLength(moves);
  const id = room.lastRound!.replay.id;
  await fixtures.snapshot(entry.room.id);
  const response = await boundaryRequest(`/matches/${id}`);
  expect(response.status).toBe(200);
  const { match } = (await response.json()) as { match: unknown };
  const saved = publicGomokuMatchDetailSchema.parse(match);
  expect(saved.game).toEqual(room.lastRound!.game);
  expect(saved.settings).not.toHaveProperty("mode");
  const list = await boundaryRequest("/matches?game=gomoku&humanOnly=true");
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
  const entry = await fixtures.create({ game: "gomoku", name: "ホスト", quickPlay: true });
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
      roundId: room.roundId,
      positionRevision: room.positionRevision,
      action: { type: "placeGomokuStone", position: getLegalMoves(room.game)[0] },
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
  const ranking = await boundaryRequest("/games/gomoku/rankings");
  expect(ranking.status).toBe(200);
  reversiRankingsSchema.parse(await ranking.json());
  expect(gomokuAccountStatsSchema.parse({ total: 1, wins: 0, losses: 0, draws: 1 }).total).toBe(1);
});

test("保存失敗後に部屋を閉鎖しても保存待ちを保持し、復旧後の再送で1局だけ保存する", async () => {
  const { entry, host, guest, room } = await setup();
  if (room.status !== "playing") throw Error("not playing");
  const turn = room.game.turn;
  const player = room.players.find((p) => p.color === turn)!;
  const current = player.id === entry.membership.playerId ? host : guest!;
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  let id = "";
  await env.APP_DB.exec("ALTER TABLE matches RENAME TO gomoku_save_unavailable");
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
    await env.APP_DB.exec("ALTER TABLE gomoku_save_unavailable RENAME TO matches");
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
