import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import {
  fourShogiRoomSchema,
  isFourShogiRoom,
  tournamentRules,
  type RoomSocketClientMessage,
} from "@tetraboard/protocol";
import {
  useTournamentRoomFixtures,
  sockets,
  request,
  token,
  fixture,
  connect,
  connected,
  alarmAt,
  playing,
} from "./tournamentRoomFixtures";

useTournamentRoomFixtures();

test("4人目の認証済み接続までは開始期限を作らず、認証前の接続を人数に含めない", async () => {
  const prepared = await fixture();
  expect(await prepared.stub.prepareTournamentRoom(prepared.input)).toEqual({ status: "prepared" });
  for (const credential of prepared.tokens.slice(0, 3))
    await connect(prepared.input.roomId, credential);
  expect(await prepared.stub.getRoom()).not.toHaveProperty("tournamentStartsAtMs");
  const response = await request(`/api/rooms/${prepared.input.roomId}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  response.webSocket!.accept();
  sockets.push(response.webSocket!);
  expect(await prepared.stub.getRoom()).not.toHaveProperty("tournamentStartsAtMs");
  await connect(prepared.input.roomId, prepared.tokens[3]!);
  await vi.waitFor(async () =>
    expect(await prepared.stub.getRoom()).toHaveProperty("tournamentStartsAtMs"),
  );
});

test("全員接続後も開始期限の直前までは待機し、永続化した期限のAlarmで一度だけ開始する", async () => {
  const prepared = await connected();
  const room = fourShogiRoomSchema.parse(await prepared.stub.getRoom());
  expect(room.status).toBe("waiting");
  expect(room).toHaveProperty("tournamentStartsAtMs", prepared.startsAtMs);
  expect(prepared.startsAtMs - room.lastActivityAtMs).toBeGreaterThanOrEqual(
    tournamentRules.startCountdownMs,
  );
  expect(
    await runInDurableObject(prepared.stub, (_instance, state) => state.storage.getAlarm()),
  ).toBe(prepared.startsAtMs);
  await alarmAt(prepared, prepared.startsAtMs - 1);
  expect(
    (await prepared.stub.getTournamentReservationState(prepared.input.context.matchId)).status,
  ).toBe("waiting");
  await alarmAt(prepared, prepared.startsAtMs);
  expect(
    await prepared.stub.getTournamentReservationState(prepared.input.context.matchId),
  ).toMatchObject({
    status: "playing",
    startedAtMs: prepared.startsAtMs,
  });
  const started = fourShogiRoomSchema.parse(await prepared.stub.getRoom());
  expect(started.status).toBe("playing");
  expect(started).not.toHaveProperty("tournamentStartsAtMs");
  await alarmAt(prepared, prepared.startsAtMs + 1);
  expect(fourShogiRoomSchema.parse(await prepared.stub.getRoom()).roundId).toBe(
    prepared.input.context.matchId,
  );
});

test("一人の最後の接続が切れると開始期限を解除し、全員の再接続から5秒を数え直す", async () => {
  const prepared = await connected();
  prepared.clients[3]!.socket.close();
  await prepared.clients[0]!.until(
    (message) =>
      message.type === "room.snapshot" &&
      isFourShogiRoom(message.room) &&
      message.room.status === "waiting" &&
      message.room.tournamentStartsAtMs === undefined &&
      !message.presence.connectedPlayerIds.includes(prepared.input.players[3]!.admission.playerId),
  );
  expect(
    await prepared.stub.getTournamentReservationState(prepared.input.context.matchId),
  ).toMatchObject({ status: "waiting" });
  await alarmAt(prepared, prepared.startsAtMs);
  expect((await prepared.stub.getRoom())?.status).toBe("waiting");
  const clock = vi.spyOn(Date, "now").mockReturnValue(prepared.startsAtMs + 1000);
  let reconnectAt: number;
  try {
    await connect(prepared.input.roomId, prepared.tokens[3]!);
    const snapshot = await prepared.clients[0]!.until(
      (message) =>
        message.type === "room.snapshot" &&
        isFourShogiRoom(message.room) &&
        message.room.status === "waiting" &&
        message.room.tournamentStartsAtMs !== undefined,
    );
    if (
      snapshot.type !== "room.snapshot" ||
      !isFourShogiRoom(snapshot.room) ||
      snapshot.room.status !== "waiting"
    )
      throw new Error("Missing reconnect countdown");
    reconnectAt = snapshot.room.tournamentStartsAtMs!;
    expect(reconnectAt).toBe(prepared.startsAtMs + 1000 + tournamentRules.startCountdownMs);
  } finally {
    clock.mockRestore();
  }
  await alarmAt(prepared, reconnectAt - 1);
  expect((await prepared.stub.getRoom())?.status).toBe("waiting");
  await alarmAt(prepared, reconnectAt);
  expect((await prepared.stub.getRoom())?.status).toBe("playing");
});

test("同じ参加資格の別接続が残っている間は開始期限を解除しない", async () => {
  const prepared = await connected();
  const duplicate = await connect(prepared.input.roomId, prepared.tokens[0]!);
  prepared.clients[0]!.socket.close();
  await vi.waitFor(async () => {
    const connections = await runInDurableObject(
      prepared.stub,
      (_instance, state) =>
        state.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN).length,
    );
    expect(connections).toBe(4);
  });
  expect(await prepared.stub.getRoom()).toHaveProperty("tournamentStartsAtMs", prepared.startsAtMs);
  await alarmAt(prepared, prepared.startsAtMs);
  await duplicate.until(
    (message) => message.type === "room.snapshot" && message.room.status === "playing",
  );
});

test("操作元の引継ぎは旧接続を失効し開始期限を解除するが、同じ対局の新接続で再開できる", async () => {
  const prepared = await connected();
  const credential = await token();
  const player = prepared.input.players[0]!.admission;
  const rekey = {
    matchId: prepared.input.context.matchId,
    instanceId: prepared.input.instanceId,
    accountId: player.accountId,
    operationId: player.operationId,
    playerId: player.playerId,
    version: 1,
    tokenHash: credential.hash,
  };
  expect(await prepared.stub.rekeyTournamentPlayer(rekey)).toEqual({ status: "updated" });
  expect(
    await prepared.clients[0]!.until((message) => message.type === "room.tournament.return"),
  ).toMatchObject({ reason: "transferred", tournamentId: prepared.input.context.tournamentId });
  expect(await prepared.stub.getRoom()).not.toHaveProperty("tournamentStartsAtMs");
  expect(
    await prepared.stub.rekeyTournamentPlayer({
      ...rekey,
      tokenHash: prepared.input.players[0]!.tokenHash,
    }),
  ).toEqual({ status: "stale" });
  expect(await prepared.stub.rekeyTournamentPlayer(rekey)).toEqual({ status: "updated" });
  const now = prepared.startsAtMs + 1000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    await connect(prepared.input.roomId, credential.raw);
    expect(await prepared.stub.getRoom()).toMatchObject({
      status: "waiting",
      instanceId: prepared.input.instanceId,
      tournamentStartsAtMs: now + tournamentRules.startCountdownMs,
    });
  } finally {
    clock.mockRestore();
  }
  prepared.input.players[0]!.tokenHash = credential.hash;
});

test("開始カウントダウンより大会締切が先なら、未開始で閉鎖して得点を付けない", async () => {
  const prepared = await connected(4000);
  expect(prepared.startsAtMs).toBeGreaterThan(prepared.input.context.endsAtMs);
  await alarmAt(prepared, prepared.input.context.endsAtMs);
  expect(
    await prepared.stub.getTournamentReservationState(prepared.input.context.matchId),
  ).toMatchObject({ status: "closed" });
  expect(
    await env.APP_DB.prepare("SELECT phase,started_at_ms FROM tournament_matches WHERE id=?")
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ phase: "aborted", started_at_ms: null });
});

test("全員の接続が遅れても準備から30秒の期限を延長しない", async () => {
  const prepared = await fixture();
  expect(await prepared.stub.prepareTournamentRoom(prepared.input)).toEqual({ status: "prepared" });
  const reservation = await runInDurableObject(prepared.stub, (_instance, state) =>
    state.storage.kv.get<{ preparedAtMs: number }>(
      `tournament-reservation:${prepared.input.context.matchId}`,
    )!,
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(reservation.preparedAtMs + 27000);
  try {
    for (const credential of prepared.tokens) await connect(prepared.input.roomId, credential);
    expect(await prepared.stub.getRoom()).toHaveProperty(
      "tournamentStartsAtMs",
      reservation.preparedAtMs + 32000,
    );
  } finally {
    clock.mockRestore();
  }
  await alarmAt(prepared, reservation.preparedAtMs + tournamentRules.connectionGraceMs);
  expect(
    await prepared.stub.getTournamentReservationState(prepared.input.context.matchId),
  ).toMatchObject({ status: "closed" });
});

test("5秒待機中に参加資格が失われると、期限の再検証で開始を拒否する", async () => {
  const prepared = await connected();
  await env.APP_DB.prepare(
    "UPDATE tournament_entries SET deleted=1 WHERE tournament_key=? AND account_id=?",
  )
    .bind(prepared.input.context.tournamentKey, prepared.accounts[0]!.id)
    .run();
  await alarmAt(prepared, prepared.startsAtMs);
  expect(
    await prepared.stub.getTournamentReservationState(prepared.input.context.matchId),
  ).toMatchObject({ status: "closed" });
  expect(
    await env.APP_DB.prepare("SELECT phase,started_at_ms FROM tournament_matches WHERE id=?")
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ phase: "aborted", started_at_ms: null });
});

test("大会は4人接続後の5秒で固定IDの対局を一度だけ開始し、通常参加・設定・引分・再戦を拒否する", async () => {
  const prepared = await playing();
  const room = fourShogiRoomSchema.parse(await prepared.stub.getRoom());
  expect(room.tournamentId).toBe(prepared.input.context.tournamentId);
  expect(room.roundId).toBe(prepared.input.context.matchId);
  expect(room.settings).toMatchObject({
    mode: "singles",
    timeControl: { mainTimeMs: 0, byoyomiMs: 30_000 },
    threePlayerAttackProhibited: true,
  });
  expect(await prepared.stub.prepareTournamentRoom(prepared.input)).toEqual({
    status: "already_prepared",
  });
  expect(await prepared.stub.abortTournamentRoom(prepared.input.context.matchId)).toEqual({
    status: "already_started",
  });
  const join = await request(`/api/rooms/${room.id}/players`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "参加者" }),
  });
  expect(join.status).toBe(409);
  expect(await join.json()).toEqual({ error: "tournament_required" });
  const commands: RoomSocketClientMessage[] = [
    { type: "room.game.start" as const },
    {
      type: "room.time-control.set" as const,
      timeControl: { mainTimeMs: 60_000, byoyomiMs: 30_000 },
    },
    { type: "room.cpu.add" as const, level: 1 as const },
    {
      type: "room.game.draw.set" as const,
      proposed: true,
      roundId: prepared.input.context.matchId,
      positionRevision: 0,
    },
  ];
  for (const command of commands) {
    prepared.clients[0].send(command);
    expect(await prepared.clients[0].until((message) => message.type === "room.error")).toEqual({
      type: "room.error",
      error: "forbidden",
    });
  }
  expect(
    (await prepared.stub.getTournamentReservationState(prepared.input.context.matchId)).status,
  ).toBe("playing");
});

test("未開始の取消は遅延prepareを防ぎ、準備済みの一人退室は4人全席を解放する", async () => {
  const cancelled = await fixture();
  expect(await cancelled.stub.abortTournamentRoom(cancelled.input.context.matchId)).toEqual({
    status: "cancelled",
  });
  expect(await cancelled.stub.prepareTournamentRoom(cancelled.input)).toEqual({
    status: "cancelled",
  });
  const prepared = await fixture();
  expect(await prepared.stub.prepareTournamentRoom(prepared.input)).toEqual({ status: "prepared" });
  expect(
    (
      await request(`/api/rooms/${prepared.input.roomId}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${prepared.tokens[0]}` },
      })
    ).status,
  ).toBe(204);
  expect(
    await prepared.stub.getTournamentReservationState(prepared.input.context.matchId),
  ).toMatchObject({ status: "closed" });
  await vi.waitFor(async () =>
    expect(
      await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_room_seats WHERE room_id=?")
        .bind(prepared.input.roomId)
        .first(),
    ).toEqual({ n: 0 }),
  );
  expect(
    await env.APP_DB.prepare("SELECT phase FROM tournament_matches WHERE id=?")
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ phase: "aborted" });
});

test("締切ちょうどの未開始予約は閉鎖し、得点を付けない", async () => {
  const prepared = await fixture();
  expect(await prepared.stub.prepareTournamentRoom(prepared.input)).toEqual({ status: "prepared" });
  vi.spyOn(Date, "now").mockReturnValue(prepared.input.context.endsAtMs);
  expect(
    await prepared.stub.getTournamentReservationState(prepared.input.context.matchId),
  ).toMatchObject({ status: "closed" });
  expect(
    await env.APP_DB.prepare("SELECT phase FROM tournament_matches WHERE id=?")
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ phase: "aborted" });
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM tournament_point_events WHERE match_id=?")
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ n: 0 });
});
