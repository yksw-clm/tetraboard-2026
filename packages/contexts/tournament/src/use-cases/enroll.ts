import { stage } from "../domain/stage";
import type { TournamentReader, TournamentEntryStore } from "./ports";
export type TournamentResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 409; message: string };
export async function enroll(
  reader: Pick<TournamentReader, "read">,
  store: TournamentEntryStore,
  key: string,
  accountId: string,
  clock: { id(): string; now(): number },
): Promise<TournamentResult> {
  const row = await reader.read(key);
  if (!row || !["upcoming", "active"].includes(stage(row, clock.now())))
    return { ok: false, status: 409, message: "エントリー受付は終了しました。" };
  await store.insert(key, accountId, clock.id(), clock.now());
  return (await store.eligible(accountId, key))
    ? { ok: true }
    : { ok: false, status: 403, message: "プロフィール登録を完了してください。" };
}
