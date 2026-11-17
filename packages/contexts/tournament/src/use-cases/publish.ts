import type { TournamentQueueRuntime } from "./ports";
import { ok, fail } from "../domain/queue";
import type { Result } from "../domain/queue";
export async function publish(
  r: TournamentQueueRuntime,
  key: string,
  version: number,
): Promise<Result> {
  const row = await r.read(key),
    now = r.now();
  if (!row || row.version !== version)
    return fail("別の操作で更新されました。最新データを読み直してください。");
  if (row.published) return fail("この大会はすでに公開されています。");
  if (
    row.starts_at_ms === null ||
    row.ends_at_ms === null ||
    row.starts_at_ms <= now ||
    row.ends_at_ms <= row.starts_at_ms
  )
    return fail("未来の開始日時と、それより後の終了日時を設定してください。", 400);
  const latest = await r.store.latestPublished();
  if (latest?.ends !== null && latest?.ends !== undefined && row.starts_at_ms < latest.ends)
    return fail("公開済みの最新大会の終了日時以降に設定してください。", 400);
  const changed = await r.store.publish(key, version, (latest?.id ?? 0) + 1, now);
  if (!changed) return fail("別の操作で更新されました。最新データを読み直してください。");
  // Initial alarm registration is recoverable by public reads and the scheduled recovery job.
  await r.refresh(key);
  return ok;
}
