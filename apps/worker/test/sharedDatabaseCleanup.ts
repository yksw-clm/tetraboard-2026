import { env } from "cloudflare:workers";

export async function cleanupSharedDatabase(): Promise<void> {
  // 退会済みの判定は残し、次のテストの退会処理が未完了ジョブを拾うのを防ぎます。
  await env.APP_DB.batch([
    env.APP_DB.prepare(
      "UPDATE deleted_accounts SET completed_at_ms=? WHERE completed_at_ms IS NULL",
    ).bind(Date.now()),
    env.APP_DB.prepare("DELETE FROM deletion_rooms"),
    env.APP_DB.prepare("DELETE FROM room_index"),
  ]);
}
