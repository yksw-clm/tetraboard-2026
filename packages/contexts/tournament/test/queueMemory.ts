import type {
  State,
  Waiting,
  Group,
  Player,
  TournamentQueueRuntime,
  TournamentQueueStore,
  TournamentQueueStorage,
  TournamentCoordinatorWrite,
  WaitingProfile,
  PrepareTournamentRoomInput,
  RekeyTournamentPlayerInput,
  TournamentAdmission,
} from "../src";
import { row, settings } from "./fixtures";

class MemoryStorage implements TournamentQueueStorage {
  saved: State | undefined;
  fences = new Set<string>();
  alarm: number | undefined;
  save(state: State) {
    this.saved = structuredClone(state);
  }
  cancelled(key: string) {
    return this.fences.has(key);
  }
  cancel(key: string) {
    this.fences.add(key);
  }
  async setAlarm(at: number) {
    this.alarm = at;
  }
  async deleteAlarm() {
    this.alarm = undefined;
  }
}
class MemoryQueue implements TournamentQueueStore {
  leases = new Map<string, Waiting>();
  seats = new Map<string, TournamentAdmission>();
  ledger = new Map<string, string>();
  failCommit = false;
  failPublish = false;
  latest: { id: number | null; ends: number | null } | null = null;
  constructor(private f: QueueFixture) {}
  async waitingProfiles(_key: string) {
    return new Map(
      [...this.leases.values()]
        .filter((w) => w.expiresAtMs > this.f.time && this.f.profiles.has(w.accountId))
        .map((w) => [
          w.operationId,
          { ...this.f.profiles.get(w.accountId)!, operationId: w.operationId },
        ]),
    );
  }
  async leaseValid(wait: Waiting, _key: string) {
    const lease = this.leases.get(wait.accountId);
    return (
      lease?.operationId === wait.operationId &&
      lease.expiresAtMs > this.f.time &&
      this.f.profiles.has(wait.accountId)
    );
  }
  async forget(wait: Waiting) {
    if (this.leases.get(wait.accountId)?.operationId === wait.operationId)
      this.leases.delete(wait.accountId);
  }
  async restore(player: Player, _key: string) {
    this.leases.set(player.accountId, { ...player });
    return true;
  }
  preparePlayer(player: Player, _profile: WaitingProfile, _key: string) {
    return [{ value: () => this.seats.set(player.accountId, { ...player.admission }) }];
  }
  async commit(writes: TournamentCoordinatorWrite[]) {
    if (this.failCommit) throw new Error("seat batch failed");
    for (const write of writes) (write.value as () => void)();
  }
  async releaseWaiting(players: Player[]) {
    for (const p of players) await this.forget(p);
  }
  async roomUsed(_id: string) {
    return false;
  }
  async ensureGroup(_state: State, group: Group) {
    if (!this.ledger.has(group.id)) this.ledger.set(group.id, "reserved");
    for (const p of group.players) {
      const lease = this.leases.get(p.accountId);
      if (lease?.operationId === p.operationId) lease.expiresAtMs = p.expiresAtMs;
    }
  }
  async markAborted(group: Group) {
    this.ledger.set(group.id, "aborted");
  }
  async markPlaying(group: Group, _startedAtMs: number) {
    this.ledger.set(group.id, "playing");
  }
  async ledgerPhase(group: Group) {
    const phase = this.ledger.get(group.id);
    return phase ? { phase } : null;
  }
  async occupied(group: Group) {
    return [...this.seats.values()].some((s) => s.instanceId === group.instanceId);
  }
  async participation(_key: string, accountId: string) {
    if (!this.f.definition.published || !this.f.profiles.has(accountId)) return null;
    const wait = this.leases.get(accountId);
    return {
      waitingOperation: wait?.operationId ?? null,
      leaseUntilMs: wait?.expiresAtMs ?? null,
      seatOperation: this.seats.get(accountId)?.operationId ?? null,
      endsAtMs: this.f.definition.ends_at_ms!,
    };
  }
  async enqueue(wait: Waiting, _key: string) {
    if (this.seats.has(wait.accountId) || this.leases.has(wait.accountId)) throw new Error("busy");
    this.leases.set(wait.accountId, { ...wait });
  }
  async heartbeat(wait: Waiting, expiresAtMs: number) {
    if (
      !(await this.leaseValid(wait, this.f.state.key)) ||
      this.f.time >= this.f.definition.ends_at_ms!
    )
      return false;
    this.leases.get(wait.accountId)!.expiresAtMs = expiresAtMs;
    return true;
  }
  async latestPublished() {
    return this.latest;
  }
  async publish(_key: string, version: number, id: number, now: number) {
    if (this.failPublish || this.f.definition.version !== version || this.f.definition.published)
      return false;
    Object.assign(this.f.definition, {
      public_id: id,
      published: 1,
      version: version + 1,
      updated_at_ms: now,
    });
    return true;
  }
}
export class QueueFixture implements TournamentQueueRuntime {
  time = 1000;
  definition = row({ starts_at_ms: 1000, ends_at_ms: 1_000_000 });
  state: State = { key: "tournament", waiting: [], groups: [] };
  storage = new MemoryStorage();
  store = new MemoryQueue(this);
  profiles = new Map<string, WaitingProfile>();
  rules = { leaseMs: 30000, connectionGraceMs: 30000 };
  prepared: PrepareTournamentRoomInput[] = [];
  rekeys: RekeyTournamentPlayerInput[] = [];
  released: TournamentAdmission[] = [];
  refreshed: string[] = [];
  finalizations: string[] = [];
  roomState: { status: string; connectedPlayerIds: string[]; startedAtMs?: number } = {
    status: "waiting",
    connectedPlayerIds: [],
  };
  prepareResult = "prepared";
  abortResult = "aborted";
  rekeyResult = "updated";
  rekeyFailure = false;
  sequences = new Map<string, number>();
  private id = 0;
  constructor(count = 4) {
    for (let i = 1; i <= count; i++)
      this.profiles.set(`a${i}`, {
        id: `a${i}`,
        name: `名前${i}`,
        isAnonymous: i === 4 ? 1 : 0,
        avatarKey: null,
        avatarPresetId: null,
        entryId: `e${i}`,
        operationId: `w${i}`,
      });
  }
  async read(_key: string) {
    return this.definition;
  }
  async eligible(accountId: string, _key: string) {
    return this.profiles.get(accountId) ?? null;
  }
  async finalize(key: string) {
    this.finalizations.push(key);
  }
  settings() {
    return settings;
  }
  async credential(input: Parameters<TournamentQueueRuntime["credential"]>[0]) {
    const token = `${input.accountId}:${input.operationId}:${input.controllerId}:${input.controllerVersion}`;
    return { token, tokenHash: `hash:${token}` };
  }
  avatar(profile: WaitingProfile) {
    return { avatarKey: profile.avatarKey, avatarPresetId: profile.avatarPresetId };
  }
  async releaseReservation(admission: TournamentAdmission) {
    this.released.push({ ...admission });
    if (this.store.seats.get(admission.accountId)?.operationId === admission.operationId)
      this.store.seats.delete(admission.accountId);
  }
  async reserveMatchSequence(id: string, _scope: string) {
    if (!this.sequences.has(id)) this.sequences.set(id, this.sequences.size + 1);
    return this.sequences.get(id)!;
  }
  async refresh(key: string) {
    this.refreshed.push(key);
  }
  room(_roomId: string) {
    return {
      abortTournamentRoom: async (_id: string, _excluded: string[]) => ({
        status: this.abortResult,
      }),
      prepareTournamentRoom: async (input: PrepareTournamentRoomInput) => {
        this.prepared.push(structuredClone(input));
        return { status: this.prepareResult };
      },
      rekeyTournamentPlayer: async (input: RekeyTournamentPlayerInput) => {
        this.rekeys.push({ ...input });
        if (this.rekeyFailure) throw new Error("RPC failed");
        return { status: this.rekeyResult };
      },
      getTournamentReservationState: async (_id: string) => structuredClone(this.roomState),
    };
  }
  now = () => this.time;
  randomId = () => `id${++this.id}`;
  randomRoomId = () => "12345";
  random = (bound: number) => bound - 1;
}
