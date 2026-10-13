import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type RoomSocketClientMessage,
  type RoomSettingsApplyCommand,
  type Room,
} from "@tetraboard/protocol";
import { gameIds, gameCatalog } from "@tetraboard/protocol/games";
import { RoomBoundaryFixtures, type BoundarySocket } from "./roomBoundaryFixtures";

for (const game of gameIds) {
  describe(`${game}: 共通ルーム操作`, () => {
    let fixtures: RoomBoundaryFixtures;
    beforeEach(() => {
      fixtures = new RoomBoundaryFixtures();
    });
    afterEach(async () => {
      await fixtures.dispose();
    });

    async function create() {
      const entry = await fixtures.create({
        name: "ホスト",
        game,
        ...(gameCatalog[game].hasModes ? { mode: "singles" as const } : {}),
        quickPlay: false,
      });
      const host = await fixtures.connect(entry);
      return { entry, host };
    }

    async function setup() {
      const { entry, host } = await create();
      const joined = await fixtures.join(entry.room.id, "参加者");
      const player = await fixtures.open(joined.room.id);
      player.send({ type: "room.auth", token: joined.membership.token });
      expect((await player.waitFor("room.authenticated")).membership).toEqual({
        playerId: joined.membership.playerId,
        role: "player",
      });
      const observer = await fixtures.open(entry.room.id);
      return { entry, joined, host, player, observer };
    }

    function settingsCommand(room: Room): RoomSettingsApplyCommand {
      return {
        type: "room.settings.apply",
        expectedPublicUpdatedAtMs: room.publicUpdatedAtMs,
        timeControl: { mainTimeMs: 600_000, byoyomiMs: 10_000 },
        ...(gameCatalog[game].hasModes ? { mode: "doubles" as const } : {}),
        ...(room.settings.game === "four-shogi"
          ? { threePlayerAttackProhibited: !room.settings.threePlayerAttackProhibited }
          : {}),
        ...(room.settings.game === "gomoku"
          ? { forbiddenRules: !room.settings.forbiddenRules }
          : {}),
        cpus: [{ playerId: null, level: 2 }],
      };
    }

    test("設定を一括適用し、モード・時間・CPU・固有設定を一つのスナップショットで確定", async () => {
      const { entry, host } = await create();
      host.send({ type: "room.ready.set", ready: true });
      await host.waitFor("room.snapshot", (message) => message.room.players[0]!.ready);
      const command = settingsCommand(entry.room);
      host.send(command);
      const result = (
        await host.waitFor(
          "room.snapshot",
          (message) => message.room.settings.timeControl.mainTimeMs === 600_000,
        )
      ).room;
      expect(result.settings.timeControl).toEqual(command.timeControl);
      if (command.mode !== undefined) expect(result.settings.mode).toBe(command.mode);
      if (result.settings.game === "four-shogi")
        expect(result.settings.threePlayerAttackProhibited).toBe(
          command.threePlayerAttackProhibited,
        );
      if (result.settings.game === "gomoku")
        expect(result.settings.forbiddenRules).toBe(command.forbiddenRules);
      const cpu = result.players.find((player) => player.kind === "cpu")!;
      expect(cpu).toMatchObject({ level: 2, ready: true });
      expect(result.players[0]!.ready).toBe(false);
      const next = {
        ...command,
        expectedPublicUpdatedAtMs: result.publicUpdatedAtMs,
        cpus: [{ playerId: cpu.id, level: 1 as const }],
      };
      host.send(next);
      const leveled = (
        await host.waitFor("room.snapshot", (message) =>
          message.room.players.some((player) => player.kind === "cpu" && player.level === 1),
        )
      ).room;
      expect(leveled.players.find((player) => player.kind === "cpu")!.id).toBe(cpu.id);
      host.send({ ...next, expectedPublicUpdatedAtMs: leveled.publicUpdatedAtMs, cpus: [] });
      const removed = (
        await host.waitFor("room.snapshot", (message) => message.room.players.length === 1)
      ).room;
      expect(removed.settings).toEqual(leveled.settings);
      host.send({ ...next, expectedPublicUpdatedAtMs: removed.publicUpdatedAtMs, cpus: [] });
      const unchanged = (await host.waitFor("room.snapshot")).room;
      expect(unchanged.publicUpdatedAtMs).toBe(removed.publicUpdatedAtMs);
      host.send({
        ...command,
        expectedPublicUpdatedAtMs: unchanged.publicUpdatedAtMs,
        cpus: Array.from({ length: gameCatalog[game].capacity - 1 }, () => ({
          playerId: null,
          level: 1 as const,
        })),
      });
      await host.waitFor(
        "room.snapshot",
        (message) => message.room.players.length === gameCatalog[game].capacity,
      );
      host.send({ type: "room.ready.set", ready: true });
      await host.waitFor("room.snapshot", (message) =>
        message.room.players.every((player) => player.ready),
      );
      host.send({ type: "room.game.start" });
      const playing = (
        await host.waitFor("room.snapshot", (message) => message.room.status === "playing")
      ).room;
      host.send({ ...command, expectedPublicUpdatedAtMs: playing.publicUpdatedAtMs });
      expect((await host.waitFor("room.error")).error).toBe("already_started");
    });

    test("不正CPU・重複ID・満席・他ゲームの設定・古い編集は全項目を変更しない", async () => {
      const { entry, host } = await create();
      const command = settingsCommand(entry.room);
      const baseline = (await fixtures.snapshot(entry.room.id)).room;
      for (const invalid of [
        { ...command, cpus: [{ playerId: crypto.randomUUID(), level: 1 as const }] },
        {
          ...command,
          cpus: [
            { playerId: entry.membership.playerId, level: 1 as const },
            { playerId: entry.membership.playerId, level: 2 as const },
          ],
        },
        {
          ...command,
          cpus: Array.from({ length: gameCatalog[game].capacity }, () => ({
            playerId: null,
            level: 1 as const,
          })),
        },
        {
          ...command,
          ...(game === "gomoku" ? { threePlayerAttackProhibited: true } : { forbiddenRules: true }),
        },
        { ...command, expectedPublicUpdatedAtMs: 0 },
      ]) {
        host.send(invalid);
        await host.waitFor("room.error");
        expect((await fixtures.snapshot(entry.room.id)).room).toEqual(baseline);
      }
      const guestEntry = await fixtures.join(entry.room.id, "参加者");
      const guest = await fixtures.connect(guestEntry);
      guest.send(settingsCommand(guestEntry.room));
      expect((await guest.waitFor("room.error")).error).toBe("forbidden");
    });

    async function ready(clients: BoundarySocket[], playerId: string, value: boolean) {
      return Promise.all(
        clients.map((client) =>
          client.waitFor(
            "room.snapshot",
            (message) =>
              message.room.players.find((player) => player.id === playerId)?.ready === value,
          ),
        ),
      );
    }

    test("参加は1席と本人資格を追加し、観戦は席を増やさず全接続へ反映する", async () => {
      const { entry, host } = await create();
      const observer = await fixtures.open(entry.room.id);
      const before = await fixtures.snapshot(entry.room.id);
      expect(before.room.players.map((player) => player.id)).toEqual([entry.membership.playerId]);
      expect(before.presence).toEqual({
        hostPlayerId: entry.membership.playerId,
        connectedPlayerIds: [entry.membership.playerId],
      });

      const joined = await fixtures.join(entry.room.id, "参加者");
      expect(joined.membership.role).toBe("player");
      expect(joined.membership.token).not.toBe(entry.membership.token);
      const player = await fixtures.open(joined.room.id);
      player.send({ type: "room.auth", token: joined.membership.token });
      expect((await player.waitFor("room.authenticated")).membership).toEqual({
        playerId: joined.membership.playerId,
        role: "player",
      });
      const snapshots = await Promise.all(
        [host, observer, player].map((client) =>
          client.waitFor(
            "room.snapshot",
            (message) =>
              message.room.players.length === 2 &&
              message.presence.connectedPlayerIds.includes(joined.membership.playerId),
          ),
        ),
      );
      for (const snapshot of snapshots) {
        expect(snapshot.room.settings.game).toBe(game);
        expect(snapshot.room.players.map((seat) => seat.id)).toEqual([
          entry.membership.playerId,
          joined.membership.playerId,
        ]);
        expect(snapshot.room.players[1]).toMatchObject({
          name: "参加者",
          kind: "human",
          ready: false,
        });
        expect(snapshot.presence.hostPlayerId).toBe(entry.membership.playerId);
        expect(snapshot.presence.connectedPlayerIds.slice().sort()).toEqual(
          [entry.membership.playerId, joined.membership.playerId].sort(),
        );
      }
      const current = await fixtures.snapshot(entry.room.id);
      expect(current.room).toEqual(snapshots[0].room);
      expect(current.presence).toEqual(snapshots[0].presence);
    });

    for (const value of [true, false]) {
      test(`準備${value ? "完了" : "取消"}は本人・他参加者・観戦へ配信してGETでも保持する`, async () => {
        const { entry, joined, host, player, observer } = await setup();
        const clients = [host, player, observer];
        if (!value) {
          player.send({ type: "room.ready.set", ready: true });
          await ready(clients, joined.membership.playerId, true);
        }
        player.send({ type: "room.ready.set", ready: value });
        const snapshots = await ready(clients, joined.membership.playerId, value);
        for (const snapshot of snapshots) {
          expect(snapshot.room.status).toBe("waiting");
          expect(
            snapshot.room.players.find((seat) => seat.id === entry.membership.playerId)?.ready,
          ).toBe(false);
          expect(snapshot.room.settings.game).toBe(game);
        }
        expect((await fixtures.snapshot(entry.room.id)).room).toEqual(snapshots[0].room);
      });
    }

    test("観戦者の準備操作は拒否して席・準備・接続情報を変えない", async () => {
      const { entry, observer } = await setup();
      const before = await fixtures.snapshot(entry.room.id);
      observer.send({ type: "room.ready.set", ready: true });
      expect((await observer.waitFor("room.error")).error).toBe("unauthorized");
      const after = await fixtures.snapshot(entry.room.id);
      expect(after.room).toEqual(before.room);
      expect(after.presence).toEqual(before.presence);
    });

    test("切断後の同じ資格で席・準備・チャットを復元し、席と入室ログを重複させない", async () => {
      const { entry, joined, host, player, observer } = await setup();
      player.send({ type: "room.ready.set", ready: true });
      await ready([host, player, observer], joined.membership.playerId, true);
      player.send({ type: "room.chat.send", text: "復帰前の投稿" });
      const history = await observer.waitFor("room.chat.snapshot", (message) =>
        message.messages.some(
          (item) => item.kind === "player" && item.senderId === joined.membership.playerId,
        ),
      );
      const before = await fixtures.snapshot(entry.room.id);
      player.close();
      const disconnected = await observer.waitFor(
        "room.snapshot",
        (message) =>
          !message.presence.connectedPlayerIds.includes(joined.membership.playerId) &&
          message.room.players.find((seat) => seat.id === joined.membership.playerId)
            ?.reconnectDeadline != null,
      );
      expect(
        disconnected.room.players.find((seat) => seat.id === joined.membership.playerId)?.ready,
      ).toBe(true);
      expect(
        disconnected.room.players.find((seat) => seat.id === joined.membership.playerId)
          ?.reconnectDeadline,
      ).toBeGreaterThan(disconnected.serverNowMs);

      const restored = await fixtures.connect(joined);
      const snapshot = await observer.waitFor(
        "room.snapshot",
        (message) =>
          message.presence.connectedPlayerIds.includes(joined.membership.playerId) &&
          message.room.players.find((seat) => seat.id === joined.membership.playerId)
            ?.reconnectDeadline === null,
      );
      expect(snapshot.room.players.map((seat) => seat.id)).toEqual(
        before.room.players.map((seat) => seat.id),
      );
      expect(
        snapshot.room.players.find((seat) => seat.id === joined.membership.playerId)?.ready,
      ).toBe(true);
      expect(snapshot.presence).toEqual(before.presence);
      expect(snapshot.room.settings).toEqual(before.room.settings);
      const replayed = await restored.waitFor("room.chat.snapshot", (message) =>
        message.messages.some(
          (item) => item.kind === "player" && item.senderId === joined.membership.playerId,
        ),
      );
      expect(replayed.messages).toEqual(history.messages);
      expect(
        replayed.messages.filter((item) => item.kind === "system" && item.event === "joined"),
      ).toHaveLength(2);
      expect((await fixtures.snapshot(entry.room.id)).room).toEqual(snapshot.room);
    });

    const unauthorizedOperations: { label: string; message: RoomSocketClientMessage }[] = [
      { label: "認証", message: { type: "room.auth", token: "0".repeat(64) } },
      { label: "準備", message: { type: "room.ready.set", ready: true } },
      { label: "チャット", message: { type: "room.chat.send", text: "無効資格の投稿" } },
    ];
    for (const operation of unauthorizedOperations) {
      test(`無効資格の${operation.label}を拒否して参加資格・席を与えない`, async () => {
        const { entry } = await create();
        const invalid = await fixtures.open(entry.room.id);
        const history = await invalid.waitFor("room.chat.snapshot");
        if (operation.label !== "認証") {
          invalid.send({ type: "room.auth", token: "0".repeat(64) });
          expect((await invalid.waitFor("room.error")).error).toBe("unauthorized");
        }
        const before = await fixtures.snapshot(entry.room.id);
        invalid.send(operation.message);
        expect((await invalid.waitFor("room.error")).error).toBe("unauthorized");
        const after = await fixtures.snapshot(entry.room.id);
        expect(after.room).toEqual(before.room);
        expect(after.presence).toEqual(before.presence);
        const observer = await fixtures.open(entry.room.id);
        expect((await observer.waitFor("room.chat.snapshot")).messages).toEqual(history.messages);
      });
    }

    test("100文字の投稿を本人・他参加者・観戦へ同じIDで配信し再接続でも復元する", async () => {
      const { entry, joined, host, player, observer } = await setup();
      const text = "👨‍👩‍👧‍👦".repeat(100);
      player.send({ type: "room.chat.send", text });
      const histories = await Promise.all(
        [host, player, observer].map((client) =>
          client.waitFor("room.chat.snapshot", (message) =>
            message.messages.some(
              (item) =>
                item.kind === "player" &&
                item.senderId === joined.membership.playerId &&
                item.text === text,
            ),
          ),
        ),
      );
      const post = histories[0].messages.find(
        (item) =>
          item.kind === "player" &&
          item.senderId === joined.membership.playerId &&
          item.text === text,
      );
      expect(post).toMatchObject({
        kind: "player",
        senderId: joined.membership.playerId,
        senderName: "参加者",
        text,
      });
      for (const history of histories) {
        expect(history.messages.filter((item) => item.id === post?.id)).toEqual([post]);
      }
      player.close();
      await observer.waitFor(
        "room.snapshot",
        (message) => !message.presence.connectedPlayerIds.includes(joined.membership.playerId),
      );
      const restored = await fixtures.connect(joined);
      const history = await restored.waitFor("room.chat.snapshot", (message) =>
        message.messages.some((item) => item.id === post?.id),
      );
      expect(history.messages).toEqual(histories[0].messages);
      expect((await fixtures.snapshot(entry.room.id)).room.players).toHaveLength(2);
    });

    for (const invalid of [
      { label: "101文字", text: "👨‍👩‍👧‍👦".repeat(101), spectator: false },
      { label: "URL", text: "https://example.com", spectator: false },
      { label: "観戦者", text: "観戦者の投稿", spectator: true },
    ]) {
      test(`${invalid.label}の投稿を拒否して履歴へ追加しない`, async () => {
        const { entry, player, observer } = await setup();
        const before = await observer.waitFor(
          "room.chat.snapshot",
          (message) => message.messages.length === 2,
        );
        const sender = invalid.spectator ? observer : player;
        sender.send({ type: "room.chat.send", text: invalid.text });
        if (invalid.spectator)
          expect((await sender.waitFor("room.error")).error).toBe("unauthorized");
        else expect((await sender.waitFor("room.chat.error")).error).toBe("invalid_request");
        const reloaded = await fixtures.open(entry.room.id);
        expect((await reloaded.waitFor("room.chat.snapshot")).messages).toEqual(before.messages);
      });
    }
  });
}
