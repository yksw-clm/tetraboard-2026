import { DurableObject } from "cloudflare:workers";
import {
  join,
  control,
  takeover,
  leaveAccount,
  purgeAccount,
  cleanupReleasedGroups,
  tick,
  status,
  previousRoom,
  orderWaits,
  type State,
  type MatchmakingRuntime,
} from "@tetraboard/context-matchmaking";
import { createMatchmakingRuntime } from "../../adapters/matchmaking/runtime";
import { DurableMatchmakingStorage } from "../../adapters/matchmaking/storage";
export class MatchmakingCoordinator extends DurableObject<Env> {
  private get storage() {
    return new DurableMatchmakingStorage(this.ctx.storage);
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // フェーズ 6 の掃除で消す。旧計測の保存待ちだけを初回起動時に削除します。
    ctx.blockConcurrencyWhile(async () => {
      if (ctx.storage.kv.get("legacy-analytics-purged")) return;
      ctx.storage.transactionSync(() => {
        for (const [key] of ctx.storage.kv.list({ prefix: "matchmaking-analytics-pending:" }))
          ctx.storage.kv.delete(key);
        ctx.storage.kv.put("legacy-analytics-purged", true);
      });
    });
  }
  private event(...args: Parameters<MatchmakingRuntime["event"]>) {
    createMatchmakingRuntime(this.ctx, this.env).event(...args);
  }
  private async serial<T>(run: (runtime: MatchmakingRuntime, state: State) => Promise<T>) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const runtime = createMatchmakingRuntime(this.ctx, this.env);
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      const state = this.storage.load(runtime.queueRules.key);
      const result = await run(runtime, state);
      if (runtime.ratingPolicy) orderWaits(runtime, state);
      this.storage.save(state);
      const now = Date.now();
      const deadlines = state.waiting.map((w) => w.expiresAtMs);
      const policy = runtime.ratingPolicy;
      if (policy) {
        const oldest = state.waiting.find((w) => (w.retryAtMs ?? 0) <= now);
        if (oldest) {
          const elapsed = now - oldest.joinedAtMs;
          const next =
            policy.wideningTimesMs.find((time) => elapsed < time) ?? runtime.queueRules.fillAfterMs;
          deadlines.push(
            elapsed >= runtime.queueRules.fillAfterMs
              ? Math.max(oldest.joinedAtMs + next, state.cpuRetryAtMs ?? 0)
              : oldest.joinedAtMs + next,
          );
        }
        for (const w of state.waiting) if ((w.retryAtMs ?? 0) > now) deadlines.push(w.retryAtMs!);
      } else {
        for (const w of state.waiting)
          deadlines.push(Math.max(w.joinedAtMs + runtime.queueRules.fillAfterMs, w.retryAtMs ?? 0));
      }
      for (const group of state.groups) {
        if (group.phase !== "playing") deadlines.push(Date.now() + 1000, group.expiresAtMs);
        else if (group.players.some((p) => p.credentialPending)) deadlines.push(Date.now() + 1000);
      }
      if (deadlines.length) {
        const deadline = Math.min(...deadlines);
        const currentTime = Date.now();
        // レート戦の待機期限が目前でも、未来の期限を後ろへずらさずに通知します。
        await this.ctx.storage.setAlarm(
          runtime.ratingPolicy && deadline > currentTime
            ? deadline
            : Math.max(currentTime + 100, deadline),
        );
      } else await this.ctx.storage.deleteAlarm();
      return result;
    });
  }

  async status(accountId: string | null, controllerId?: string, includeWaitingInfo = true) {
    const r = createMatchmakingRuntime(this.ctx, this.env);
    return status(
      r,
      this.storage.load(r.queueRules.key),
      accountId,
      controllerId,
      includeWaitingInfo,
    );
  }
  async previousRoom(accountId: string, matchId: string) {
    const r = createMatchmakingRuntime(this.ctx, this.env);
    return previousRoom(this.storage.load(r.queueRules.key), accountId, matchId);
  }
  async join(accountId: string, operationId: string, controllerId: string) {
    return this.serial((r, state) => join(r, state, accountId, operationId, controllerId));
  }
  async control(
    accountId: string,
    input: { operationId: string; controllerId: string; version: number },
    action: "heartbeat" | "cancel",
  ) {
    return this.serial((r, state) => control(r, state, accountId, input, action));
  }
  async takeover(
    accountId: string,
    operationId: string,
    controllerId: string,
    expectedVersion: number,
  ) {
    return this.serial((r, state) =>
      takeover(r, state, accountId, operationId, controllerId, expectedVersion),
    );
  }
  async leaveAccount(accountId: string) {
    return this.serial((r, state) => leaveAccount(r, state, accountId));
  }
  async purgeAccount(accountId: string) {
    await this.serial((r, state) => purgeAccount(r, state, accountId));
  }
  /** 毎時の既存保守から、解放済みの席だけをまとめて片付けます。 */
  async cleanupReleasedGroups() {
    return this.serial((r, state) => cleanupReleasedGroups(r, state));
  }
  async alarm() {
    await this.serial((r, state) => tick(r, state));
  }
}
