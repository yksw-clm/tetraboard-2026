import { Hono, type MiddlewareHandler } from "hono";
import {
  tournamentIdSchema,
  tournamentLobbySectionsQuerySchema,
  tournamentLobbySectionsSchema,
  tournamentRules,
  tournamentListQuerySchema,
  tournamentListSchema,
} from "@tetraboard/protocol";
import { accountIdentity } from "../adapters/account/auth";
import {
  readLobbyTournament,
  readNextTournament,
  readOverdueLobbyTournaments,
} from "../adapters/tournament/queries";
import {
  lobbySections,
  publicTournamentList,
  cursorOffset,
  publicSummary,
  publicTournament,
  standingsPage,
} from "../adapters/tournament/store";
import { canReadTournamentChatAnonymously, chatPageQuery } from "./lobbyChatQuery";
import type { TournamentRouteEnv } from "./tournamentRouteSupport";
import { registerTournamentAdminRoutes } from "./tournamentsAdmin";
import { registerTournamentParticipationRoutes } from "./tournamentsParticipation";

export const tournamentUnavailableMessage =
  "処理できませんでした。時間をおいて再試行してください。";

export const tournamentRoutes = new Hono<TournamentRouteEnv>();
export const tournamentAdminRoutes = new Hono<TournamentRouteEnv>();
const noStore: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
};
for (const routes of [tournamentRoutes, tournamentAdminRoutes]) {
  routes.use("*", noStore);
  routes.onError((_error, c) => c.json({ message: tournamentUnavailableMessage }, 503));
}
registerTournamentAdminRoutes(tournamentAdminRoutes);

function recoverAfterRead(env: Env, context: Pick<ExecutionContext, "waitUntil">, key: string) {
  context.waitUntil(
    env.TOURNAMENT_COORDINATOR.getByName(key)
      .refresh(key)
      .catch(() => {
        console.error("Tournament recovery will be retried");
      }),
  );
}
async function recoverLobbyOverdue(
  env: Env,
  context: Pick<ExecutionContext, "waitUntil">,
  now: number,
) {
  const overdue = await readOverdueLobbyTournaments(env.APP_DB, now);
  for (const tournament of overdue.results) recoverAfterRead(env, context, tournament.key);
}
tournamentRoutes.get("/tournaments", async (c) => {
  const query = tournamentListQuerySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ message: "取得条件が正しくありません。" }, 400);
  return c.json(
    tournamentListSchema.parse(
      await publicTournamentList(c.env.APP_DB, query.data.game, query.data.cursor, Date.now()),
    ),
  );
});
tournamentRoutes.get("/tournaments/lobby", async (c) => {
  const now = Date.now();
  if (c.req.query("view") !== undefined || c.req.query("game") !== undefined) {
    const query = tournamentLobbySectionsQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ message: "取得条件が正しくありません。" }, 400);
    if (query.data.game === tournamentRules.game)
      await recoverLobbyOverdue(c.env, c.executionCtx, now);
    return c.json(
      tournamentLobbySectionsSchema.parse(await lobbySections(c.env.APP_DB, query.data.game, now)),
    );
  }
  // 終了時の復旧が遅れていても、公開情報の取得を待たせません。
  await recoverLobbyOverdue(c.env, c.executionCtx, now);
  const row = await readLobbyTournament(c.env.APP_DB, now);
  return c.json({ tournament: row ? await publicSummary(c.env.APP_DB, row, now) : null });
});
tournamentRoutes.use("/tournaments/:id/*", async (c, next) => {
  const id = tournamentIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.notFound();
  // 本人確認用のCookieがないチャットGETでは、公開確認もチャットのbatchで行います。
  if (
    canReadTournamentChatAnonymously(c.req.path, c.req.raw) &&
    chatPageQuery.safeParse(c.req.query()).success
  ) {
    c.set("readTournamentInChatBatch", true);
    return next();
  }
  const row = await publicTournament(c.env.APP_DB, id.data);
  if (!row) return c.notFound();
  c.set("tournament", row);
  await next();
});
// Hono's wildcard does not match the bare detail path on every router implementation.
tournamentRoutes.get("/tournaments/:id", async (c) => {
  const id = tournamentIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.notFound();
  const row = await publicTournament(c.env.APP_DB, id.data);
  if (!row) return c.notFound();
  if (row.finalized_at_ms === null && row.ends_at_ms! <= Date.now())
    recoverAfterRead(c.env, c.executionCtx, row.key);
  const user = await accountIdentity(c.req.raw, c.env);
  const next = await readNextTournament(c.env.APP_DB, row);
  return c.json({
    tournament: await publicSummary(c.env.APP_DB, row),
    ...(await standingsPage(
      c.env.APP_DB,
      row,
      user?.id,
      false,
      0,
      c.req.query("includeProfiles") === "1",
    )),
    nextTournament: next ? await publicSummary(c.env.APP_DB, next) : null,
  });
});
tournamentRoutes.get("/tournaments/:id/standings", async (c) => {
  const row = c.get("tournament"),
    offset = cursorOffset(c.req.query("cursor"));
  if (offset === null) return c.json({ message: "検索条件が正しくありません。" }, 400);
  const user = await accountIdentity(c.req.raw, c.env);
  return c.json(
    await standingsPage(
      c.env.APP_DB,
      row,
      user?.id,
      c.req.query("all") === "1",
      offset,
      c.req.query("includeProfiles") === "1",
    ),
  );
});
registerTournamentParticipationRoutes(tournamentRoutes);
