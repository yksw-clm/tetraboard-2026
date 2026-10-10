import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { roomStampIds, type Room, type RoomSocketClientMessage } from "@tetraboard/protocol";
import { RoomBoundaryFixtures, boundaryRequest } from "./roomBoundaryFixtures";

for (const game of gameIds)
  describe(`${game}: スタンプ`, () => {
    let fixtures: RoomBoundaryFixtures;
    beforeEach(() => {
      fixtures = new RoomBoundaryFixtures();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await fixtures.dispose();
    });
    async function setup(quickPlay = false) {
      const entry = await fixtures.create({
        name: "ホスト",
        game,
        quickPlay,
        ...(gameCatalog[game].hasModes ? { mode: "singles" } : {}),
      });
      const query = `?instanceId=${entry.room.instanceId}&stamps=1${game === "four-shogi" ? "&formationAnalysis=1" : ""}`;
      const host = await fixtures.connect(entry, query);
      const viewer = await fixtures.open(entry.room.id, query);
      const old = await fixtures.open(entry.room.id);
      const stub = env.GAME_ROOM.getByName(entry.room.id);
      const command = (stampId: (typeof roomStampIds)[number] = "cry") => ({
        type: "room.stamp.send" as const,
        instanceId: entry.room.instanceId,
        requestId: crypto.randomUUID(),
        stampId,
      });
      async function expireInterval() {
        await runInDurableObject(stub, (_instance, state) =>
          state.storage.kv.delete(`last-chat-at:${entry.membership.playerId}`),
        );
      }
      return { entry, query, host, viewer, old, stub, command, expireInterval };
    }
    test("6種類を本人・相手・観戦者へライブ配信し、旧接続と履歴・再接続には追加しない", async () => {
      const { entry, query, host, viewer, old, stub, command, expireInterval } = await setup();
      const joined = await fixtures.join(entry.room.id, "相手");
      const opponent = await fixtures.connect(joined, query);
      const before = await runInDurableObject(stub, (_instance, state) =>
        state.storage.kv.get("chat"),
      );
      for (const id of roomStampIds) {
        await expireInterval();
        const sent = command(id);
        host.send(sent);
        const messages = await Promise.all(
          [host, viewer, opponent].map((client) =>
            client.waitFor(
              "room.stamp.received",
              (message) => message.requestId === sent.requestId,
            ),
          ),
        );
        expect(messages[0]).toMatchObject({
          instanceId: entry.room.instanceId,
          stampId: id,
          senderId: entry.membership.playerId,
        });
        expect(messages[1]).toEqual(messages[0]);
        expect(messages[2]).toEqual(messages[0]);
        expect(old.hasMessage("room.stamp.received")).toBe(false);
      }
      const saved = await runInDurableObject(stub, (_instance, state) => ({
        chat: state.storage.kv.get("chat"),
        keys: new Map(state.storage.kv.list({ prefix: "stamp" })).size,
      }));
      expect(saved.chat).toEqual(before);
      expect(saved.keys).toBe(0);
      const restored = await fixtures.open(entry.room.id, query);
      await restored.waitFor("room.chat.snapshot");
      expect(restored.hasMessage("room.stamp.received")).toBe(false);
      expect((await boundaryRequest(`/rooms/${entry.room.id}?stamps=1`)).status).toBe(200);
      const supported = await (await boundaryRequest(`/rooms/${entry.room.id}?stamps=1`)).json();
      expect(supported).toHaveProperty("stampsSupported", true);
      expect(await (await boundaryRequest(`/rooms/${entry.room.id}`)).json()).not.toHaveProperty(
        "stampsSupported",
      );
      host.send({ type: "room.auth", token: entry.membership.token });
      const auth = await host.waitFor("room.authenticated");
      expect(auth.interactionAvailableAtMs).toBeGreaterThan(0);
      old.send({ type: "room.auth", token: entry.membership.token });
      expect(await old.waitFor("room.authenticated")).not.toHaveProperty(
        "interactionAvailableAtMs",
      );
    });
    test("チャットと合算し、2,999msで拒否・3,000msで受理し、複数タブとDO休止復帰でも制限する", async () => {
      const { entry, query, host, stub, command, viewer } = await setup();
      const clock = vi.spyOn(Date, "now");
      const at = Date.now();
      clock.mockReturnValue(at);
      host.send({ type: "room.chat.send", text: "こんにちは" });
      await host.waitFor("room.chat.snapshot", (message) =>
        message.messages.some((item) => item.text === "こんにちは"),
      );
      const otherTab = await fixtures.connect(entry, query);
      clock.mockReturnValue(at + 2999);
      const first = command();
      otherTab.send(first);
      expect(await otherTab.waitFor("room.stamp.error")).toMatchObject({
        requestId: first.requestId,
        error: "rate_limited",
        interactionAvailableAtMs: at + 3000,
      });
      clock.mockReturnValue(at + 3000);
      const accepted = command();
      host.send(accepted);
      expect((await host.waitFor("room.stamp.received")).sentAtMs).toBe(at + 3000);
      await viewer.waitFor("room.stamp.received");
      host.send({ type: "room.chat.send", text: "まだ送れない" });
      expect((await host.waitFor("room.chat.error")).error).toBe("rate_limited");
      await evictDurableObject(stub, { webSockets: "hibernate" });
      clock.mockReturnValue(at + 5999);
      const afterWake = command();
      host.send(afterWake);
      expect((await host.waitFor("room.stamp.error")).error).toBe("rate_limited");
      clock.mockReturnValue(at + 6000);
      const next = command("hello");
      host.send(next);
      expect(
        (
          await host.waitFor(
            "room.stamp.received",
            (message) => message.requestId === next.requestId,
          )
        ).stampId,
      ).toBe("hello");
    });
    test("活動期限とAlarmを延長し、期限切れの閉鎖を送信より先に処理する", async () => {
      const { entry, host, stub, command } = await setup();
      const at = Date.now();
      const idleMs = 24 * 60 * 60 * 1000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(at + 3000);
      await runInDurableObject(stub, (_instance, state) => {
        const room = state.storage.kv.get<Room>("room")!;
        state.storage.kv.put("room", { ...room, lastActivityAtMs: at - idleMs + 60_000 });
      });
      const sent = command();
      host.send(sent);
      await host.waitFor("room.stamp.received", (message) => message.requestId === sent.requestId);
      const saved = await runInDurableObject(stub, async (_instance, state) => ({
        room: state.storage.kv.get<Room>("room"),
        alarm: await state.storage.getAlarm(),
      }));
      expect(saved.room?.lastActivityAtMs).toBe(at + 3000);
      expect(saved.alarm).toBe(at + 3000 + idleMs);
      clock.mockReturnValue(at + 3000 + idleMs);
      host.send(command());
      expect((await host.waitFor("room.error")).error).toBe("not_found");
      expect((await boundaryRequest(`/rooms/${entry.room.id}`)).status).toBe(404);
      fixtures.forgetClosedRoom(entry.room.id);
    });
    test("未認証・無効種類・別世代・送信停止を拒否し、失敗で活動や履歴を更新しない", async () => {
      const { entry, host, viewer, stub, command } = await setup();
      const before = await fixtures.snapshot(entry.room.id);
      const unauthorized = command();
      viewer.send(unauthorized);
      expect(await viewer.waitFor("room.stamp.error")).toMatchObject({
        requestId: unauthorized.requestId,
        error: "unauthorized",
      });
      for (const stampId of ["unknown", "encourage"]) {
        const invalid = { ...command(), stampId };
        host.send(invalid as RoomSocketClientMessage);
        expect(await host.waitFor("room.stamp.error")).toMatchObject({
          requestId: invalid.requestId,
          error: "invalid_request",
        });
      }
      const stale = { ...command(), instanceId: crypto.randomUUID() };
      host.send(stale);
      expect((await host.waitFor("room.stamp.error")).error).toBe("room_changed");
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.kv.put("chat-muted", [entry.membership.playerId]),
      );
      host.send(command());
      expect((await host.waitFor("room.stamp.error")).error).toBe("muted");
      expect((await fixtures.snapshot(entry.room.id)).room.lastActivityAtMs).toBe(
        before.room.lastActivityAtMs,
      );
      expect(viewer.hasMessage("room.stamp.received")).toBe(false);
    });
    test("対局中も時計・盤面・CPU予定を変えず、脱落して在室する人と再戦待機でも送信できる", async () => {
      const { entry, host, viewer, stub, command, expireInterval } = await setup(true);
      host.send({ type: "room.game.start" });
      const started = await host.waitFor(
        "room.snapshot",
        (message) => message.room.status === "playing",
      );
      const before = await runInDurableObject(stub, (_instance, state) => ({
        room: state.storage.kv.get<Room>("room"),
        cpu: state.storage.kv.get("shogi-cpu-job"),
        standardCpu: state.storage.kv.get("standard-shogi-cpu-job"),
      }));
      host.send(command());
      await host.waitFor("room.stamp.received");
      const after = await runInDurableObject(stub, (_instance, state) => ({
        room: state.storage.kv.get<Room>("room"),
        cpu: state.storage.kv.get("shogi-cpu-job"),
        standardCpu: state.storage.kv.get("standard-shogi-cpu-job"),
      }));
      expect(after.room?.clock).toEqual(before.room?.clock);
      expect(after.room?.game).toEqual(before.room?.game);
      expect(after.cpu).toEqual(before.cpu);
      expect(after.standardCpu).toEqual(before.standardCpu);
      const self = started.room.players.find((player) => player.id === entry.membership.playerId)!;
      const selfTurn = "side" in self ? self.side : self.color;
      // 手番を本人へ設定し、実際の投了経路を通して在室状態を確認します。
      await runInDurableObject(stub, (_instance, state) => {
        const room = state.storage.kv.get<Room>("room")!;
        if (room.status === "playing")
          state.storage.kv.put("room", { ...room, game: { ...room.game, turn: selfTurn } });
      });
      host.send({ type: "room.game.resign" });
      await host.waitFor(
        "room.snapshot",
        (message) =>
          message.room.status === "waiting" ||
          (message.room.status === "playing" &&
            ("eliminatedColors" in message.room.game
              ? message.room.game.eliminatedColors.includes(selfTurn as never)
              : message.room.game.eliminations.some((item) => item.side === selfTurn))),
      );
      await expireInterval();
      host.send(command("cry"));
      await host.waitFor("room.stamp.received");
      await viewer.waitFor("room.stamp.received");
      expect(
        (await fixtures.snapshot(entry.room.id)).room.players.some(
          (player) => player.id === entry.membership.playerId,
        ),
      ).toBe(true);
      for (let index = 0; index < gameCatalog[game].capacity; index++) {
        const latest = await fixtures.snapshot(entry.room.id);
        if (latest.room.status === "waiting") break;
        await runInDurableObject(stub, (_instance, state) => {
          const room = state.storage.kv.get<Room>("room")!;
          if (room.status === "playing")
            state.storage.kv.put("room", {
              ...room,
              clock: { ...room.clock, turnExpiresAt: Date.now() - 1 },
            });
        });
      }
      expect((await fixtures.snapshot(entry.room.id)).room.status).toBe("waiting");
      await expireInterval();
      host.send(command("applause"));
      await host.waitFor("room.stamp.received", (message) => message.stampId === "applause");
    });
    test("明示退室済みの保持カードからは送信できず、CPU資格を偽造しても受理しない", async () => {
      const { entry, host, stub, command } = await setup(true);
      const tokenHash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(entry.membership.token)),
        ),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      const fakeHash = "c".repeat(64);
      const cpu = entry.room.players.find((p) => p.kind === "cpu")!;
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.kv.put(`membership:${fakeHash}`, { playerId: cpu.id, role: "player" });
        for (const socket of state.getWebSockets()) {
          const attachment = socket.deserializeAttachment() as { tokenHash?: string } | null;
          if (attachment?.tokenHash === tokenHash)
            socket.serializeAttachment({ tokenHash: fakeHash });
        }
      });
      host.send(command());
      expect((await host.waitFor("room.stamp.error")).error).toBe("unauthorized");
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.kv.delete(`membership:${fakeHash}`);
        for (const socket of state.getWebSockets()) {
          const attachment = socket.deserializeAttachment() as { tokenHash?: string } | null;
          if (attachment?.tokenHash === fakeHash) socket.serializeAttachment({ tokenHash });
        }
      });
      host.send({ type: "room.cpu.remove", playerId: cpu.id });
      await host.waitFor("room.snapshot", (message) =>
        message.room.players.every((p) => p.id !== cpu.id),
      );
      const joined = await fixtures.join(entry.room.id, "在室者");
      await fixtures.connect(joined);
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.kv.put(`departed:${entry.membership.playerId}`, true),
      );
      host.send(command());
      expect((await host.waitFor("room.stamp.error")).error).toBe("unauthorized");
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.kv.delete(`departed:${entry.membership.playerId}`),
      );
    });
  });
