import {
  boardProfileRejection,
  postToBoard,
  type BoardDestination,
} from "@tetraboard/context-community";
import {
  boardDetailSchema,
  boardLikeResultSchema,
  boardPostIdSchema,
  boardPostResultSchema,
  boardRepliesSchema,
  boardReplyResultSchema,
  boardTimelineSchema,
} from "@tetraboard/protocol/board";
import { gameIds } from "@tetraboard/protocol/games";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { accountIdentity, type StoredProfile } from "../adapters/account/auth";
import { deleteOwnBoardPost, setBoardLike } from "../adapters/community/boardActions";
import { D1BoardWriter } from "../adapters/community/boardPosting";
import { D1BoardReader } from "../adapters/community/boardReads";
import { digest } from "../crypto";
import { boardRepliesQuery, boardTimelineQuery, readBoardInput } from "./boardInput";

type BoardEnv = { Bindings: Env; Variables: { user: StoredProfile | null } };

export const boardRoutes = new Hono<BoardEnv>();
const identity: MiddlewareHandler<BoardEnv> = async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "GET" && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  c.set("user", await accountIdentity(c.req.raw, c.env));
  await next();
};

const gamePath = "/games/:gameId/posts";
boardRoutes.use(gamePath, identity);
boardRoutes.use("/posts/*", identity);
boardRoutes.onError((_error, c) =>
  c.json({ message: "掲示板を処理できませんでした。もう一度お試しください。" }, 503),
);

const gameSchema = z.enum(gameIds);

function invalidQuery(c: Context<BoardEnv>) {
  return c.json({ message: "取得条件が正しくありません。" }, 400);
}

function hasRepeatedQuery(c: Context<BoardEnv>) {
  return Object.values(c.req.queries()).some((values) => values.length !== 1);
}

boardRoutes.get(gamePath, async (c) => {
  const game = gameSchema.safeParse(c.req.param("gameId"));
  if (!game.success) return c.notFound();
  const query = boardTimelineQuery.safeParse(c.req.query());
  if (!query.success || hasRepeatedQuery(c)) return invalidQuery(c);
  const { limit, before } = query.data;
  const page = await new D1BoardReader(c.env.APP_DB).timeline(
    game.data,
    c.get("user")?.id ?? null,
    limit,
    before,
  );
  return c.json(boardTimelineSchema.parse(page));
});

boardRoutes.get("/posts/:id", async (c) => {
  const id = boardPostIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.notFound();
  const page = await new D1BoardReader(c.env.APP_DB).detail(id.data, c.get("user")?.id ?? null);
  return page ? c.json(boardDetailSchema.parse(page)) : c.notFound();
});

boardRoutes.get("/posts/:id/replies", async (c) => {
  const id = boardPostIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.notFound();
  const query = boardRepliesQuery.safeParse(c.req.query());
  if (!query.success || hasRepeatedQuery(c)) return invalidQuery(c);
  const page = await new D1BoardReader(c.env.APP_DB).replies(
    id.data,
    c.get("user")?.id ?? null,
    query.data.after,
  );
  return page ? c.json(boardRepliesSchema.parse(page)) : c.notFound();
});

function loginRequired(c: Context<BoardEnv>) {
  return c.json({ message: "ログインしてください。" }, 401);
}

function profileRejection(c: Context<BoardEnv>, user: StoredProfile) {
  switch (boardProfileRejection(user)) {
    case "guest":
      return c.json({ message: "掲示板の投稿やいいねにはアカウント登録が必要です。" }, 403);
    case "profileIncomplete":
      return c.json({ message: "プロフィールの初回設定を完了してください。" }, 403);
    case null:
      return null;
  }
}

function ineligible(c: Context<BoardEnv>) {
  return c.json({ message: "掲示板を利用できるアカウントでログインしてください。" }, 403);
}

async function submitPost(c: Context<BoardEnv>, destination: BoardDestination) {
  const user = c.get("user");
  if (!user) return loginRequired(c);
  const rejected = profileRejection(c, user);
  if (rejected) return rejected;
  const body = await readBoardInput(c.req.raw, c.env.APP_ORIGIN);
  if (body.status === "invalidBody")
    return c.json({ message: "本文は1,000文字以内で入力してください。" }, 400);
  if (body.status === "invalidLink")
    return c.json({ message: "URLはTetraBoard内の公開棋譜、大会、ルームのみ投稿できます。" }, 400);

  const result = await postToBoard(
    new D1BoardWriter(c.env.APP_DB),
    { ...destination, ...body.input, accountId: user.id },
    Date.now,
    digest,
  );
  switch (result.status) {
    case "accepted": {
      const { post, reply, availableAtMs } = result;
      return destination.parentId === null
        ? c.json(boardPostResultSchema.parse({ post, availableAtMs }))
        : c.json(boardReplyResultSchema.parse({ reply, availableAtMs }));
    }
    case "changedReplay":
      return c.json(
        { message: "再送する本文か投稿先が変更されています。新しい投稿として送信してください。" },
        409,
      );
    case "stopped":
      return c.json({ message: "現在、掲示板への投稿は停止されています。" }, 403);
    case "rateLimited":
      return c.json(
        {
          message: "30秒に1件まで投稿できます。少し待ってから再試行してください。",
          availableAtMs: result.availableAtMs,
        },
        429,
      );
    case "ineligible":
      return ineligible(c);
    case "notFound":
      return c.notFound();
  }
}

boardRoutes.post(gamePath, (c) => {
  const game = gameSchema.safeParse(c.req.param("gameId"));
  return game.success ? submitPost(c, { gameId: game.data, parentId: null }) : c.notFound();
});

boardRoutes.post("/posts/:id/replies", (c) => {
  const id = boardPostIdSchema.safeParse(c.req.param("id"));
  return id.success ? submitPost(c, { gameId: null, parentId: id.data }) : c.notFound();
});

boardRoutes.delete("/posts/:id", async (c) => {
  const user = c.get("user");
  if (!user) return loginRequired(c);
  const id = boardPostIdSchema.safeParse(c.req.param("id"));
  if (!id.success || !(await deleteOwnBoardPost(c.env.APP_DB, user.id, id.data, Date.now())))
    return c.notFound();
  return c.body(null, 204);
});

boardRoutes.on(["PUT", "DELETE"], "/posts/:id/like", async (c) => {
  const user = c.get("user");
  if (!user) return loginRequired(c);
  const rejected = profileRejection(c, user);
  if (rejected) return rejected;
  const id = boardPostIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.notFound();
  const result = await setBoardLike(
    c.env.APP_DB,
    user.id,
    id.data,
    c.req.method === "PUT",
    Date.now,
  );
  if (result.status === "ineligible") return ineligible(c);
  if (result.status === "notFound") return c.notFound();
  return c.json(boardLikeResultSchema.parse({ liked: result.liked, likeCount: result.likeCount }));
});
