import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { readStoredMatch } from "../../accounts/matchDataContracts";
import { retryPendingMatchClaims } from "../../accounts/matchClaims";
import type { GuestRegistrationInput } from "../../rooms/registrationTypes";
export const guestClaimsKey = "guest-match-claims-pending";
export type PendingGuestClaims = { generation: string; retryAtMs: number };

export async function runGuestClaims(runtime: RoomRuntime) {
  const code = runtime.ctx.id.name!;
  await retryPendingMatchClaims(runtime.db, code);
  return Boolean(
    await runtime.db
      .prepare(
        "SELECT 1 FROM match_participant_accounts WHERE room_id=? AND state='pending' LIMIT 1",
      )
      .bind(code)
      .first(),
  );
}

export async function guestMergeConflict(
  runtime: RoomRuntime,
  guestId: string,
  accountId: string,
): Promise<boolean> {
  const includesBoth = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(includesBoth);
    const row = value as Record<string, unknown>;
    if (Array.isArray(row.participants)) {
      const ids = new Set(
        row.participants.map((player: { accountId?: string }) => player?.accountId),
      );
      if (ids.has(guestId) && ids.has(accountId)) return true;
    }
    return Object.values(row).some(includesBoth);
  };
  // 保存待ちの記録も確認し、D1へまだ届いていない同局の複数席取得を防ぎます。
  for (const [, value] of runtime.ctx.storage.kv.list()) if (includesBoth(value)) return true;
  return false;
}

export async function originalMatchAccounts(
  runtime: RoomRuntime,
  input: GuestRegistrationInput,
): Promise<string[] | null> {
  const pending = [
    ...runtime.pendingMatches().values(),
    ...runtime.pendingShogiMatches().values(),
  ].find((job) => job.record.id === input.matchId)?.record;
  let record = pending;
  if (!record) {
    await runtime.syncAlarm();
    const saved = await runtime.db
      .prepare("SELECT game,record_json FROM matches WHERE id=?")
      .bind(input.matchId)
      .first<{ game: string; record_json: string }>();
    if (saved) record = readStoredMatch(saved.record_json, saved.game).record;
  }
  if (!record || record.instanceId !== input.instanceId || record.roomId !== runtime.ctx.id.name)
    return null;
  return record.participants.flatMap((player) =>
    player.kind === "human" && player.accountId ? [player.accountId] : [],
  );
}

export async function armGuestMatchClaims(runtime: RoomRuntime): Promise<void> {
  runtime.ctx.storage.kv.put(guestClaimsKey, {
    generation: crypto.randomUUID(),
    retryAtMs: Date.now(),
  } satisfies PendingGuestClaims);
  runtime.markAlarm();
  runtime.ctx.waitUntil(runtime.flushGuestClaims());
}

export function finishGuestClaims(
  runtime: RoomRuntime,
  job: PendingGuestClaims,
  retryAtMs: number | null,
) {
  runtime.ctx.storage.transactionSync(() => {
    const latest = runtime.ctx.storage.kv.get<PendingGuestClaims>(guestClaimsKey);
    if (latest?.generation !== job.generation) return;
    if (retryAtMs !== null) runtime.ctx.storage.kv.put(guestClaimsKey, { ...job, retryAtMs });
    else runtime.ctx.storage.kv.delete(guestClaimsKey);
  });
}
