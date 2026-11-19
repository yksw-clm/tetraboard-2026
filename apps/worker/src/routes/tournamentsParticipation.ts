import type { Hono, MiddlewareHandler } from "hono";
import {
  profileInputSchema,
  tournamentQueueInputSchema,
  tournamentOperationSchema,
  tournamentConfirmationSchema,
  tournamentControllerInputSchema,
} from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountIdentity } from "../adapters/account/auth";
import { consentStatement } from "../adapters/privacy/consent";
import { readTournamentJson, type TournamentRouteEnv } from "./tournamentRouteSupport";

const member: MiddlewareHandler<TournamentRouteEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user) return c.json({ message: "ログインしてください。" }, 401);
  if (
    !user.profileCompleted ||
    !(user.isAnonymous ? user.guestNameCustomized : profileInputSchema.safeParse(user).success)
  )
    return c.json({ message: "プロフィール登録を完了してください。" }, 403);
  if (c.req.method === "POST") {
    if (c.req.header("X-Legal-Consent") !== legalVersion)
      return c.json({ message: "利用規約と年齢条件を確認してください。" }, 403);
    await consentStatement(c.env.APP_DB, user.id).run();
  }
  c.set("user", user);
  await next();
};

export function registerTournamentParticipationRoutes(routes: Hono<TournamentRouteEnv>) {
  routes.get("/tournaments/:id/participation", member, async (c) => {
    const row = c.get("tournament");
    const header = c.req.header("X-Tournament-Controller");
    if (
      header !== undefined &&
      !tournamentOperationSchema.shape.controllerId.safeParse(header).success
    )
      return c.json({ message: "操作元を確認できません。" }, 400);
    return c.json(
      await c.env.TOURNAMENT_COORDINATOR.getByName(row.key).status(
        row.key,
        c.get("user").id,
        header,
      ),
    );
  });
  routes.post("/tournaments/:id/entries", member, async (c) => {
    const row = c.get("tournament"),
      result = await c.env.TOURNAMENT_COORDINATOR.getByName(row.key).enroll(
        row.key,
        c.get("user").id,
      );
    return result.ok
      ? c.json({ entered: true })
      : c.json({ message: result.message }, result.status);
  });
  registerTournamentQueueRoutes(routes);
  routes.post("/tournaments/:id/controller", member, async (c) => {
    c.header("Cache-Control", "private, no-store");
    const input = tournamentControllerInputSchema.safeParse(await readTournamentJson(c.req.raw));
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
  routes.post("/tournaments/:id/confirmation", member, async (c) => {
    const input = tournamentConfirmationSchema.safeParse(await readTournamentJson(c.req.raw));
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
}

function registerTournamentQueueRoutes(routes: Hono<TournamentRouteEnv>) {
  routes.post("/tournaments/:id/queue", member, async (c) => {
    const input = tournamentQueueInputSchema.safeParse(await readTournamentJson(c.req.raw));
    if (!input.success) return c.json({ message: "入力内容を確認してください。" }, 400);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(input.data.token),
    );
    const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
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
    routes[method]("/tournaments/:id/queue", member, async (c) => {
      const input = tournamentOperationSchema.safeParse(await readTournamentJson(c.req.raw));
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
}
