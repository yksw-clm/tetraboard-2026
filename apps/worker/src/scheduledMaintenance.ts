import { cleanupLobbyChat } from "./lobby/chatStore";
import { processDeletions } from "./privacy/deletion";
import { archiveAnalytics } from "./analytics/retention";
import { recoverAccountReservations } from "./accounts/roomAccounts";
import { retryPendingMatchClaims } from "./accounts/matchClaims";
import { deleteExpiredReports } from "./rooms/reportStore";
import { cleanupFeedback } from "./feedback/store";
import { deleteUnusedAvatars } from "./accounts/accountRoutes";
import { recoverTournaments } from "./tournaments/routes";

export type MaintenanceTask = { name: string; run: () => Promise<unknown> };

/** 実行順を保ち、ひとつの失敗で他の期限処理や復旧を止めません。 */
export async function runMaintenanceTasks(tasks: readonly MaintenanceTask[]): Promise<void> {
  const failures: string[] = [];
  for (const task of tasks) {
    const startedAt = Date.now();
    let status: "success" | "failed" = "success";
    try {
      await task.run();
    } catch {
      status = "failed";
      failures.push(task.name);
    }
    // 例外の内容には認証値や個人情報が含まれ得るため、固定のジョブ名だけを記録します。
    console.info("Scheduled maintenance", {
      job: task.name,
      status,
      durationMs: Date.now() - startedAt,
    });
  }
  if (failures.length) throw new Error(`Scheduled maintenance failed: ${failures.join(", ")}`);
}

export async function runScheduledMaintenance(env: Env): Promise<void> {
  await runMaintenanceTasks([
    { name: "account-deletions", run: () => processDeletions(env) },
    { name: "lobby-chat", run: () => cleanupLobbyChat(env.APP_DB) },
    { name: "analytics", run: () => archiveAnalytics(env) },
    { name: "feedback", run: () => cleanupFeedback(env) },
    { name: "reports", run: () => deleteExpiredReports(env.APP_DB) },
    { name: "account-reservations", run: () => recoverAccountReservations(env) },
    { name: "tournaments", run: () => recoverTournaments(env) },
    { name: "match-claims", run: () => retryPendingMatchClaims(env.APP_DB) },
    { name: "avatars", run: () => deleteUnusedAvatars(env) },
    { name: "expired-credentials", run: () => deleteExpiredCredentials(env) },
  ]);
}

async function deleteExpiredCredentials(env: Env): Promise<void> {
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM guest_sessions WHERE expires_at_ms<=?").bind(Date.now()),
    env.APP_DB.prepare("DELETE FROM guest_oauth_flows WHERE expires_at_ms<=?").bind(Date.now()),
    env.APP_DB.prepare("DELETE FROM session WHERE expiresAt < ?").bind(Date.now()),
    env.APP_DB.prepare("DELETE FROM verification WHERE expiresAt < ?").bind(Date.now()),
    env.APP_DB.prepare("DELETE FROM deletion_flows WHERE expires_at_ms < ?").bind(Date.now()),
    env.APP_DB.prepare("DELETE FROM oauth_legal_consents WHERE expires_at_ms < ?").bind(Date.now()),
    env.APP_DB.prepare("DELETE FROM registration_oauth_states WHERE expires_at_ms <= ?").bind(
      Date.now(),
    ),
    env.APP_DB.prepare("DELETE FROM deletion_challenges WHERE expires_at_ms < ?").bind(Date.now()),
    env.APP_DB.prepare("DELETE FROM rateLimit WHERE lastRequest < ?").bind(Date.now() - 86400000),
  ]);
}
