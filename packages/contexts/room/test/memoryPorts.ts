import type { ReversiRoom, Room, RoomMembership, SystemChatMessage } from "@tetraboard/protocol";
import {
  runRoomUseCase,
  type FinishedProgress,
  type PlayingFor,
  type ProgressFor,
  type RoomEffect,
  type RoomGamePort,
  type RoomOperation,
  type RoomPorts,
  type RoomStatePort,
  type SettingsResult,
} from "../src";

export const now = 100_000;
export const human = (id: string) => ({
  id,
  name: id,
  kind: "human" as const,
  avatarUrl: null,
  ready: false,
  reconnectDeadline: null,
  color: null,
});
export function waiting(): Extract<ReversiRoom, { status: "waiting" }> {
  return {
    id: "12345",
    instanceId: "instance",
    status: "waiting",
    publicUpdatedAtMs: 10,
    lastActivityAtMs: 10,
    settings: { game: "reversi", timeControl: { mainTimeMs: 60_000, byoyomiMs: 0 } },
    players: [human("host")],
    eliminations: [],
    game: null,
    clock: null,
    lastRound: null,
    roundId: null,
    positionRevision: 0,
  };
}
export function playing(): PlayingFor<"reversi"> {
  const room = waiting();
  return {
    ...room,
    status: "playing",
    roundId: "round",
    positionRevision: 1,
    lastRound: null,
    players: [
      { ...human("host"), color: "black" },
      { ...human("guest"), color: "white" },
    ],
    clock: {
      turnStartedAt: now - 1000,
      turnExpiresAt: now + 60_000,
      remainingMainMs: { black: 60_000, white: 60_000 },
    },
    game: {
      status: "playing",
      board: [],
      turn: "black",
      eliminatedColors: [],
      consecutivePasses: [],
      moveNumber: 0,
      lastMove: null,
      result: null,
    },
  };
}
export function finished(): FinishedProgress<"reversi"> {
  const room = playing();
  return {
    kind: "finished",
    gameId: "reversi",
    room,
    at: now,
    game: {
      ...room.game,
      status: "finished",
      turn: null,
      result: { reason: "last_player", winner: "black", stoneCounts: { black: 2, white: 2 } },
    },
  };
}

export class MemoryPorts {
  room: Room | null = waiting();
  memberships = new Map<string, RoomMembership>([
    ["host-token", { playerId: "host", role: "host" }],
  ]);
  tokens = new Map([["host", "host-token"]]);
  connections = new Set(["host-token"]);
  disconnected = new Map<string, number>();
  departed = new Set<string>();
  registrations = new Set<string>();
  released: [string, boolean][] = [];
  chat: { event: SystemChatMessage["event"]; text: string; at: number }[] = [];
  calls: string[] = [];
  tournamentWaiting = false;
  progress: ProgressFor<"reversi"> = { kind: "playing", gameId: "reversi", room: playing() };
  settingsResult: SettingsResult | { status: "room_changed" } = { status: "unchanged" };
  afterDrawResult: ProgressFor<"reversi"> | null = null;
  keepWithoutHumans = false;
  failWaiting = false;

  readonly state: RoomStatePort = {
    playerLabel: (p) => (p.kind === "cpu" ? `CPU Lv${p.level}` : p.name),
    readRoom: () => this.room,
    hasRoom: () => this.room !== null,
    saveRoom: (room) => {
      this.calls.push("saveRoom");
      this.room = room;
      return room;
    },
    initializeRoom: () => {
      this.calls.push("initializeRoom");
    },
    clearRoom: () => {
      this.calls.push("clearRoom");
      this.room = null;
    },
    membership: (hash) => this.memberships.get(hash) ?? null,
    hasMembership: (hash) => this.memberships.has(hash),
    saveMembership: (hash, m) => {
      this.memberships.set(hash, m);
    },
    deleteMembership: (hash) => {
      this.memberships.delete(hash);
    },
    playerToken: (id) => this.tokens.get(id) ?? null,
    savePlayerToken: (id, hash) => {
      this.tokens.set(id, hash);
    },
    deletePlayerToken: (id) => {
      this.tokens.delete(id);
    },
    hasConnection: (hash) => this.connections.has(hash),
    disconnectedAt: (id) => this.disconnected.get(id),
    saveDisconnectedAt: (id, at) => {
      this.disconnected.set(id, at);
    },
    clearPlayerTransientState: (id) => {
      this.disconnected.delete(id);
    },
    clearClosedPlayerState: (id) => {
      this.disconnected.delete(id);
      this.departed.delete(id);
    },
    hasDeparted: (id) => this.departed.has(id),
    saveDeparted: (id) => {
      this.departed.add(id);
    },
    clearDeparted: (id) => {
      this.departed.delete(id);
    },
    isHumanParticipant: (player) =>
      player.kind === "human" &&
      !player.retired &&
      !this.departed.has(player.id) &&
      this.tokens.has(player.id),
    registrationDeadline: () => undefined,
    expireRegistration: () => {},
    waitingTournament: () => null,
    hasCpuCapacity: () => true,
    hasRegistration: (id) => this.registrations.has(id),
    releaseRegistration: (id) => {
      this.registrations.delete(id);
    },
    releaseAccount: (id, avatar) => {
      this.calls.push(`release:${id}:${avatar}`);
      this.released.push([id, avatar]);
    },
    saveAdmission: (id) => {
      this.calls.push(`admit:${id}`);
    },
    saveIdentity: (id) => {
      this.calls.push(`identity:${id}`);
    },
    deleteIdentity: (id) => {
      this.calls.push(`deleteIdentity:${id}`);
    },
    appendSystem: (event, text, at) => {
      this.chat.push({ event, text, at });
    },
    closeReservations: () => {
      this.calls.push("closeReservations");
    },
    finishTournament: () => {
      this.calls.push("finishTournament");
    },
    excludeWaitingTournamentPlayer: () => this.tournamentWaiting,
    startMatchUsage: () => {
      this.calls.push("startUsage");
      return [this.usage("completed")];
    },
    endMatchUsage: (status) => {
      this.calls.push(`endUsage:${status}`);
      return [this.usage(status)];
    },
  };

  readonly adapter: RoomGamePort<"reversi"> = {
    cpu: {
      usesIdleDeadline: () => true,
      timeout: () => this.progress,
      disconnect: () => this.progress,
      step: (room) => ({ room }),
    },
    capacity: 2,
    waitingSeat: { color: null },
    keepsPlayingWithoutHumans: () => this.keepWithoutHumans,
    prepareSettings: () => this.settingsResult,
    start: () => {
      this.calls.push("start");
      const room = playing();
      this.state.saveRoom(room);
      return { room, roundId: "round", at: now };
    },
    play: () => this.progress,
    draw: () => this.progress,
    declare: () => this.progress,
    resign: () => this.progress,
    afterDraw: (room) => this.afterDrawResult ?? { kind: "unchanged", gameId: "reversi", room },
    settings: () => this.settingsResult as SettingsResult,
    prepareLeave: () => {
      this.calls.push("prepareLeave");
      return () => {
        this.calls.push("leave");
        return this.progress;
      };
    },
    afterLeave: (room) => {
      this.calls.push("afterLeave");
      return room;
    },
    finish: (result, retain) => {
      this.calls.push("finalize");
      const players = retain(result.room.players, result.at);
      if (!players) return null;
      this.calls.push("waiting");
      if (this.failWaiting) throw new Error("waiting failed");
      return { ...waiting(), players: players.map((p) => ({ ...p, color: null })) };
    },
    close: () => {
      this.calls.push("closeGame");
    },
  };

  readonly ports: RoomPorts = {
    state: this.state,
    // このテストのゲーム実装は reversi だけで、呼び出すルームも reversi に固定します。
    game: () => this.adapter as unknown as ReturnType<RoomPorts["game"]>,
  } as RoomPorts;

  run<T>(action: (op: RoomOperation) => T, at = now) {
    return runRoomUseCase(this.ports, at, action);
  }
  addGuest() {
    if (this.room?.status !== "waiting") throw new Error("Expected waiting");
    this.room = { ...this.room, players: [...this.room.players, human("guest")] } as Room;
    this.tokens.set("guest", "guest-token");
    this.memberships.set("guest-token", { playerId: "guest", role: "player" });
    this.connections.add("guest-token");
  }
  private usage(status: "completed" | "abandoned"): RoomEffect {
    return {
      type: "usage",
      event: {
        name: "match_ended",
        isTest: false,
        matchId: "round",
        result: status,
        reason: status,
        durationMs: 1000,
      },
    };
  }
}
