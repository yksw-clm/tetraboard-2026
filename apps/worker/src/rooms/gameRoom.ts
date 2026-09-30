import {
  joinRoomContract,
  membershipTokenSchema,
  roomMembershipSchema,
  roomSchema,
  roomSocketContract,
  type Room,
  type RoomMembership,
  type RoomSocketClientMessage,
  type RoomSocketMessage,
} from "@tetraboard/protocol";
import {
  applyAction,
  chooseCpuMove,
  colors,
  createInitialState,
  eliminateColor,
  type FourReversiAction,
} from "@tetraboard/four-reversi";
import { DurableObject } from "cloudflare:workers";
import { advanceClock, createClock, isClockExpired } from "./clock";

const roomStorageKey = "room";
const membershipStorageKey = (tokenHash: string) => `membership:${tokenHash}`;
const playerTokenKey = (playerId: string) => `player-token:${playerId}`;
const reconnectGraceMs = 30_000;
const cpuMoveDelayMs = 500;
type RoomSocketError = Extract<RoomSocketMessage, { type: "room.error" }>["error"];
type CpuCommand = Extract<
  RoomSocketClientMessage,
  { type: "room.cpu.add" | "room.cpu.remove" | "room.cpu.level.set" }
>;

function currentCpu(room: Room): Extract<Room["players"][number], { kind: "cpu" }> | null {
  if (room.status !== "playing") return null;
  const player = room.players.find((entry) => entry.color === room.game.turn);
  return player?.kind === "cpu" ? player : null;
}

async function hashMembershipToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function randomIndex(length: number): number {
  const range = 2 ** 32;
  const limit = Math.floor(range / length) * length;
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= limit);
  return value[0] % length;
}

function shuffledColors(): (typeof colors)[number][] {
  const result: (typeof colors)[number][] = [...colors];
  for (let index = result.length - 1; index > 0; index--) {
    const other = randomIndex(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export class GameRoom extends DurableObject<Env> {
  private readRoom(): Room | null {
    const room = this.ctx.storage.kv.get(roomStorageKey);
    return room === undefined ? null : roomSchema.parse(room);
  }

  private readMembership(tokenHash: string): RoomMembership | null {
    const value = this.ctx.storage.kv.get(membershipStorageKey(tokenHash));
    return value === undefined ? null : roomMembershipSchema.parse(value);
  }

  private playerTokenHash(playerId: string): string | null {
    return this.ctx.storage.kv.get<string>(playerTokenKey(playerId)) ?? null;
  }

  private hasOpenConnection(tokenHash: string, excluded?: WebSocket): boolean {
    return this.ctx.getWebSockets().some((socket) => {
      if (socket === excluded || socket.readyState !== WebSocket.OPEN) return false;
      const attachment: unknown = socket.deserializeAttachment();
      return (
        typeof attachment === "object" &&
        attachment !== null &&
        "tokenHash" in attachment &&
        attachment.tokenHash === tokenHash
      );
    });
  }

  private async syncAlarm(room: Room | null): Promise<void> {
    const deadlines =
      room?.status === "finished"
        ? []
        : (room?.players
            .filter((player) => player.kind === "human")
            .map((player) => player.reconnectDeadline)
            .filter((value) => value !== null) ?? []);
    if (room?.status === "playing") {
      deadlines.push(room.clock.turnExpiresAt);
      if (currentCpu(room) !== null) deadlines.push(room.clock.turnStartedAt + cpuMoveDelayMs);
    }
    const next = deadlines.length === 0 ? null : Math.min(...deadlines);
    const current = await this.ctx.storage.getAlarm();
    if (next === current) return;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  async createRoom(room: Room, tokenHash: string): Promise<Room | null> {
    await this.reconcileDeadlines();
    const initialRoom = roomSchema.parse(room);

    if (initialRoom.id !== this.ctx.id.name) {
      throw new Error("Room code does not match Durable Object name");
    }

    const created = this.ctx.storage.transactionSync(() => {
      if (
        this.ctx.storage.kv.get(roomStorageKey) !== undefined ||
        this.ctx.storage.kv.get(membershipStorageKey(tokenHash)) !== undefined
      ) {
        return null;
      }

      const pendingRoom = roomSchema.parse({
        ...initialRoom,
        players: initialRoom.players.map((player) =>
          player.kind === "human"
            ? { ...player, reconnectDeadline: Date.now() + reconnectGraceMs }
            : player,
        ),
      });
      this.ctx.storage.kv.put(roomStorageKey, pendingRoom);
      this.ctx.storage.kv.put(
        membershipStorageKey(tokenHash),
        roomMembershipSchema.parse({ playerId: initialRoom.players[0].id, role: "host" }),
      );
      this.ctx.storage.kv.put(playerTokenKey(initialRoom.players[0].id), tokenHash);
      return pendingRoom;
    });
    if (created !== null) await this.syncAlarm(created);
    return created;
  }

  async getRoom(): Promise<Room | null> {
    await this.reconcileDeadlines();
    return this.readRoom();
  }

  async getRoomMembership(
    tokenHash: string,
  ): Promise<
    | { status: "found"; membership: RoomMembership }
    | { status: "not_found" }
    | { status: "unauthorized" }
  > {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (room === null) {
      return { status: "not_found" };
    }

    const membership = this.readMembership(tokenHash);
    if (membership === null) {
      return { status: "unauthorized" };
    }

    return room.players.some(
      (player) => player.kind === "human" && player.id === membership.playerId,
    )
      ? { status: "found", membership }
      : { status: "unauthorized" };
  }

  async joinRoom(
    name: string,
    tokenHash: string,
  ): Promise<
    | { status: "joined"; room: Room; membership: RoomMembership }
    | { status: "not_found" }
    | { status: "room_full" }
    | { status: "room_started" }
  > {
    await this.reconcileDeadlines();
    const playerName = joinRoomContract.request.parse({ name }).name;
    const result = this.ctx.storage.transactionSync(() => {
      const room = this.readRoom();
      if (room === null) {
        return { status: "not_found" } as const;
      }
      if (room.status !== "waiting") {
        return { status: "room_started" } as const;
      }
      if (room.players.length >= 4) {
        return { status: "room_full" } as const;
      }
      if (this.ctx.storage.kv.get(membershipStorageKey(tokenHash)) !== undefined) {
        throw new Error("Membership token collision");
      }

      const playerId = crypto.randomUUID();
      const updatedRoom = roomSchema.parse({
        ...room,
        players: [
          ...room.players,
          {
            id: playerId,
            name: playerName,
            kind: "human",
            ready: false,
            color: null,
            reconnectDeadline: Date.now() + reconnectGraceMs,
          },
        ],
      });
      const membership = roomMembershipSchema.parse({ playerId, role: "player" });
      this.ctx.storage.kv.put(roomStorageKey, updatedRoom);
      this.ctx.storage.kv.put(membershipStorageKey(tokenHash), membership);
      this.ctx.storage.kv.put(playerTokenKey(playerId), tokenHash);
      return { status: "joined", room: updatedRoom, membership } as const;
    });

    if (result.status === "joined") {
      await this.syncAlarm(result.room);
      this.broadcastRoom(result.room);
    }

    return result;
  }

  private removeWaitingPlayer(
    room: Extract<Room, { status: "waiting" }>,
    playerId: string,
  ): Room | null {
    const tokenHash = this.playerTokenHash(playerId);
    if (tokenHash !== null) this.ctx.storage.kv.delete(membershipStorageKey(tokenHash));
    this.ctx.storage.kv.delete(playerTokenKey(playerId));

    let remaining = room.players.filter((player) => player.id !== playerId);
    const successor = remaining.find((player) => player.kind === "human");
    if (successor === undefined) {
      this.ctx.storage.kv.delete(roomStorageKey);
      return null;
    }

    if (room.players[0].id === playerId) {
      remaining = [successor, ...remaining.filter((player) => player.id !== successor.id)];
      const nextHash = this.playerTokenHash(successor.id);
      if (nextHash === null) throw new Error("Host successor has no membership");
      this.ctx.storage.kv.put(
        membershipStorageKey(nextHash),
        roomMembershipSchema.parse({ playerId: remaining[0].id, role: "host" }),
      );
    }
    const updated = roomSchema.parse({ ...room, players: remaining });
    this.ctx.storage.kv.put(roomStorageKey, updated);
    return updated;
  }

  private sendCurrentMembership(tokenHash: string): void {
    const membership = this.readMembership(tokenHash);
    if (membership === null) return;
    const message = JSON.stringify(
      roomSocketContract.message.parse({ type: "room.authenticated", membership }),
    );
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment: unknown = socket.deserializeAttachment();
      if (
        typeof attachment === "object" &&
        attachment !== null &&
        "tokenHash" in attachment &&
        attachment.tokenHash === tokenHash
      ) {
        socket.send(message);
      }
    }
  }

  private closeSockets(tokenHash?: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (tokenHash !== undefined) {
        const attachment: unknown = socket.deserializeAttachment();
        if (
          typeof attachment !== "object" ||
          attachment === null ||
          !("tokenHash" in attachment) ||
          attachment.tokenHash !== tokenHash
        )
          continue;
      }
      try {
        socket.close(1000, "Room membership ended");
      } catch {
        // 切断済みの接続は、そのまま無視します。
      }
    }
  }

  private async reconcileDeadlines(): Promise<void> {
    const now = Date.now();
    const promoted: string[] = [];
    let changed = false;
    let closed = false;
    const room = this.ctx.storage.transactionSync(() => {
      let current = this.readRoom();
      if (current === null || current.status === "finished") return current;
      const activeRoom = current;
      const disconnected = current.players.map((player) => {
        const tokenHash = this.playerTokenHash(player.id);
        const active =
          activeRoom.status === "waiting" ||
          (player.color !== null && !activeRoom.game.eliminatedColors.includes(player.color));
        if (
          !active ||
          player.reconnectDeadline !== null ||
          tokenHash === null ||
          this.hasOpenConnection(tokenHash)
        )
          return player;
        changed = true;
        return { ...player, reconnectDeadline: now + reconnectGraceMs };
      });
      if (changed) {
        current = roomSchema.parse({ ...current, players: disconnected });
        this.ctx.storage.kv.put(roomStorageKey, current);
      }
      while (current !== null && current.status !== "finished") {
        const nextDisconnect = current.players
          .map((player, index) => ({ player, index }))
          .filter(
            ({ player }) => player.reconnectDeadline !== null && player.reconnectDeadline <= now,
          )
          .sort(
            (left, right) =>
              left.player.reconnectDeadline! - right.player.reconnectDeadline! ||
              left.index - right.index,
          )[0];
        const clockDeadline =
          current.status === "playing" && isClockExpired(current.clock, now)
            ? current.clock.turnExpiresAt
            : null;
        if (clockDeadline === null && nextDisconnect === undefined) break;

        if (
          current.status === "playing" &&
          clockDeadline !== null &&
          (nextDisconnect === undefined ||
            clockDeadline <= nextDisconnect.player.reconnectDeadline!)
        ) {
          const result = eliminateColor(current.game, current.game.turn);
          if (!result.ok) throw new Error("Could not eliminate timed-out player");
          const timedOutColor = current.game.turn;
          current = roomSchema.parse({
            ...current,
            status: result.state.status,
            game: result.state,
            clock: advanceClock(
              current.clock,
              timedOutColor,
              result.state.turn,
              clockDeadline,
              true,
            ),
            players: current.players.map((entry) => ({
              ...entry,
              reconnectDeadline:
                result.state.status === "finished" || entry.color === timedOutColor
                  ? null
                  : entry.reconnectDeadline,
            })),
          });
        } else if (nextDisconnect !== undefined) {
          const player = nextDisconnect.player;
          if (current.status === "waiting") {
            const hostLeaving = current.players[0].id === player.id;
            current = this.removeWaitingPlayer(current, player.id);
            if (hostLeaving && current !== null) {
              const successor = this.playerTokenHash(current.players[0].id);
              if (successor !== null) promoted.push(successor);
            }
            if (current === null) closed = true;
          } else {
            if (player.color === null) throw new Error("Playing player has no color");
            const result = eliminateColor(current.game, player.color);
            if (!result.ok) throw new Error("Could not eliminate disconnected player");
            current = roomSchema.parse({
              ...current,
              status: result.state.status,
              game: result.state,
              clock: advanceClock(
                current.clock,
                current.game.turn,
                result.state.turn,
                player.reconnectDeadline!,
                result.state.turn !== current.game.turn,
              ),
              players: current.players.map((entry) => ({
                ...entry,
                reconnectDeadline:
                  result.state.status === "finished" || entry.id === player.id
                    ? null
                    : entry.reconnectDeadline,
              })),
            });
          }
        }
        changed = true;
        if (current !== null) this.ctx.storage.kv.put(roomStorageKey, current);
      }
      if (
        current?.status === "playing" &&
        current.clock.turnStartedAt + cpuMoveDelayMs <= now &&
        !isClockExpired(current.clock, now)
      ) {
        const cpu = currentCpu(current);
        if (cpu !== null) {
          const move = chooseCpuMove(current.game, cpu.level);
          if (move === null) throw new Error("CPU has no legal move");
          const decidedAt = Date.now();
          const expired = isClockExpired(current.clock, decidedAt);
          const result = expired
            ? eliminateColor(current.game, current.game.turn)
            : applyAction(current.game, { type: "placeStone", position: move });
          if (!result.ok) throw new Error("CPU selected an invalid move");
          current = roomSchema.parse({
            ...current,
            status: result.state.status,
            game: result.state,
            clock: advanceClock(
              current.clock,
              current.game.turn,
              result.state.turn,
              expired ? current.clock.turnExpiresAt : decidedAt,
              true,
            ),
            players:
              result.state.status === "finished"
                ? current.players.map((player) =>
                    player.kind === "human" ? { ...player, reconnectDeadline: null } : player,
                  )
                : current.players,
          });
          this.ctx.storage.kv.put(roomStorageKey, current);
          changed = true;
        }
      }
      return current;
    });

    await this.syncAlarm(room);
    if (!changed) return;
    if (closed) this.closeSockets();
    else if (room !== null) this.broadcastRoom(room);
    for (const tokenHash of promoted) this.sendCurrentMembership(tokenHash);
  }

  async alarm(): Promise<void> {
    await this.reconcileDeadlines();
  }

  async leaveRoom(tokenHash: string): Promise<"left" | "not_found" | "unauthorized"> {
    await this.reconcileDeadlines();
    let promoted: string | null = null;
    const result = this.ctx.storage.transactionSync(() => {
      const room = this.readRoom();
      if (room === null) return { status: "not_found" as const, room: null };
      if (room.status === "playing" && isClockExpired(room.clock, Date.now())) {
        return { status: "time_expired" as const, room };
      }
      const membership = this.readMembership(tokenHash);
      if (membership === null) return { status: "unauthorized" as const, room };
      const player = room.players.find((entry) => entry.id === membership.playerId);
      if (player === undefined) return { status: "unauthorized" as const, room };

      let updated: Room | null;
      if (room.status === "waiting") {
        const hostLeaving = room.players[0].id === player.id;
        updated = this.removeWaitingPlayer(room, player.id);
        if (hostLeaving && updated !== null) promoted = this.playerTokenHash(updated.players[0].id);
      } else {
        const game =
          room.status === "playing" &&
          player.color !== null &&
          !room.game.eliminatedColors.includes(player.color)
            ? eliminateColor(room.game, player.color)
            : null;
        if (game !== null && !game.ok) throw new Error("Could not eliminate leaving player");
        updated = roomSchema.parse({
          ...room,
          status: game?.ok ? game.state.status : room.status,
          game: game?.ok ? game.state : room.game,
          clock:
            game?.ok && room.status === "playing"
              ? advanceClock(
                  room.clock,
                  room.game.turn,
                  game.state.turn,
                  Date.now(),
                  game.state.turn !== room.game.turn,
                )
              : room.clock,
          players: room.players.map((entry) => ({
            ...entry,
            reconnectDeadline:
              game?.ok && game.state.status === "finished"
                ? null
                : entry.id === player.id
                  ? null
                  : entry.reconnectDeadline,
          })),
        });
        this.ctx.storage.kv.put(roomStorageKey, updated);
        this.ctx.storage.kv.delete(membershipStorageKey(tokenHash));
        this.ctx.storage.kv.delete(playerTokenKey(player.id));
      }
      return { status: "left" as const, room: updated };
    });
    if (result.status === "time_expired") {
      await this.reconcileDeadlines();
      return this.leaveRoom(tokenHash);
    }
    if (result.status !== "left") return result.status;
    await this.syncAlarm(result.room);
    if (result.room === null) this.closeSockets();
    else this.broadcastRoom(result.room);
    if (promoted !== null) this.sendCurrentMembership(promoted);
    this.closeSockets(tokenHash);
    return "left";
  }

  private broadcastRoom(room: Room): void {
    const message = JSON.stringify(this.roomSnapshot(room));
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(message);
      } catch {
        // 切断中の接続への送信失敗は、保存済みのルーム状態に影響させません。
      }
    }
  }

  private roomSnapshot(room: Room): RoomSocketMessage {
    return roomSocketContract.message.parse({
      type: "room.snapshot",
      room,
      serverNowMs: Date.now(),
    });
  }

  private sendSocketError(socket: WebSocket, error: RoomSocketError): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(roomSocketContract.message.parse({ type: "room.error", error })));
    }
  }

  private setReady(
    tokenHash: string,
    ready: boolean,
  ):
    | { status: "updated"; room: Room }
    | { status: "unchanged" }
    | { status: "not_found" }
    | { status: "unauthorized" }
    | { status: "already_started" } {
    return this.ctx.storage.transactionSync(() => {
      const room = this.readRoom();
      if (room === null) return { status: "not_found" };
      if (room.status !== "waiting") return { status: "already_started" };

      const membership = this.readMembership(tokenHash);
      if (membership === null) return { status: "unauthorized" };
      const player = room.players.find((entry) => entry.id === membership.playerId);
      if (player === undefined) return { status: "unauthorized" };
      if (player.ready === ready) return { status: "unchanged" };

      const updatedRoom = roomSchema.parse({
        ...room,
        players: room.players.map((entry) =>
          entry.id === player.id ? { ...entry, ready } : entry,
        ),
      });
      this.ctx.storage.kv.put(roomStorageKey, updatedRoom);
      return { status: "updated", room: updatedRoom };
    });
  }

  private updateCpu(
    tokenHash: string,
    command: CpuCommand,
  ):
    | { status: "updated"; room: Room }
    | { status: "unchanged" }
    | { status: "not_found" | "forbidden" | "already_started" | "room_full" | "cpu_not_found" } {
    return this.ctx.storage.transactionSync(() => {
      const room = this.readRoom();
      if (room === null) return { status: "not_found" };
      if (room.status !== "waiting") return { status: "already_started" };
      if (this.readMembership(tokenHash)?.role !== "host") return { status: "forbidden" };

      if (command.type === "room.cpu.add") {
        if (room.players.length >= 4) return { status: "room_full" };
        const used = new Set(
          room.players.filter((player) => player.kind === "cpu").map((player) => player.name),
        );
        const number = [1, 2, 3].find((value) => !used.has(`CPU ${value}`));
        if (number === undefined) return { status: "room_full" };
        const updated = roomSchema.parse({
          ...room,
          players: [
            ...room.players,
            {
              id: crypto.randomUUID(),
              name: `CPU ${number}`,
              kind: "cpu",
              level: command.level,
              ready: true,
              color: null,
              reconnectDeadline: null,
            },
          ],
        });
        this.ctx.storage.kv.put(roomStorageKey, updated);
        return { status: "updated", room: updated };
      }

      const cpu = room.players.find((player) => player.id === command.playerId);
      if (cpu?.kind !== "cpu") return { status: "cpu_not_found" };
      if (command.type === "room.cpu.remove") {
        const updated = roomSchema.parse({
          ...room,
          players: room.players.filter((player) => player.id !== cpu.id),
        });
        this.ctx.storage.kv.put(roomStorageKey, updated);
        return { status: "updated", room: updated };
      }
      if (cpu.level === command.level) return { status: "unchanged" };
      const updated = roomSchema.parse({
        ...room,
        players: room.players.map((player) =>
          player.id === cpu.id ? { ...cpu, level: command.level } : player,
        ),
      });
      this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "updated", room: updated };
    });
  }

  private startGame(
    tokenHash: string,
  ):
    | { status: "started"; room: Room }
    | { status: "not_found" | "unauthorized" | "forbidden" | "not_ready" | "already_started" } {
    return this.ctx.storage.transactionSync(() => {
      const room = this.readRoom();
      if (room === null) return { status: "not_found" };
      if (room.status !== "waiting") return { status: "already_started" };

      const membership = this.readMembership(tokenHash);
      if (membership === null) return { status: "unauthorized" };
      if (membership.role !== "host") return { status: "forbidden" };
      if (
        room.players.length !== 4 ||
        room.players.some((player) => {
          if (player.kind === "cpu") return false;
          const hash = this.playerTokenHash(player.id);
          return !player.ready || hash === null || !this.hasOpenConnection(hash);
        })
      ) {
        return { status: "not_ready" };
      }

      const assignments = shuffledColors();
      const startedRoom = roomSchema.parse({
        ...room,
        status: "playing",
        players: room.players.map((player, index) => ({
          ...player,
          ready: player.kind === "cpu" ? true : false,
          color: assignments[index],
        })),
        game: createInitialState("singles"),
        clock: createClock(Date.now()),
      });
      this.ctx.storage.kv.put(roomStorageKey, startedRoom);
      return { status: "started", room: startedRoom };
    });
  }

  private placeStone(
    tokenHash: string,
    action: FourReversiAction,
  ):
    | { status: "placed"; room: Room }
    | {
        status:
          | "not_found"
          | "unauthorized"
          | "game_not_started"
          | "game_finished"
          | "not_your_turn"
          | "invalid_move"
          | "already_eliminated"
          | "time_expired";
      } {
    return this.ctx.storage.transactionSync(() => {
      const room = this.readRoom();
      if (room === null) return { status: "not_found" };
      if (room.status === "waiting") return { status: "game_not_started" };
      if (room.status === "finished") return { status: "game_finished" };
      if (isClockExpired(room.clock, Date.now())) return { status: "time_expired" };

      const membership = this.readMembership(tokenHash);
      if (membership === null) return { status: "unauthorized" };
      const player = room.players.find((entry) => entry.id === membership.playerId);
      if (player !== undefined && room.game.eliminatedColors.includes(player.color)) {
        return { status: "already_eliminated" };
      }
      if (player?.color !== room.game.turn) return { status: "not_your_turn" };
      const result = applyAction(room.game, action);
      if (!result.ok) return { status: "invalid_move" };
      const updatedRoom = roomSchema.parse({
        ...room,
        status: result.state.status,
        clock: advanceClock(room.clock, room.game.turn, result.state.turn, Date.now(), true),
        players:
          result.state.status === "finished"
            ? room.players.map((entry) => ({ ...entry, reconnectDeadline: null }))
            : room.players,
        game: result.state,
      });
      this.ctx.storage.kv.put(roomStorageKey, updatedRoom);
      return { status: "placed", room: updatedRoom };
    });
  }

  private resign(tokenHash: string):
    | { status: "resigned"; room: Room }
    | {
        status:
          | "not_found"
          | "unauthorized"
          | "game_not_started"
          | "game_finished"
          | "not_your_turn"
          | "already_eliminated"
          | "time_expired";
      } {
    return this.ctx.storage.transactionSync(() => {
      const room = this.readRoom();
      if (room === null) return { status: "not_found" };
      if (room.status === "waiting") return { status: "game_not_started" };
      if (room.status === "finished") return { status: "game_finished" };
      if (isClockExpired(room.clock, Date.now())) return { status: "time_expired" };
      const membership = this.readMembership(tokenHash);
      if (membership === null) return { status: "unauthorized" };
      const player = room.players.find((entry) => entry.id === membership.playerId);
      if (player === undefined) return { status: "unauthorized" };
      if (room.game.eliminatedColors.includes(player.color)) {
        return { status: "already_eliminated" };
      }
      if (room.game.turn !== player.color) return { status: "not_your_turn" };
      const result = eliminateColor(room.game, player.color);
      if (!result.ok) throw new Error("Could not resign current player");
      const updated = roomSchema.parse({
        ...room,
        status: result.state.status,
        game: result.state,
        clock: advanceClock(room.clock, room.game.turn, result.state.turn, Date.now(), true),
        players: room.players.map((entry) => ({
          ...entry,
          reconnectDeadline:
            result.state.status === "finished" || entry.id === player.id
              ? null
              : entry.reconnectDeadline,
        })),
      });
      this.ctx.storage.kv.put(roomStorageKey, updated);
      return { status: "resigned", room: updated };
    });
  }

  private rejectAction(socket: WebSocket, error: RoomSocketError): void {
    this.sendSocketError(socket, error);
    const room = this.readRoom();
    if (room !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(this.roomSnapshot(room)));
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.reconcileDeadlines();
    const room = this.readRoom();
    if (room === null) {
      return Response.json(roomSocketContract.error.parse({ error: "not_found" }), { status: 404 });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(roomSocketContract.error.parse({ error: "upgrade_required" }), {
        status: 426,
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(this.roomSnapshot(room)));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 1024) {
      this.sendSocketError(socket, "invalid_request");
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(message);
    } catch {
      this.sendSocketError(socket, "invalid_request");
      return;
    }

    const parsed = roomSocketContract.clientMessage.safeParse(body);
    if (!parsed.success) {
      this.sendSocketError(socket, "invalid_request");
      return;
    }

    try {
      await this.reconcileDeadlines();
      if (this.readRoom() === null) {
        this.sendSocketError(socket, "not_found");
        return;
      }
      if (parsed.data.type === "room.auth") {
        const tokenHash = await hashMembershipToken(parsed.data.token);
        const existing: unknown = socket.deserializeAttachment();
        if (
          typeof existing === "object" &&
          existing !== null &&
          "tokenHash" in existing &&
          existing.tokenHash !== tokenHash
        ) {
          this.sendSocketError(socket, "unauthorized");
          return;
        }
        const result = await this.getRoomMembership(tokenHash);
        if (result.status !== "found") {
          socket.serializeAttachment(null);
          this.sendSocketError(
            socket,
            result.status === "not_found" ? "not_found" : "unauthorized",
          );
          return;
        }

        socket.serializeAttachment({ tokenHash });
        const room = this.readRoom();
        const player = room?.players.find((entry) => entry.id === result.membership.playerId);
        if (player !== undefined && player.reconnectDeadline !== null) {
          const updated = this.ctx.storage.transactionSync(() => {
            const current = this.readRoom();
            if (current === null) return null;
            const next = roomSchema.parse({
              ...current,
              players: current.players.map((entry) =>
                entry.id === player.id ? { ...entry, reconnectDeadline: null } : entry,
              ),
            });
            this.ctx.storage.kv.put(roomStorageKey, next);
            return next;
          });
          if (updated !== null) {
            await this.syncAlarm(updated);
            this.broadcastRoom(updated);
          }
        }
        socket.send(
          JSON.stringify(
            roomSocketContract.message.parse({
              type: "room.authenticated",
              membership: result.membership,
            }),
          ),
        );
        return;
      }

      const attachment: unknown = socket.deserializeAttachment();
      const tokenHash =
        typeof attachment === "object" && attachment !== null && "tokenHash" in attachment
          ? membershipTokenSchema.safeParse(attachment.tokenHash)
          : null;
      if (tokenHash === null || !tokenHash.success) {
        this.sendSocketError(socket, "unauthorized");
        return;
      }

      if (parsed.data.type === "room.ready.set") {
        const result = this.setReady(tokenHash.data, parsed.data.ready);
        if (result.status === "updated") {
          this.broadcastRoom(result.room);
        } else if (result.status === "unchanged") {
          const room = this.readRoom();
          if (room !== null) {
            socket.send(JSON.stringify(this.roomSnapshot(room)));
          }
        } else {
          this.rejectAction(socket, result.status);
        }
        return;
      }

      if (
        parsed.data.type === "room.cpu.add" ||
        parsed.data.type === "room.cpu.remove" ||
        parsed.data.type === "room.cpu.level.set"
      ) {
        const result = this.updateCpu(tokenHash.data, parsed.data);
        if (result.status === "updated") this.broadcastRoom(result.room);
        else if (result.status === "unchanged") {
          const room = this.readRoom();
          if (room !== null) socket.send(JSON.stringify(this.roomSnapshot(room)));
        } else this.rejectAction(socket, result.status);
        return;
      }

      if (parsed.data.type === "room.game.start") {
        const result = this.startGame(tokenHash.data);
        if (result.status === "started") {
          await this.syncAlarm(result.room);
          this.broadcastRoom(result.room);
        } else this.rejectAction(socket, result.status);
        return;
      }

      if (parsed.data.type === "room.game.resign") {
        const result = this.resign(tokenHash.data);
        if (result.status === "resigned") {
          await this.syncAlarm(result.room);
          this.broadcastRoom(result.room);
        } else if (result.status === "time_expired") {
          await this.reconcileDeadlines();
          this.rejectAction(socket, result.status);
        } else this.rejectAction(socket, result.status);
        return;
      }

      const result = this.placeStone(tokenHash.data, parsed.data.action);
      if (result.status === "placed") {
        await this.syncAlarm(result.room);
        this.broadcastRoom(result.room);
      } else if (result.status === "time_expired") {
        await this.reconcileDeadlines();
        this.rejectAction(socket, result.status);
      } else this.rejectAction(socket, result.status);
    } catch {
      this.sendSocketError(socket, "internal_error");
    }
  }

  private async socketGone(socket: WebSocket): Promise<void> {
    const attachment: unknown = socket.deserializeAttachment();
    if (
      typeof attachment !== "object" ||
      attachment === null ||
      !("tokenHash" in attachment) ||
      typeof attachment.tokenHash !== "string"
    )
      return;
    const tokenHash = attachment.tokenHash;
    if (this.hasOpenConnection(tokenHash, socket)) return;
    await this.reconcileDeadlines();
    if (this.hasOpenConnection(tokenHash, socket)) return;
    const membership = this.readMembership(tokenHash);
    const room = this.readRoom();
    if (membership === null || room === null || room.status === "finished") return;
    const player = room.players.find((entry) => entry.id === membership.playerId);
    if (
      player === undefined ||
      (room.status === "playing" &&
        player.color !== null &&
        room.game.eliminatedColors.includes(player.color)) ||
      player.reconnectDeadline !== null
    )
      return;
    const updated = this.ctx.storage.transactionSync(() => {
      const current = this.readRoom();
      if (current === null || current.status === "finished") return null;
      const next = roomSchema.parse({
        ...current,
        players: current.players.map((entry) =>
          entry.id === player.id
            ? { ...entry, reconnectDeadline: Date.now() + reconnectGraceMs }
            : entry,
        ),
      });
      this.ctx.storage.kv.put(roomStorageKey, next);
      return next;
    });
    if (updated !== null) {
      await this.syncAlarm(updated);
      this.broadcastRoom(updated);
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      // 切断済みの接続は、そのまま無視します。
    }
    await this.socketGone(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    try {
      socket.close(1011, "Connection error");
    } catch {
      // 切断済みの接続は、そのまま無視します。
    }
    await this.socketGone(socket);
  }
}
