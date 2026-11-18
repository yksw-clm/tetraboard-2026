import type { AccountAdmission } from "./types";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { cancelledAdmissionKey } from "../../durableObjects/gameRoom/storageKeys";

export async function withAccountAdmission<T>(
  runtime: RoomRuntime,
  admission: AccountAdmission | undefined,
  action: () => T,
): Promise<T | null> {
  if (!admission) return action();
  const outcome = await runtime.ctx.blockConcurrencyWhile(async () => {
    try {
      if (runtime.ctx.storage.kv.get(cancelledAdmissionKey(admission.operationId)))
        return { ok: true as const, value: null };
      await runtime.alarms.sync();
      const reservation = await runtime.db
        .prepare(`SELECT operation_id FROM account_room_seats
        WHERE account_id = ? AND operation_id = ? AND room_id = ? AND instance_id = ? AND player_id = ? AND name = ? AND avatar_key IS ? AND avatar_preset_id IS ? AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id=account_room_seats.account_id)`)
        .bind(
          admission.accountId,
          admission.operationId,
          runtime.ctx.id.name,
          admission.instanceId,
          admission.playerId,
          admission.name,
          admission.avatarKey,
          admission.avatarPresetId ?? null,
        )
        .first();
      if (!reservation) return { ok: true as const, value: null };
      return { ok: true as const, value: action() };
    } catch (error) {
      // Expected admission rejection must not break the DO input gate.
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : "Account admission failed",
      };
    }
  });
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.value;
}
