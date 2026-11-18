import { DurableObject } from "cloudflare:workers";
import * as tournament from "@tetraboard/context-tournament";
import { createTournamentRuntime } from "../../adapters/tournament/runtime";
import { DurableTournamentStorage } from "../../adapters/tournament/storage";
import { D1TournamentReader } from "../../adapters/tournament/reader";
import { D1TournamentEntries } from "../../adapters/tournament/entries";

/** 公開大会ごとの遷移を直列化します。 */
export class TournamentCoordinator extends DurableObject<Env> {
  private get storage() {
    return new DurableTournamentStorage(this.ctx.storage);
  }
  private get ports() {
    return createTournamentRuntime(this.ctx, this.env);
  }
  private async scheduleRecovery() {
    const recoveryAt = Date.now() + 5000;
    const scheduledAt = await this.ctx.storage.getAlarm();
    if (scheduledAt === null || recoveryAt < scheduledAt)
      await this.ctx.storage.setAlarm(recoveryAt);
  }
  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        // D1 と RPC の副作用の前に復旧を予約します。
        await this.scheduleRecovery();
        return { success: true as const, value: await operation() };
      } catch (error: unknown) {
        await this.scheduleRecovery();
        return { success: false as const, error };
      }
    });
    if (!result.success) throw result.error;
    return result.value;
  }
  async refresh(key: string) {
    return this.serial(async () => {
      const state = this.storage.load(key);
      this.storage.save(state);
      await tournament.tick(this.ports, state);
    });
  }
  async enroll(key: string, accountId: string): Promise<tournament.Result> {
    return this.serial(() =>
      tournament.enroll(
        new D1TournamentReader(this.env.APP_DB),
        new D1TournamentEntries(this.env.APP_DB),
        key,
        accountId,
        { id: () => crypto.randomUUID(), now: Date.now },
      ),
    );
  }
  async status(key: string, accountId: string, controllerId?: string) {
    return tournament.participation(this.ports, this.storage.load(key), accountId, controllerId);
  }
  async entryStatuses(key: string) {
    return this.serial(() => tournament.entryStatuses(this.ports, this.storage.load(key)));
  }
  async enqueue(
    key: string,
    accountId: string,
    operationId: string,
    tokenHash: string,
    controllerId?: string,
  ) {
    return this.serial(() =>
      tournament.enqueue(
        this.ports,
        this.storage.load(key),
        accountId,
        operationId,
        tokenHash,
        controllerId,
      ),
    );
  }
  async heartbeat(
    key: string,
    accountId: string,
    operationId: string,
    controllerId?: string,
    controllerVersion?: number,
  ) {
    return this.serial(() =>
      tournament.heartbeat(
        this.ports,
        this.storage.load(key),
        accountId,
        operationId,
        controllerId,
        controllerVersion,
      ),
    );
  }
  async cancel(
    key: string,
    accountId: string,
    operationId: string,
    controllerId?: string,
    controllerVersion?: number,
  ) {
    return this.serial(() =>
      tournament.cancel(
        this.ports,
        this.storage.load(key),
        accountId,
        operationId,
        controllerId,
        controllerVersion,
      ),
    );
  }
  async claimController(key: string, accountId: string, input: tournament.ControllerClaim) {
    return this.serial(() =>
      tournament.claimController(this.ports, this.storage.load(key), accountId, input),
    );
  }
  async confirm(
    key: string,
    accountId: string,
    operationId: string,
    matchId: string,
    _accept: boolean,
  ): Promise<tournament.Result> {
    return this.serial(() =>
      tournament.confirm(this.ports, this.storage.load(key), accountId, operationId, matchId),
    );
  }

  async purgeAccount(accountId: string) {
    return this.serial(async () => {
      const state = this.storage.current();
      if (state) await tournament.purgeAccount(this.ports, state, accountId);
    });
  }
  async cancelForAccount(accountId: string) {
    return this.serial(async () => {
      const state = this.storage.current();
      if (state) await tournament.cancelForAccount(this.ports, state, accountId);
    });
  }
  async publish(key: string, version: number): Promise<tournament.Result> {
    return this.serial(() => tournament.publish(this.ports, key, version));
  }
  async alarm() {
    await this.serial(async () => {
      const state = this.storage.current();
      if (state) await tournament.tick(this.ports, state);
      else await this.ctx.storage.deleteAlarm();
    });
  }
}
