import { Hono, type MiddlewareHandler } from "hono";
import {
  profileInputSchema,
  tournamentIdSchema,
  tournamentInputSchema,
  tournamentPatchSchema,
  tournamentPublishSchema,
  tournamentQueueInputSchema,
  tournamentOperationSchema,
  tournamentConfirmationSchema,
  tournamentControllerInputSchema,
} from "@tetraboard/protocol";
import { accountIdentity, profileAvatarUrl, type StoredProfile } from "../accounts/auth";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { consentStatement } from "../privacy/consent";
import { adminIdentity } from "../admin/auth";
import { readLimitedBody } from "../feedback/images";
import {
  adminList,
  allStandings,
  createDraft,
  cursorOffset,
  nextOffset,
  publicSummary,
  publicTournament,
  readTournament,
  record,
  standingsPage,
  updateDraft,
  type TournamentRow,
} from "./store";

type Variables = { tournament: TournamentRow; user: StoredProfile };
export const tournamentRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
export const tournamentAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
const noStore: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
};
for (const routes of [tournamentRoutes, tournamentAdminRoutes]) {
  routes.use("*", noStore);
  routes.onError((_error, c) =>
    c.json({ message: "処理できませんでした。時間をおいて再試行してください。" }, 503),
  );
}
async function json(request: Request) {
  const bytes = await readLimitedBody(request, 32768);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}
tournamentAdminRoutes.use("/admin/tournaments*", async (c, next) => {
  if (!["GET", "HEAD"].includes(c.req.method) && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const identity = await adminIdentity(c.req.raw, c.env);
  if (identity.status !== 200) return c.json({ message: identity.message }, identity.status);
  await next();
});
tournamentAdminRoutes.get("/admin/tournaments", async (c) => {
  const offset = cursorOffset(c.req.query("cursor"));
  return offset === null
    ? c.json({ message: "検索条件が正しくありません。" }, 400)
    : c.json(await adminList(c.env.APP_DB, offset));
});
tournamentAdminRoutes.post("/admin/tournaments", async (c) => {
  const input = tournamentInputSchema.safeParse(await json(c.req.raw));
  if (!input.success) return c.json({ message: "入力内容を確認してください。" }, 400);
  const key = await createDraft(c.env.APP_DB, input.data),
    row = await readTournament(c.env.APP_DB, key);
  return c.json(await record(c.env.APP_DB, row!), 201);
});
tournamentAdminRoutes.get("/admin/tournaments/:key", async (c) => {
  const row = await readTournament(c.env.APP_DB, c.req.param("key"));
  return row ? c.json(await record(c.env.APP_DB, row)) : c.notFound();
});
tournamentAdminRoutes.patch("/admin/tournaments/:key", async (c) => {
  const parsed = tournamentPatchSchema.safeParse(await json(c.req.raw));
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
  if (!(await updateDraft(c.env.APP_DB, row.key, input.data, version)))
    return c.json({ message: "別の操作で更新されました。最新データを読み直してください。" }, 409);
  return c.json(await record(c.env.APP_DB, (await readTournament(c.env.APP_DB, row.key))!));
});
tournamentAdminRoutes.post("/admin/tournaments/:key/publish", async (c) => {
  const input = tournamentPublishSchema.safeParse(await json(c.req.raw));
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
tournamentAdminRoutes.get("/admin/tournaments/:key/entries", async (c) => {
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
  const query = `FROM tournament_entries e JOIN user u ON u.id=e.account_id WHERE e.tournament_key=? AND e.deleted=0
    AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)
    AND (?='' OR instr(lower(u.name),lower(?))>0 OR instr(lower(u.username),lower(?))>0)`;
  const [rows, total] = await Promise.all([
    c.env.APP_DB.prepare(
      `SELECT e.id,e.account_id,e.entered_at_ms,u.name,u.username,u.avatarKey ${query} ORDER BY e.entered_at_ms,e.id LIMIT 51 OFFSET ?`,
    )
      .bind(row.key, search, search, search, offset)
      .all<{
        id: string;
        account_id: string;
        entered_at_ms: number;
        name: string;
        username: string;
        avatarKey: string | null;
      }>(),
    c.env.APP_DB.prepare(`SELECT COUNT(*) AS n ${query}`)
      .bind(row.key, search, search, search)
      .first<{ n: number }>(),
  ]);
  return c.json({
    entries: rows.results.slice(0, 50).map((e) => ({
      name: e.name,
      username: e.username,
      avatarUrl: profileAvatarUrl(e.avatarKey),
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
function recoverAfterRead(env: Env, context: Pick<ExecutionContext, "waitUntil">, key: string) {
  context.waitUntil(
    env.TOURNAMENT_COORDINATOR.getByName(key)
      .refresh(key)
      .catch(() => {
        console.error("Tournament recovery will be retried");
      }),
  );
}
tournamentRoutes.get("/tournaments/lobby", async (c) => {
  // 終了時の復旧が遅れていても、公開情報の取得を待たせません。
  const overdue = await c.env.APP_DB.prepare(
    "SELECT key FROM tournaments WHERE published=1 AND finalized_at_ms IS NULL AND ends_at_ms<=? ORDER BY public_id LIMIT 20",
  )
    .bind(Date.now())
    .all<{ key: string }>();
  for (const t of overdue.results) recoverAfterRead(c.env, c.executionCtx, t.key);
  const now = Date.now();
  const row = await c.env.APP_DB.prepare(`SELECT * FROM tournaments WHERE published=1 ORDER BY
    CASE WHEN finalized_at_ms IS NULL AND starts_at_ms<=? AND ends_at_ms>? THEN 0
      WHEN finalized_at_ms IS NULL AND ends_at_ms<=? THEN 1 WHEN starts_at_ms>? THEN 2 ELSE 3 END,
    CASE WHEN starts_at_ms>? THEN starts_at_ms END ASC,public_id DESC LIMIT 1`)
    .bind(now, now, now, now, now)
    .first<TournamentRow>();
  return c.json({ tournament: row ? await publicSummary(c.env.APP_DB, row) : null });
});
tournamentRoutes.use("/tournaments/:id/*", async (c, next) => {
  const id = tournamentIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.notFound();
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
  const next = await c.env.APP_DB.prepare(
    "SELECT * FROM tournaments WHERE published=1 AND public_id>? AND starts_at_ms>=? ORDER BY public_id LIMIT 1",
  )
    .bind(row.public_id, row.ends_at_ms)
    .first<TournamentRow>();
  return c.json({
    tournament: await publicSummary(c.env.APP_DB, row),
    ...(await standingsPage(c.env.APP_DB, row, user?.id)),
    nextTournament: next ? await publicSummary(c.env.APP_DB, next) : null,
  });
});
tournamentRoutes.get("/tournaments/:id/standings", async (c) => {
  const row = c.get("tournament"),
    offset = cursorOffset(c.req.query("cursor"));
  if (offset === null) return c.json({ message: "検索条件が正しくありません。" }, 400);
  const user = await accountIdentity(c.req.raw, c.env);
  return c.json(
    await standingsPage(c.env.APP_DB, row, user?.id, c.req.query("all") === "1", offset),
  );
});
const member: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user) return c.json({ message: "ログインしてください。" }, 401);
  if (!user.profileCompleted || !profileInputSchema.safeParse(user).success)
    return c.json({ message: "プロフィール登録を完了してください。" }, 403);
  if (c.req.method === "POST") {
    if (c.req.header("X-Legal-Consent") !== legalVersion)
      return c.json({ message: "利用規約と年齢条件を確認してください。" }, 403);
    await consentStatement(c.env.APP_DB, user.id).run();
  }
  c.set("user", user);
  await next();
};
tournamentRoutes.get("/tournaments/:id/participation", member, async (c) => {
  const row = c.get("tournament");
  const header = c.req.header("X-Tournament-Controller");
  if (
    header !== undefined &&
    !tournamentOperationSchema.shape.controllerId.safeParse(header).success
  )
    return c.json({ message: "操作元を確認できません。" }, 400);
  return c.json(
    await c.env.TOURNAMENT_COORDINATOR.getByName(row.key).status(row.key, c.get("user").id, header),
  );
});
tournamentRoutes.post("/tournaments/:id/entries", member, async (c) => {
  const row = c.get("tournament"),
    result = await c.env.TOURNAMENT_COORDINATOR.getByName(row.key).enroll(
      row.key,
      c.get("user").id,
    );
  return result.ok ? c.json({ entered: true }) : c.json({ message: result.message }, result.status);
});
tournamentRoutes.post("/tournaments/:id/queue", member, async (c) => {
  const input = tournamentQueueInputSchema.safeParse(await json(c.req.raw));
  if (!input.success) return c.json({ message: "入力内容を確認してください。" }, 400);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.data.token));
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  const row = c.get("tournament"),
    result = await c.env.TOURNAMENT_COORDINATOR.getByName(row.key).enqueue(
      row.key,
      c.get("user").id,
      input.data.operationId,
      hash,
      input.data.controllerId,
    );
  return result.ok ? c.json({ ok: true }) : c.json({ message: result.message }, result.status);
});
for (const method of ["patch", "delete"] as const)
  tournamentRoutes[method]("/tournaments/:id/queue", member, async (c) => {
    const input = tournamentOperationSchema.safeParse(await json(c.req.raw));
    if (!input.success) return c.json({ message: "入力内容を確認してください。" }, 400);
    const row = c.get("tournament"),
      coordinator = c.env.TOURNAMENT_COORDINATOR.getByName(row.key);
    const result =
      method === "patch"
        ? await coordinator.heartbeat(
            row.key,
            c.get("user").id,
            input.data.operationId,
            input.data.controllerId,
            input.data.controllerVersion,
          )
        : await coordinator.cancel(
            row.key,
            c.get("user").id,
            input.data.operationId,
            input.data.controllerId,
            input.data.controllerVersion,
          );
    return result.ok ? c.json({ ok: true }) : c.json({ message: result.message }, result.status);
  });
tournamentRoutes.post("/tournaments/:id/controller", member, async (c) => {
  c.header("Cache-Control", "private, no-store");
  const input = tournamentControllerInputSchema.safeParse(await json(c.req.raw));
  if (!input.success) return c.json({ message: "入力内容を確認してください。" }, 400);
  const row = c.get("tournament");
  const result = await c.env.TOURNAMENT_COORDINATOR.getByName(row.key).claimController(
    row.key,
    c.get("user").id,
    input.data,
  );
  return result.ok && "token" in result
    ? c.json({ participation: result.participation, token: result.token })
    : !result.ok
      ? c.json({ message: result.message }, result.status)
      : c.json({ message: "参加資格を復旧できませんでした。" }, 409);
});
tournamentRoutes.post("/tournaments/:id/confirmation", member, async (c) => {
  const input = tournamentConfirmationSchema.safeParse(await json(c.req.raw));
  if (!input.success) return c.json({ message: "入力内容を確認してください。" }, 400);
  const row = c.get("tournament"),
    result = await c.env.TOURNAMENT_COORDINATOR.getByName(row.key).confirm(
      row.key,
      c.get("user").id,
      input.data.operationId,
      input.data.matchId,
      input.data.accept,
    );
  return result.ok ? c.json({ ok: true }) : c.json({ message: result.message }, result.status);
});

export async function recoverTournaments(env: Env) {
  await env.APP_DB.prepare(
    "DELETE FROM tournament_wait_reservations WHERE lease_until_ms<=? AND match_operation_id IS NULL",
  )
    .bind(Date.now())
    .run();
  const rows = await env.APP_DB.prepare(
    "SELECT key FROM tournaments WHERE published=1 AND finalized_at_ms IS NULL ORDER BY public_id LIMIT 100",
  ).all<{ key: string }>();
  for (const row of rows.results)
    await env.TOURNAMENT_COORDINATOR.getByName(row.key).refresh(row.key);
}
