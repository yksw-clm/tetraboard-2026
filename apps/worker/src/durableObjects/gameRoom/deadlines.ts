import * as roomUseCases from "@tetraboard/context-room";
import { recoverPlayingCpuCapacity } from "../../adapters/room/cpuCapacity";
import { readRoom } from "../../adapters/room/state";
import { withIndexTransaction } from "../../adapters/room/transaction";
import { invokeRoomUseCase } from "../../adapters/room/useCases";
import { purgeAccount } from "../../flows/accountPurge/purge";
import { advanceMatchmakingStart } from "../../flows/matchmakingRoom/start";
import { advanceTournamentStart } from "../../flows/tournamentRoom/start";
import type { ExternalCpuRequest } from "../../rooms/gameAdapters/cpuTypes";
import type { RoomRuntime } from "./runtime";

export async function reconcileDeadlines(runtime: RoomRuntime, applyCpu = false): Promise<void> {
  await purgeDeletedAccounts(runtime);
  if (applyCpu) {
    await runtime.jobs.cpuCapacityJob.flush();
    await recoverPlayingCpuCapacity(runtime);
  }
  const initial = readRoom(runtime);
  const now = Date.now();
  const result = withIndexTransaction(
    runtime,
    () =>
      invokeRoomUseCase(
        runtime,
        (op) => roomUseCases.processDeadlines(op, initial, applyCpu),
        undefined,
        now,
      ),
    initial,
    (outcome) => outcome.room,
  );
  result.afterTransaction?.();

  runtime.ctx.waitUntil(runtime.jobs.roomIndexJob.flush());
  runtime.ctx.waitUntil(runtime.jobs.accountCleanupJob.flush());
  runtime.ctx.waitUntil(runtime.jobs.tournamentStateJob.flush());
  if (!initial || runtime.gameAdapter(initial).cpu.waitUntilMatchFlush)
    runtime.ctx.waitUntil(runtime.jobs.matchJob.flush());
  runtime.ctx.waitUntil(runtime.jobs.guestClaimsJob.flush());
  runtime.effects.publish(result.notifications);
  await advanceTournamentStart(runtime, result.room);
  await advanceMatchmakingStart(runtime);
  const external = result.external as ExternalCpuRequest | undefined;
  if (external) {
    // transactionとDOの入力ゲートを保持せず、ネットワーク応答を待ちます。
    await runtime.alarms.sync();
    const response = await external.request();
    await runtime.reconcileDeadlines();
    runtime.ctx.storage.transactionSync(() => {
      response.apply(readRoom(runtime), Date.now());
    });
    response.afterTransaction?.();
    runtime.alarms.mark();
  }
}

async function purgeDeletedAccounts(runtime: RoomRuntime) {
  const code = runtime.ctx.id.name ?? readRoom(runtime)?.id;
  if (code) {
    await runtime.alarms.sync();
    const pending = await runtime.accountBindings.APP_DB.prepare(
      "SELECT account_id FROM deletion_rooms WHERE room_id=?",
    )
      .bind(code)
      .all<{ account_id: string }>();
    for (const row of pending.results) {
      await purgeAccount(runtime, row.account_id);
      await runtime.accountBindings.APP_DB.prepare(
        "DELETE FROM deletion_rooms WHERE room_id=? AND account_id=?",
      )
        .bind(code, row.account_id)
        .run();
    }
  }
}
