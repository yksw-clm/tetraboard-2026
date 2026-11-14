import { z } from "zod";
import {
  createRoomContract,
  joinRoomContract,
  getRoomContract,
  leaveRoomContract,
} from "@tetraboard/protocol";
import { Api, ApiError, AccessRequired, type Fetcher } from "./api";
import { LocalAi, type Analysis } from "./ai";
import { scope, sleep, type RunConfig, type Log } from "./config";
import { Store, type BotState, type Seat } from "./store";
import { Queue } from "./queue";
import { RoomSession, StopControl, StopRequested } from "./session";
import { supported, sendAt } from "./game";

export class Bot {
  readonly api: Api;
  state: BotState;
  private blocked = false;
  private accessPending = false;
  private checking = false;
  constructor(
    readonly config: RunConfig,
    readonly store: Store,
    api: Api,
    state: BotState,
    readonly stop: StopControl,
    private ai: Analysis,
    readonly log: Log,
    private delay = sendAt,
    private pause = () => sleep(25),
  ) {
    this.api = api;
    this.state = state;
  }
  save = () => this.store.saveState(this.state);
  draining = () => this.stop.mode !== "running" || this.blocked;
  closeAi() {
    return this.ai.close();
  }
  private async access() {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.api.checkAccess();
      this.accessPending = false;
    } catch (error) {
      if (
        error instanceof AccessRequired ||
        (error instanceof ApiError && [401, 403].includes(error.status))
      ) {
        this.blocked = true;
        this.log("access_required", {
          reason:
            error instanceof AccessRequired
              ? error.message
              : "ブラウザでログインと規約を確認してください",
        });
      } else {
        this.accessPending = true;
        this.log("access_unavailable");
      }
    } finally {
      this.checking = false;
    }
  }
  async enter(room?: { roomId: string; instanceId: string }): Promise<Seat> {
    if (this.state.seat) return this.state.seat;
    if (this.state.uncertain)
      throw Error("前回の入室結果が不明です。サーバー上の状態確認が必要です");
    if (this.draining()) throw new StopRequested("参加を停止しました");
    await this.api.checkAccess();
    if (this.draining()) throw new StopRequested("参加を停止しました");
    this.state.uncertain = true;
    await this.save();
    if (this.draining()) {
      delete this.state.uncertain;
      await this.save();
      throw new StopRequested("参加を停止しました");
    }
    try {
      const target = this.config.target;
      const creating = target.type === "create" && room === undefined;
      const entry = creating
        ? await this.api.request(`/api${createRoomContract.path}`, createRoomContract.response, {
            method: "POST",
            body: {
              quickPlay: false,
              game: this.config.game,
              mode: "singles",
              timeControl: target.timeControl,
              ...(this.config.game === "four-shogi"
                ? { threePlayerAttackProhibited: target.threePlayerAttackProhibited }
                : {}),
            },
            consent: true,
          })
        : await this.api.request(
            `/api${joinRoomContract.pathFor(room!.roomId)}`,
            joinRoomContract.response,
            { method: "POST", body: { instanceId: room!.instanceId }, consent: true },
          );
      if (!supported(entry.room) || entry.room.settings.game !== this.config.game)
        throw Error("対象外のルームです");
      this.state.seat = {
        roomId: entry.room.id,
        instanceId: entry.room.instanceId,
        token: entry.membership.token,
        playerId: entry.membership.playerId,
      };
      delete this.state.uncertain;
      await this.save();
      this.log("joined", { room: entry.room.id, url: `${this.api.origin}/rooms/${entry.room.id}` });
      return this.state.seat;
    } catch (error) {
      if (error instanceof ApiError && [400, 401, 403, 404, 409, 410, 429].includes(error.status)) {
        delete this.state.uncertain;
        await this.save();
      }
      throw error;
    }
  }
  async leave(): Promise<void> {
    if (!this.state.seat) return;
    try {
      await this.api.request(`/api${leaveRoomContract.pathFor(this.state.seat.roomId)}`, z.null(), {
        method: "POST",
        bearer: this.state.seat.token,
      });
    } catch (error) {
      if (!(error instanceof ApiError) || ![404, 410].includes(error.status)) throw error;
    }
    delete this.state.seat;
    await this.save();
  }
  async run(): Promise<void> {
    const queue = new Queue(
      this.api,
      this.config,
      this.state,
      this.save,
      this.stop,
      this.draining,
      this.log,
    );
    const pendingChecks = new Set<Promise<void>>();
    const interval = setInterval(() => {
      const check = this.access();
      pendingChecks.add(check);
      void check.finally(() => pendingChecks.delete(check));
    }, 60000);
    try {
      for (;;) {
        if (
          !this.state.seat &&
          (this.config.target.type === "room" || this.config.target.type === "create")
        )
          break;
        if (!this.state.seat && this.draining()) break;
        if (!this.state.seat && this.accessPending) {
          await this.access();
          await sleep(1000);
          continue;
        }
        try {
          const seat = this.state.seat ?? (await queue.next());
          if (!seat) break;
          const session = new RoomSession(
            this.api,
            seat,
            this.config.game,
            this.ai,
            this.stop,
            this.draining,
            this.log,
            this.delay,
            this.pause,
          );
          const result = await session.play(
            this.config.target.type === "rated" || this.config.target.type === "tournament",
          );
          if (result === "lost") {
            delete this.state.seat;
            await this.save();
          } else await this.leave();
          if (this.config.target.type === "room" || this.config.target.type === "create") break;
          if (this.draining()) break;
          await queue.clear();
        } catch (error) {
          if (
            error instanceof AccessRequired ||
            (error instanceof ApiError && [401, 403].includes(error.status))
          ) {
            this.blocked = true;
            this.log("access_required");
            await this.leave().catch(() => this.log("leave_pending"));
            break;
          }
          if (error instanceof ApiError && [0, 409, 429, 503].includes(error.status)) {
            this.log("retry", { reason: error.code });
            await sleep(1000);
            continue;
          }
          throw error;
        }
      }
    } finally {
      clearInterval(interval);
      await Promise.allSettled(pendingChecks);
      if (this.stop.mode === "force" || !this.state.seat) {
        const assigned = await queue.forceCancel();
        if (assigned && this.stop.mode === "force") {
          this.state.seat = assigned;
          await this.save();
          await this.leave().catch(() => this.log("leave_pending"));
        }
      }
      await this.ai.close();
      this.log("stopped");
    }
  }
}

export async function runBots(
  config: RunConfig,
  stop: StopControl,
  options: {
    home?: string;
    analysis?: () => Analysis;
    log?: (profile: string) => Log;
    delay?: typeof sendAt;
    pause?: () => Promise<void>;
    fetcher?: Fetcher;
  } = {},
): Promise<void> {
  const releases: (() => Promise<void>)[] = [];
  const bots: Bot[] = [];
  const entered: Bot[] = [];
  const unlockers = new Map<Bot, () => Promise<void>>();
  const run = (bot: Bot) =>
    bot
      .run()
      .catch((error) => {
        bot.log("failed", {
          reason:
            error instanceof ApiError
              ? error.code
              : error instanceof Error
                ? error.message
                : "unknown",
        });
        throw error;
      })
      .finally(() => unlockers.get(bot)!());
  try {
    const identities = new Set<string>();
    for (const name of config.profiles) {
      const store = new Store(config.origin, name, options.home);
      const release = await store.lock();
      let released = false;
      const unlock = async () => {
        if (!released) {
          released = true;
          await release();
        }
      };
      releases.push(unlock);
      const profile = await store.loadProfile();
      if (!profile) throw Error(`${name}: authコマンドでCookieを取り込んでください`);
      const api = new Api(config.origin, profile, (p) => store.saveProfile(p), options.fetcher);
      const identity = await api.checkAccess();
      if (identities.has(identity)) throw Error("複数のBOTに同じ登録アカウントが指定されています");
      identities.add(identity);
      const previous = await store.loadState();
      if (
        previous &&
        previous.scope !== scope(config) &&
        (previous.seat || previous.operationId || previous.uncertain)
      )
        throw Error(`${name}: 前回と同じ参加先で復帰・停止してください`);
      const state =
        previous?.scope === scope(config)
          ? previous
          : { scope: scope(config), controllerId: crypto.randomUUID() };
      if (state.uncertain) throw Error(`${name}: 前回の参加結果が不明です。状態確認が必要です`);
      await store.saveState(state);
      const log =
        options.log?.(name) ??
        ((event, details) =>
          console.log(
            JSON.stringify({ time: new Date().toISOString(), bot: name, event, ...details }),
          ));
      const bot = new Bot(
        config,
        store,
        api,
        state,
        stop,
        options.analysis?.() ?? new LocalAi(),
        log,
        options.delay,
        options.pause,
      );
      bots.push(bot);
      unlockers.set(bot, unlock);
    }
    if (config.target.type === "create" && stop.mode === "running") {
      const existing = bots.flatMap((bot) => (bot.state.seat ? [bot.state.seat] : []));
      if (new Set(existing.map((seat) => seat.instanceId)).size > 1)
        throw Error("BOTの保存先ルームが一致しません");
      let host = existing[0];
      for (const bot of bots) {
        if (stop.mode !== "running" && !bot.state.seat) continue;
        const wasSeated = !!bot.state.seat;
        host = await bot.enter(host);
        if (!wasSeated) entered.push(bot);
      }
    } else if (config.target.type === "room" && stop.mode === "running") {
      const frame = await bots[0].api.request(
        `/api${getRoomContract.pathFor(config.target.roomId)}`,
        getRoomContract.response,
      );
      if (
        !supported(frame.room) ||
        frame.room.settings.game !== config.game ||
        frame.room.tournamentId ||
        frame.room.matchmaking
      )
        throw Error("指定先は通常ルームの対象ゲーム・シングルスではありません");
      for (const bot of bots) {
        if (stop.mode !== "running" && !bot.state.seat) continue;
        const wasSeated = !!bot.state.seat;
        await bot.enter({ roomId: frame.room.id, instanceId: frame.room.instanceId });
        if (!wasSeated) entered.push(bot);
      }
    }
    entered.length = 0;
    const results = await Promise.allSettled(bots.map(run));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  } catch (error) {
    if (!(error instanceof StopRequested)) throw error;
    entered.length = 0;
    await Promise.allSettled(bots.map(run));
  } finally {
    for (const bot of entered) await bot.leave().catch(() => bot.log("leave_pending"));
    await Promise.allSettled(bots.map((bot) => bot.closeAi()));
    for (const release of releases.reverse()) await release();
  }
}
