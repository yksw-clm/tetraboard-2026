import { guestLinkRoutes } from "./accounts/guestLinking";
import { guestRoutes } from "./accounts/guestAccounts";
import { generalLobbyRoutes } from "./lobby/routes";
import { lobbyChatRoutes } from "./lobby/chatRoutes";
import { cleanupLobbyChat } from "./lobby/chatStore";
import { deletionRoutes } from "./privacy/deletionRoutes";
import { migrateOAuthTokens } from "./privacy/tokens";
import { processDeletions } from "./privacy/deletion";
import { archiveAnalytics } from "./analytics/retention";
import { legalRoutes } from "./privacy/legalRoutes";
import { defaultGameId, gameCatalog } from "@tetraboard/protocol/games";
import { announcementRoutes, announcementAdminRoutes } from "./announcements/routes";
import { adminRoutes } from "./admin/routes";
import { adminIdentity, type AdminEnv } from "./admin/auth";
import { analyticsRoutes } from "./analytics/routes";
import { healthzContract } from "@tetraboard/protocol";
import { accountRoutes, deleteUnusedAvatars } from "./accounts/accountRoutes";
import { withAccountSessionCookies } from "./accounts/auth";
import { recoverAccountReservations } from "./accounts/roomAccounts";
import { registrationRoutes } from "./accounts/registrationRoutes";
import { retryPendingMatchClaims } from "./accounts/matchClaims";
import { publicMatchRoutes } from "./rooms/publicMatchRoutes";
import { matchRoutes } from "./accounts/matchRoutes";
import { playerProfileRoutes } from "./accounts/playerProfileRoutes";
import { statsRoutes } from "./accounts/statsRoutes";
import { badgeNotificationRoutes } from "./accounts/badgeNotificationRoutes";
import { formationStatsRoutes } from "./accounts/formationStatsRoutes";
import { rankingRoutes } from "./rooms/rankingRoutes";
import { Hono } from "hono";
import { roomRoutes } from "./rooms/roomRoutes";
import { deleteExpiredReports } from "./rooms/reportStore";
import { feedbackRoutes, feedbackAdminRoutes } from "./feedback/routes";
import { cleanupFeedback } from "./feedback/store";
import { servePublicAssets } from "./publicAssets";
import { fourShogiAiRoutes } from "./fourShogiAi/routes";
import { tournamentRoutes, tournamentAdminRoutes, recoverTournaments } from "./tournaments/routes";

export { GameRoom } from "./rooms/gameRoom";
export { TournamentCoordinator } from "./tournaments/coordinator";

const api = new Hono<{ Bindings: Env }>();

api.on(healthzContract.method, healthzContract.path, (context) => {
  context.header("Cache-Control", "no-store");
  const response = healthzContract.response.parse({ status: "ok" });
  return context.json(response);
});

api.route("/", generalLobbyRoutes);
api.route("/", tournamentRoutes);
api.route("/", tournamentAdminRoutes);
api.route("/", lobbyChatRoutes);
api.route("/", adminRoutes);
api.route("/", announcementRoutes);
api.route("/", announcementAdminRoutes);
api.route("/", feedbackAdminRoutes);
api.route("/", feedbackRoutes);
api.route("/", analyticsRoutes);
api.route("/", matchRoutes);
api.route("/", fourShogiAiRoutes);
api.route("/", publicMatchRoutes);
api.route("/", statsRoutes);
api.route("/", badgeNotificationRoutes);
api.route("/", formationStatsRoutes);
api.route("/", playerProfileRoutes);
api.route("/", rankingRoutes);
api.route("/", deletionRoutes);
api.route("/", legalRoutes);
api.route("/", registrationRoutes);
api.route("/", guestRoutes);
api.route("/", guestLinkRoutes);
api.route("/", accountRoutes);
api.route("/", roomRoutes);

// 本番の同一オリジン配信と、既存のWorker直接アクセスを両方扱います。
const app = new Hono<{ Bindings: Env }>().route("/api", api).route("/", api);

app.notFound((context) => context.text("Not Found", 404));

const worker = {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (
      env.APP_ORIGIN === "https://tetraboard.net" &&
      (url.hostname === "tetraboard-2026.chaossi-lab.workers.dev" ||
        (url.hostname === "tetraboard.net" && url.protocol === "http:"))
    )
      return Response.redirect(`${env.APP_ORIGIN}${url.pathname}${url.search}`, 308);
    // 画面・画像はアセットへ渡し、APIだけをHonoで処理します。
    if (env.ASSETS && url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
      let assetPath: string;
      try {
        const decoded = decodeURIComponent(url.pathname)
          .replace(/\\/g, "/")
          .replace(/\/{2,}/g, "/");
        assetPath = new URL(decoded, "https://assets.invalid").pathname;
      } catch {
        return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
      }
      if (assetPath === "/admin" || assetPath.startsWith("/admin/")) {
        const identity = await adminIdentity(request, env as AdminEnv);
        if (identity.status === 401)
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${env.APP_ORIGIN}/login?destination=admin`,
              "Cache-Control": "no-store",
            },
          });
        if (identity.status !== 200)
          return new Response(identity.message, {
            status: identity.status,
            headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
          });
        const assetUrl = new URL(request.url);
        assetUrl.pathname = assetPath.startsWith("/admin/assets/")
          ? assetPath
          : "/admin/index.html";
        const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
        const headers = new Headers(asset.headers);
        headers.set("Cache-Control", "no-store");
        headers.set("X-Robots-Tag", "noindex, nofollow");
        return new Response(asset.body, { status: asset.status, headers });
      }
      if (url.pathname === "/profile")
        return Response.redirect(new URL("/account", request.url).toString(), 302);
      if (/^\/games\/game-[^/]+$/.test(url.pathname) || url.pathname === "/guest/name")
        return Response.redirect(
          new URL(gameCatalog[defaultGameId].lobbyPath, request.url).toString(),
          302,
        );
      return servePublicAssets(request, env.ASSETS, assetPath, env);
    }
    return app.fetch(request, env, context);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await migrateOAuthTokens(env);
    await processDeletions(env);
    await cleanupLobbyChat(env.APP_DB);
    await archiveAnalytics(env);
    await cleanupFeedback(env);
    await deleteExpiredReports(env.APP_DB);
    await recoverAccountReservations(env);
    await recoverTournaments(env);
    await retryPendingMatchClaims(env.APP_DB);
    await deleteUnusedAvatars(env);
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM guest_sessions WHERE expires_at_ms<=?").bind(Date.now()),
      env.APP_DB.prepare("DELETE FROM guest_oauth_flows WHERE expires_at_ms<=?").bind(Date.now()),
      env.APP_DB.prepare("DELETE FROM session WHERE expiresAt < ?").bind(Date.now()),
      env.APP_DB.prepare("DELETE FROM verification WHERE expiresAt < ?").bind(Date.now()),
      env.APP_DB.prepare("DELETE FROM deletion_flows WHERE expires_at_ms < ?").bind(Date.now()),
      env.APP_DB.prepare("DELETE FROM oauth_legal_consents WHERE expires_at_ms < ?").bind(
        Date.now(),
      ),
      env.APP_DB.prepare("DELETE FROM registration_oauth_states WHERE expires_at_ms <= ?").bind(
        Date.now(),
      ),
      env.APP_DB.prepare("DELETE FROM deletion_challenges WHERE expires_at_ms < ?").bind(
        Date.now(),
      ),
      env.APP_DB.prepare("DELETE FROM rateLimit WHERE lastRequest < ?").bind(Date.now() - 86400000),
    ]);
  },
};

export default {
  ...worker,
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const response = await withAccountSessionCookies(request, () =>
      worker.fetch(request, env, context),
    );
    if (
      env.APP_ORIGIN !== "https://tetraboard-dev.chaossi-lab.workers.dev" ||
      response.status === 101
    )
      return response;
    const result = new Response(response.body, response);
    result.headers.set("X-Robots-Tag", "noindex, nofollow");
    return result;
  },
};
