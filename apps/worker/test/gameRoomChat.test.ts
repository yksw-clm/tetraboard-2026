import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  listReportsContract,
  moderateReportContract,
  reportContract,
  fourReversiRoomSchema as roomSchema,
  viewerContract,
} from "@tetraboard/protocol";
import { expect, test, vi } from "vitest";
import * as monthlyKpi from "../src/kpi/monthly";
import worker from "../src/worker";
import {
  registerGameRoomFixtures,
  createRoom,
  authenticatedRoom,
  openRoom,
  joinRoom,
  expectPending,
  leaveRoom,
  baseUrl,
  startFourPlayerRoom,
  expirePlayers,
  getRoom,
} from "./gameRoomFixtures";

registerGameRoomFixtures();

test("入退室・CPU操作・モード変更のログは一度だけ記録し、再接続では追加しない", async () => {
  const created = await createRoom();
  const id = created.room.id;
  const host = await authenticatedRoom(id, created.membership.token);
  const observer = await openRoom(id);
  const initial = await observer.nextChatWhere((entries) => entries.length === 1);
  expect(initial[0]).toMatchObject({
    kind: "system",
    event: "joined",
    text: "ホストが入室しました",
  });
  const joined = await joinRoom(id, "二人目");
  const player = await authenticatedRoom(id, joined.membership.token);
  await host.nextChatWhere((entries) => entries.at(-1)?.text === "二人目が入室しました");
  host.send({ type: "room.cpu.add", level: 2 });
  const withCpu = await host.nextSnapshotWhere((room) => room.players.length === 3);
  const cpu = withCpu.players.find((entry) => entry.kind === "cpu")!;
  await host.nextChatWhere((entries) => entries.at(-1)?.text === "CPU Lv2が入室しました");
  host.send({ type: "room.cpu.remove", playerId: cpu.id });
  await host.nextChatWhere((entries) => entries.at(-1)?.text === "CPU Lv2が退室しました");
  host.send({ type: "room.mode.set", mode: "doubles" });
  await host.nextChatWhere(
    (entries) => entries.at(-1)?.text === "対局形式がダブルスに変更されました",
  );
  host.send({ type: "room.mode.set", mode: "doubles" });
  await host.nextSnapshotWhere((room) => room.settings.mode === "doubles");
  player.close();
  await expectPending(id, joined.membership.playerId);
  await authenticatedRoom(id, joined.membership.token);
  const reloaded = await openRoom(id);
  const history = await reloaded.nextChatWhere((entries) => entries.length === 5);
  expect(
    history.filter((entry) => entry.kind === "system" && entry.event === "mode_changed"),
  ).toHaveLength(1);
  expect((await leaveRoom(id, joined.membership.token)).status).toBe(204);
  const afterLeave = await host.nextChatWhere(
    (entries) => entries.at(-1)?.text === "二人目が退室しました",
  );
  expect(afterLeave.filter((entry) => entry.text === "二人目が退室しました")).toHaveLength(1);
  const report = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}/rooms/${id}/reports`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.membership.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messageId: initial[0].id }),
    }),
  );
  expect(report.status).toBe(404);
});

test("新規投稿は絵文字を含め100文字までとし、旧200文字履歴も閲覧・通報できる", async () => {
  const created = await createRoom();
  const id = created.room.id;
  const host = await authenticatedRoom(id, created.membership.token);
  const legacy = {
    id: crypto.randomUUID(),
    senderId: created.membership.playerId,
    senderName: "ホスト",
    text: "あ".repeat(200),
    sentAtMs: Date.now(),
  };
  await runInDurableObject(env.GAME_ROOM.getByName(id), (_instance, state) => {
    state.storage.kv.put("chat", [legacy]);
  });
  const observer = await openRoom(id);
  expect(
    (await observer.nextChatWhere((entries) => entries[0]?.id === legacy.id))[0],
  ).toMatchObject({ kind: "player", text: legacy.text });
  host.send({ type: "room.chat.send", text: "👨‍👩‍👧‍👦".repeat(100) });
  expect((await observer.nextChatWhere((entries) => entries.length === 2)).at(-1)?.text).toBe(
    "👨‍👩‍👧‍👦".repeat(100),
  );
  host.send({ type: "room.chat.send", text: "👨‍👩‍👧‍👦".repeat(101) });
  expect((await host.nextType("room.chat.error")).error).toBe("invalid_request");
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}/rooms/${id}/reports`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.membership.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messageId: legacy.id }),
    }),
  );
  expect(response.status).toBe(201);
});

test("対局中の復帰期限切れログは、終局時に重複せずカード情報も残す", async () => {
  const { id, participants, connections, room } = await startFourPlayerRoom();
  const observer = await openRoom(id);
  const player = participants[1];
  connections[1].close();
  await expectPending(id, player.playerId);
  await expirePlayers(id, [player.playerId]);
  const entries = await observer.nextChatWhere((messages) =>
    messages.some((entry) => entry.text === "参加者2が退室しました"),
  );
  expect(entries.filter((entry) => entry.text === "参加者2が退室しました")).toHaveLength(1);
  expect((await getRoom(id)).players).toHaveLength(4);
  const remaining = room.players.filter((entry) => entry.id !== player.playerId);
  for (const entry of remaining.slice(1)) {
    const member = participants.find((participant) => participant.playerId === entry.id)!;
    await leaveRoom(id, member.token);
  }
  const after = await openRoom(id);
  const history = await after.nextChatWhere((messages) =>
    messages.some((entry) => entry.text === "参加者2が退室しました"),
  );
  expect(history.filter((entry) => entry.text === "参加者2が退室しました")).toHaveLength(1);
});

test("チャットは認証・文字数・間隔を検証し、直近100件を再接続先へ送る", async () => {
  const created = await createRoom();
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  const spectator = await openRoom(created.room.id);
  spectator.send({ type: "room.chat.send", text: "観戦者" });
  expect((await spectator.nextType("room.error")).error).toBe("unauthorized");
  host.send({ type: "room.chat.send", text: "最初" });
  expect(
    (await spectator.nextChatWhere((messages) => messages.at(-1)?.text === "最初")).at(-1)?.text,
  ).toBe("最初");
  host.send({ type: "room.chat.send", text: "連投" });
  expect((await host.nextType("room.chat.error")).error).toBe("rate_limited");
  host.send({ type: "room.chat.send", text: "https://example.com" });
  expect((await host.nextType("room.chat.error")).error).toBe("invalid_request");
  host.send({ type: "room.chat.send", text: "あ".repeat(101) });
  expect((await host.nextType("room.chat.error")).error).toBe("invalid_request");
  await runInDurableObject(env.GAME_ROOM.getByName(created.room.id), (_instance, state) => {
    const history = state.storage.kv.get<import("@tetraboard/protocol").ChatEntry[]>("chat")!;
    const sentAtMs = Date.now() - 300_001;
    history[history.length - 1].sentAtMs = sentAtMs - 3_001;
    const posts = Array.from({ length: 99 }, (_, index) => ({
      id: crypto.randomUUID(),
      senderId: created.membership.playerId,
      senderName: created.room.players[0].name,
      text: `投稿${index + 1}`,
      sentAtMs: sentAtMs + index * 3_001,
    }));
    state.storage.kv.put("chat", [...history, ...posts].slice(-100));
    state.storage.kv.put(`last-chat-at:${created.membership.playerId}`, Date.now() - 3_001);
  });
  host.send({ type: "room.chat.send", text: "投稿100" });
  const broadcast = await spectator.nextChatWhere(
    (messages) => messages.at(-1)?.text === "投稿100",
  );
  const reloaded = await openRoom(created.room.id);
  const history = await reloaded.nextChatWhere((messages) => messages.length === 100);
  expect(history).toEqual(broadcast);
  expect(history.map((message) => message.text)).toEqual(
    Array.from({ length: 100 }, (_, index) => `投稿${index + 1}`),
  );
  expect(history[0].text).toBe("投稿1");
  expect(history.at(-1)?.text).toBe("投稿100");
  expect((await getRoom(created.room.id)).status).toBe("waiting");
});

test("観戦者は匿名資格で通報し、運営者が削除・送信停止できる", async () => {
  const created = await createRoom();
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  host.send({ type: "room.chat.send", text: "確認対象" });
  const message = (await host.nextChatWhere((messages) => messages.at(-1)?.text === "確認対象")).at(
    -1,
  )!;
  const viewerResponse = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${viewerContract.pathFor(created.room.id)}`, {
      method: "POST",
    }),
  );
  expect(viewerResponse.status).toBe(201);
  const viewer = viewerContract.response.parse(await viewerResponse.json());
  const reportRequest = () =>
    new AcceptedGameRequest(`${baseUrl}${reportContract.pathFor(created.room.id)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${viewer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: message.id }),
    });
  const reported = await exports.default.fetch(reportRequest());
  expect(reported.status).toBe(201);
  const reportId = reportContract.response.parse(await reported.json()).id;
  expect((await exports.default.fetch(reportRequest())).status).toBe(409);
  const unauthorized = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${listReportsContract.path}`),
  );
  expect(unauthorized.status).toBe(401);
  const auth = { Authorization: "Bearer test-moderator-token" };
  const listing = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${listReportsContract.path}`, { headers: auth }),
  );
  expect(listing.status).toBe(200);
  expect(
    listReportsContract.response
      .parse(await listing.json())
      .reports.some((report) => report.id === reportId),
  ).toBe(true);
  const action = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${moderateReportContract.pathFor(reportId)}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_and_mute" }),
    }),
  );
  expect(action.status).toBe(200);
  expect(moderateReportContract.response.parse(await action.json()).status).toBe("resolved");
  expect(
    (
      await host.nextChatWhere((messages) => messages.every((entry) => entry.kind === "system"))
    ).every((entry) => entry.kind === "system"),
  ).toBe(true);
  host.send({ type: "room.chat.send", text: "再投稿" });
  expect((await host.nextType("room.chat.error")).error).toBe("muted");
});

test("通報D1障害は成功扱いにせず、期限切れ通報を定期削除する", async () => {
  vi.spyOn(monthlyKpi, "savePreviousMonthKpi").mockResolvedValue();
  const created = await createRoom();
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  host.send({ type: "room.chat.send", text: "通報対象" });
  const message = (await host.nextChatWhere((messages) => messages.at(-1)?.text === "通報対象")).at(
    -1,
  )!;
  const request = () =>
    new AcceptedGameRequest(`${baseUrl}${reportContract.pathFor(created.room.id)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.membership.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messageId: message.id }),
    });
  await env.APP_DB.exec("ALTER TABLE reports RENAME TO reports_unavailable");
  try {
    expect((await exports.default.fetch(request())).status).toBe(500);
  } finally {
    await env.APP_DB.exec("ALTER TABLE reports_unavailable RENAME TO reports");
  }
  const response = await exports.default.fetch(request());
  expect(response.status).toBe(201);
  const id = reportContract.response.parse(await response.json()).id;
  await env.APP_DB.prepare("UPDATE reports SET expires_at_ms = ? WHERE id = ?")
    .bind(Date.now() - 1, id)
    .run();
  const listing = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${listReportsContract.path}`, {
      headers: { Authorization: "Bearer test-moderator-token" },
    }),
  );
  expect(
    listReportsContract.response
      .parse(await listing.json())
      .reports.some((entry) => entry.id === id),
  ).toBe(false);
  await worker.scheduled({} as ScheduledController, env);
  expect(
    await env.APP_DB.prepare("SELECT id FROM reports WHERE id = ?").bind(id).first(),
  ).toBeNull();
});

test("通報済みの旧世代へ処分しても再利用された部屋を変更しない", async () => {
  const created = await createRoom();
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  host.send({ type: "room.chat.send", text: "旧ルーム" });
  const message = (await host.nextChatWhere((messages) => messages.at(-1)?.text === "旧ルーム")).at(
    -1,
  )!;
  const report = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${reportContract.pathFor(created.room.id)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.membership.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messageId: message.id }),
    }),
  );
  expect(report.status).toBe(201);
  const reportId = reportContract.response.parse(await report.json()).id;
  expect((await leaveRoom(created.room.id, created.membership.token)).status).toBe(204);
  const replacement = roomSchema.parse({
    ...created.room,
    instanceId: crypto.randomUUID(),
    lastActivityAtMs: Date.now(),
    players: [{ ...created.room.players[0], id: crypto.randomUUID(), reconnectDeadline: null }],
  });
  expect(
    await env.GAME_ROOM.getByName(created.room.id).createRoom(replacement, "b".repeat(64)),
  ).not.toBeNull();
  const action = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${moderateReportContract.pathFor(reportId)}`, {
      method: "POST",
      headers: { Authorization: "Bearer test-moderator-token", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_and_mute" }),
    }),
  );
  expect(action.status).toBe(409);
  expect((await getRoom(created.room.id)).instanceId).toBe(replacement.instanceId);
});
