import type {
  MatchmakingRuntime,
  MatchmakingStore,
  MatchmakingWrite,
  MatchmakingRoomInput,
  MatchmakingRoomState,
  State,
  Profile,
  Wait,
  Group,
  Player,
  LatestQueueRating,
} from "../src";

export class MemoryMatchmaking {
  now = 100_000;
  sequence = 0;
  cpuSeats = 12;
  state: State = { key: "legacy", waiting: [], groups: [] };
  saved = structuredClone(this.state);
  ended = new Set<string>();
  profiles = new Map<string, Profile>();
  leases = new Map<string, Wait>();
  seats = new Set<string>();
  pending = new Set<string>();
  latest = new Map<string, LatestQueueRating>();
  rooms = new Map<string, MatchmakingRoomInput>();
  roomStates = new Map<string, MatchmakingRoomState>();
  events: { operationId: string; stage: string; reason: string | null }[] = [];
  prepareResult = "prepared";
  r: MatchmakingRuntime = {
    game: "four-reversi",
    legacy: true,
    retired: false,
    diagnostics: false,
    legacyKey: "legacy",
    queueRules: {
      key: "legacy",
      seats: 4,
      fillAfterMs: 30_000,
      leaseMs: 45_000,
      connectionGraceMs: 30_000,
    },
    storage: {
      save: (state) => {
        this.saved = structuredClone(state);
      },
      ended: (operationId) => this.ended.has(operationId),
      end: (operationId) => {
        this.ended.add(operationId);
      },
      endAndSave: (operationId, state) => {
        this.ended.add(operationId);
        this.saved = structuredClone(state);
      },
    },
    store: this.createStore(),
    credential: async (wait) => ({
      token: `token:${wait.operationId}:${wait.version}`,
      tokenHash: `hash:${wait.operationId}:${wait.version}`,
    }),
    releaseReservation: async (admission) => {
      this.seats.delete(admission.operationId);
    },
    reserveMatchSequence: async () => 1,
    room: (roomId) => ({
      abortMatchmakingRoom: async () => {
        if (this.roomStates.get(roomId)?.started) return { status: "already_started" };
        this.rooms.delete(roomId);
        return { status: "aborted" };
      },
      rekeyMatchmakingPlayer: async () => true,
      prepareMatchmakingRoom: async (input) => {
        if (this.prepareResult === "prepared") this.rooms.set(roomId, structuredClone(input));
        return { status: this.prepareResult };
      },
      getMatchmakingState: async () =>
        this.roomStates.get(roomId) ?? {
          phase: "waiting",
          started: false,
          aiUnavailable: false,
          occupiedPlayerIds: [],
          connectedPlayerIds: [],
        },
    }),
    availableCpuSeats: async () => this.cpuSeats,
    now: () => this.now,
    randomId: () => `id-${++this.sequence}`,
    randomRoomId: () => String(++this.sequence).padStart(5, "0"),
    event: (wait, stage, reason) => {
      this.events.push({ operationId: wait.operationId, stage, reason });
    },
    diagnostic: () => {},
  };

  account(id: string) {
    this.profiles.set(id, {
      id,
      name: id,
      avatarKey: null,
      avatarPresetId: null,
      isAnonymous: 0,
      isTest: 0,
    });
  }

  private createStore(): MatchmakingStore {
    return {
      profile: async (id) => this.profiles.get(id) ?? null,
      forget: async (wait) => {
        this.leases.delete(wait.operationId);
      },
      restore: async (wait) => {
        if (!this.leases.has(wait.operationId)) return false;
        this.leases.set(wait.operationId, structuredClone(wait));
        return true;
      },
      releaseWaiting: async (group) => {
        for (const player of group.players) this.leases.delete(player.operationId);
      },
      hasSeat: async (_, operationId) => this.seats.has(operationId),
      hasLease: async (_, operationId, now) =>
        (this.leases.get(operationId)?.expiresAtMs ?? 0) > now,
      preparePlayer: (player, group) => this.preparePlayer(player, group),
      commit: async (writes) => {
        for (const write of writes) (write.value as () => void)();
      },
      clearPending: async () => {
        this.pending.clear();
      },
      pendingAccounts: async (ids) => new Set(ids.filter((id) => this.pending.has(id))),
      validWaits: async (_, now) =>
        [...this.leases.values()]
          .filter((wait) => wait.expiresAtMs > now)
          .map((wait) => ({ operationId: wait.operationId })),
      join: async (wait) => {
        if (this.pending.has(wait.accountId)) return { inserted: false };
        if ([...this.leases.values()].some((entry) => entry.accountId === wait.accountId))
          throw Error("busy");
        this.leases.set(wait.operationId, structuredClone(wait));
        return { inserted: true, latest: this.latest.get(wait.accountId) };
      },
      heartbeat: async (wait) => {
        this.leases.set(wait.operationId, structuredClone(wait));
      },
      occupiedOperations: async (ids) => ids.filter((id) => this.seats.has(id)),
    };
  }

  private preparePlayer(player: Player, group: Group): MatchmakingWrite[] {
    return [
      {
        value: () => {
          this.seats.add(player.admission.operationId);
          if (group.rating) this.pending.add(player.accountId);
        },
      },
    ];
  }
}
