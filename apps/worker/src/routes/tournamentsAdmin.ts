import type { Hono, MiddlewareHandler } from "hono";
import {
  tournamentInputSchema,
  tournamentPatchSchema,
  tournamentPublishSchema,
} from "@tetraboard/protocol";
import { accountAvatarUrl } from "../adapters/account/auth";
import { adminIdentity } from "../admin/auth";
import { readTournamentEntries } from "../adapters/tournament/queries";
import {
  adminList,
  allStandings,
  createDraft,
  cursorOffset,
  nextOffset,
  readTournament,
  record,
  updateDraft,
  settingsForTournament,
} from "../adapters/tournament/store";
import { readTournamentJson, type TournamentRouteEnv } from "./tournamentRouteSupport";

const requireTournamentAdmin: MiddlewareHandler<TournamentRouteEnv> = async (c, next) => {
  if (!["GET", "HEAD"].includes(c.req.method) && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const identity = await adminIdentity(c.req.raw, c.env);
  if (identity.status !== 200) return c.json({ message: identity.message }, identity.status);
  await next();
};

export function registerTournamentAdminRoutes(routes: Hono<TournamentRouteEnv>) {
  routes.use("/admin/tournaments*", requireTournamentAdmin);
  routes.get("/admin/tournaments", async (c) => {
    const offset = cursorOffset(c.req.query("cursor"));
    return offset === null
      ? c.json({ message: "検索条件が正しくありません。" }, 400)
      : c.json(await adminList(c.env.APP_DB, offset));
  });
  routes.post("/admin/tournaments", async (c) => {
    const input = tournamentInputSchema.safeParse(await readTournamentJson(c.req.raw));
    if (!input.success) return c.json({ message: "入力内容を確認してください。" }, 400);
    const key = await createDraft(c.env.APP_DB, input.data),
      row = await readTournament(c.env.APP_DB, key);
    return c.json(await record(c.env.APP_DB, row!), 201);
  });
  routes.get("/admin/tournaments/:key", async (c) => {
    const row = await readTournament(c.env.APP_DB, c.req.param("key"));
    return row ? c.json(await record(c.env.APP_DB, row)) : c.notFound();
  });
  routes.patch("/admin/tournaments/:key", async (c) => {
    const parsed = tournamentPatchSchema.safeParse(await readTournamentJson(c.req.raw));
    if (!parsed.success) return c.json({ message: "入力内容を確認してください。" }, 400);
    const { version, ...fields } = parsed.data,
      input = tournamentInputSchema.safeParse(fields);
    if (!input.success) return c.json({ message: "終了日時は開始日時より後にしてください。" }, 400);
    const row = await readTournament(c.env.APP_DB, c.req.param("key"));
    if (!row) return c.notFound();
    if (
      row.published &&
      (row.starts_at_ms !== input.data.startsAtMs || row.ends_at_ms !== input.data.endsAtMs)
    )
      return c.json({ message: "公開後の開催日時は変更できません。" }, 400);
    if (
      row.published &&
      JSON.stringify(settingsForTournament(row)) !== JSON.stringify(input.data.settings)
    )
      return c.json({ message: "公開後のゲームと対局ルールは変更できません。" }, 400);
    if (!(await updateDraft(c.env.APP_DB, row.key, input.data, version)))
      return c.json({ message: "別の操作で更新されました。最新データを読み直してください。" }, 409);
    return c.json(await record(c.env.APP_DB, (await readTournament(c.env.APP_DB, row.key))!));
  });
  routes.post("/admin/tournaments/:key/publish", async (c) => {
    const input = tournamentPublishSchema.safeParse(await readTournamentJson(c.req.raw));
    if (!input.success) return c.json({ message: "入力内容を確認してください。" }, 400);
    const row = await readTournament(c.env.APP_DB, c.req.param("key"));
    if (!row) return c.notFound();
    const result = await (c.env as Env).TOURNAMENT_COORDINATOR.getByName("publication").publish(
      row.key,
      input.data.version,
    );
    return result.ok
      ? c.json(await record(c.env.APP_DB, (await readTournament(c.env.APP_DB, row.key))!))
      : c.json({ message: result.message }, result.status);
  });
  registerTournamentAdminEntriesRoute(routes);
}

function registerTournamentAdminEntriesRoute(routes: Hono<TournamentRouteEnv>) {
  routes.get("/admin/tournaments/:key/entries", async (c) => {
    const row = await readTournament(c.env.APP_DB, c.req.param("key"));
    if (!row) return c.notFound();
    const offset = cursorOffset(c.req.query("cursor")),
      search = c.req.query("search")?.trim().replace(/^@/, "") ?? "";
    if (offset === null || Array.from(search).length > 80)
      return c.json({ message: "検索条件が正しくありません。" }, 400);
    const statuses = await (c.env as Env).TOURNAMENT_COORDINATOR.getByName(row.key).entryStatuses(
      row.key,
    );
    const scores = await allStandings(c.env.APP_DB, row),
      byId = new Map(scores.map((s) => [s.entryId, s]));
    const [rows, total] = await readTournamentEntries(c.env.APP_DB, row.key, search, offset);
    return c.json({
      entries: rows.results.slice(0, 50).map((e) => ({
        name: e.name,
        ...(e.isAnonymous ? { isGuest: true } : {}),
        username: e.username,
        avatarUrl: accountAvatarUrl({
          id: e.account_id,
          avatarKey: e.avatarKey,
          avatarPresetId: e.avatarPresetId,
        }),
        enteredAtMs: e.entered_at_ms,
        status: statuses[e.account_id] ?? "idle",
        games: byId.get(e.id)?.games ?? 0,
        pointsUnits: byId.get(e.id)?.pointsUnits ?? 0,
        knockouts: byId.get(e.id)?.knockouts ?? 0,
        rank: byId.get(e.id)?.rank ?? null,
      })),
      total: total!.n,
      nextCursor: rows.results.length > 50 ? nextOffset(offset + 50) : null,
    });
  });
}
