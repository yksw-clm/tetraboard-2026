import {
  boardProfileRejection,
  postToBoard,
  reportBoardPost,
  type BoardDestination,
} from "@tetraboard/context-community";
import {
  boardDetailSchema,
  boardLikeResultSchema,
  boardPostIdSchema,
  boardPostResultSchema,
  boardRepliesSchema,
  boardReplyResultSchema,
  boardReportInputSchema,
  boardTimelineSchema,
  parseBoardPostNumber,
  type BoardPost,
  type BoardReply,
} from "@tetraboard/protocol/board";
import { gameIds } from "@tetraboard/protocol/games";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { accountIdentity, type StoredProfile } from "../adapters/account/auth";
import { deleteOwnBoardPost, setBoardLike } from "../adapters/community/boardActions";
import { D1BoardWriter } from "../adapters/community/boardPosting";
import { D1BoardReader } from "../adapters/community/boardReads";
import { D1BoardReports } from "../adapters/community/boardReports";
import { digest } from "../crypto";
import { canAttachPosition } from "../flows/boardAttachment";
import { boardRepliesQuery, boardTimelineQuery, readBoardInput, readBoardJson } from "./boardInput";

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

function wantsAttachments(c: Context<BoardEnv>) {
  const flags = c.req.queries("includeAttachments");
  return flags?.length === 1 && flags[0] === "1";
}

function withoutAttachment(entry: BoardPost | BoardReply | null) {
  if (!entry || !("attachment" in entry)) return entry;
  const { attachment: _attachment, ...original } = entry;
  return original;
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
  return c.json(
    boardTimelineSchema.parse(
      query.data.includeAttachments ? page : { ...page, posts: page.posts.map(withoutAttachment) },
    ),
  );
});

boardRoutes.get("/posts/:id", async (c) => {
  const param = c.req.param("id");
  const pathId = new URL(c.req.url).pathname.split("/").at(-1) ?? "";
  const id = parseBoardPostNumber(pathId) ?? boardPostIdSchema.safeParse(param).data;
  if (id === undefined) return c.notFound();
  const page = await new D1BoardReader(c.env.APP_DB).detail(
    id,
    c.get("user")?.id ?? null,
    c.env.APP_ORIGIN === "https://tetraboard.net",
  );
  if (!page) return c.notFound();
  const { indexable, ...detail } = page;
  const response = wantsAttachments(c)
    ? detail
    : {
        ...detail,
        post: withoutAttachment(detail.post),
        replies: detail.replies.map(withoutAttachment),
      };
  return c.json(
    boardDetailSchema.parse({
      ...response,
      ...(c.req.query("includeIndexable") === "1" && { indexable }),
    }),
  );
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
  if (!page) return c.notFound();
  return c.json(
    boardRepliesSchema.parse(
      query.data.includeAttachments
        ? page
        : { ...page, replies: page.replies.map(withoutAttachment) },
    ),
  );
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

function invalidAttachment(c: Context<BoardEnv>) {
  return c.json({ message: "添付した棋譜の局面が見つかりません。" }, 400);
}

async function submitPost(c: Context<BoardEnv>, destination: BoardDestination) {
  const user = c.get("user");
  if (!user) return loginRequired(c);
  const rejected = profileRejection(c, user);
  if (rejected) return rejected;
  const body = await readBoardInput(c.req.raw, c.env.APP_ORIGIN);
  if (body.status === "invalidBody")
    return c.json({ message: "本文は1,000文字以内で入力してください。" }, 400);
  if (body.status === "invalidAttachment") return invalidAttachment(c);
  if (body.status === "invalidLink")
    return c.json({ message: "URLはTetraBoard内の公開棋譜、大会、ルームのみ投稿できます。" }, 400);

  const db = c.env.APP_DB;
  const result = await postToBoard(
    new D1BoardWriter(db, (game, attachment) => canAttachPosition(db, game, attachment)),
    { ...destination, ...body.input, accountId: user.id },
    Date.now,
    digest,
  );
  switch (result.status) {
    case "accepted": {
      const { post, reply, availableAtMs } = result;
      const entry = destination.parentId === null ? post : reply;
      const response = wantsAttachments(c) ? entry : withoutAttachment(entry);
      return destination.parentId === null
        ? c.json(boardPostResultSchema.parse({ post: response, availableAtMs }))
        : c.json(boardReplyResultSchema.parse({ reply: response, availableAtMs }));
    }
    case "changedReplay":
      return c.json(
        {
          message:
            "再送する本文、添付、投稿先のいずれかが変更されています。新しい投稿として送信してください。",
        },
        409,
      );
    case "invalidAttachment":
      return invalidAttachment(c);
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

boardRoutes.post("/posts/:id/reports", async (c) => {
  const id = boardPostIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.notFound();
  const user = c.get("user");
  if (!user) return loginRequired(c);
  const input = boardReportInputSchema.safeParse(await readBoardJson(c.req.raw, 4096));
  if (!input.success) return c.json({ message: "通報の理由を選んでください。" }, 400);
  const result = await reportBoardPost(
    new D1BoardReports(c.env.APP_DB),
    { accountId: user.id, postId: id.data, reason: input.data.reason },
    Date.now(),
  );
  if (result === "created") return c.json({ message: "通報を受け付けました。" }, 201);
  return result === "existing"
    ? c.json({ message: "通報を受け付けています。" }, 200)
    : c.json({ message: "投稿が見つからないか、通報回数の上限に達しています。" }, 429);
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
