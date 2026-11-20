import { Hono } from "hono";
import {
  lobbyChatSchema,
  lobbyPostSchema,
  lobbyPostResultSchema,
  lobbyReportSchema,
  lobbyModerationSchema,
  lobbyAdminSchema,
  tournamentChatSchema,
} from "@tetraboard/protocol/general-lobby";
import { tournamentIdSchema } from "@tetraboard/protocol";
import { publicTournament, type TournamentRow } from "../adapters/tournament/store";
import { accountIdentity, type StoredProfile } from "../adapters/account/auth";
import { adminIdentity } from "../admin/auth";
import { readLimitedBody } from "./readLimitedBody";
import { digest } from "../crypto";
import {
  chatProfileRejection,
  postChatMessage,
  readChatPage,
  reportChatMessage,
} from "@tetraboard/context-community";
import { D1ChatStore } from "../adapters/community/chatStore";
import { readChatModeration, moderateChat } from "../adapters/community/chatModeration";
import { D1ChatReports } from "../adapters/community/chatReports";
import { chatPageQuery } from "./lobbyChatQuery";
import { tournamentUnavailableMessage } from "./tournaments";
export const lobbyChatRoutes = new Hono<{
  Bindings: Env;
  Variables: {
    user: StoredProfile | null;
    tournamentId: number | null;
    tournament?: TournamentRow;
    readTournamentInChatBatch?: boolean;
  };
}>();
lobbyChatRoutes.use("/lobby/chat*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "GET" && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  c.set("user", await accountIdentity(c.req.raw, c.env));
  c.set("tournamentId", null);
  await next();
});
lobbyChatRoutes.use("/tournaments/:id/chat*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "GET" && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const id = tournamentIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.notFound();
  c.set("tournamentId", id.data);
  if (
    !c.get("readTournamentInChatBatch") &&
    !c.get("tournament") &&
    !(await publicTournament(c.env.APP_DB, id.data))
  )
    return c.notFound();
  c.set("user", await accountIdentity(c.req.raw, c.env));
  await next();
});
lobbyChatRoutes.use("/admin/lobby-chat*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "GET" && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const identity = await adminIdentity(c.req.raw, c.env);
  if (identity.status !== 200) return c.json({ message: identity.message }, identity.status);
  await next();
});
lobbyChatRoutes.onError((_error, c) =>
  c.json({ message: "チャットを処理できませんでした。もう一度お試しください。" }, 503),
);
async function body(request: Request) {
  const bytes = await readLimitedBody(request, 4096);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
for (const chatPath of ["/lobby/chat", "/tournaments/:id/chat"]) {
  lobbyChatRoutes.get(chatPath, async (c) => {
    const query = chatPageQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ message: "取得条件が正しくありません。" }, 400);
    const tournamentId = c.get("tournamentId");
    const db = c.env.APP_DB;
    let read;
    try {
      read = await readChatPage(
        new D1ChatStore(db),
        { ...query.data, viewer: c.get("user")?.id, tournamentId },
        Date.now,
      );
    } catch (error) {
      // batch失敗時は公開確認の結果に従って、従来のエラー応答を返します。
      if (tournamentId !== null && c.get("readTournamentInChatBatch")) {
        let tournament;
        try {
          tournament = await publicTournament(db, tournamentId);
        } catch {
          return c.json({ message: tournamentUnavailableMessage }, 503);
        }
        if (!tournament) return c.notFound();
      }
      throw error;
    }
    if (!read.published && c.get("readTournamentInChatBatch")) return c.notFound();
    return c.json(
      (tournamentId === null ? lobbyChatSchema : tournamentChatSchema).parse(read.page),
    );
  });

  lobbyChatRoutes.post(chatPath, async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ message: "ログインしてください。" }, 401);
    const profile = chatProfileRejection(user);
    if (profile === "profileIncomplete")
      return c.json({ message: "プロフィールの初回設定を完了してください。" }, 403);
    if (profile === "guestNameRequired")
      return c.json({ message: "投稿する名前を設定してください。" }, 403);
    const input = lobbyPostSchema.safeParse(await body(c.req.raw));
    if (!input.success)
      return c.json({ message: "本文は100文字以内で入力してください。URLは投稿できません。" }, 400);
    const result = await postChatMessage(
      new D1ChatStore(c.env.APP_DB),
      { ...input.data, accountId: user.id, tournamentId: c.get("tournamentId") },
      Date.now,
      digest,
    );
    switch (result.status) {
      case "accepted":
        return c.json(lobbyPostResultSchema.parse(result), 200);
      case "changedReplay":
        return c.json(
          { message: "再送する本文が変更されています。新しい投稿として送信してください。" },
          409,
        );
      case "closed":
        return c.json({ message: "チャットの投稿受付は終了しました。" }, 403);
      case "entryRequired":
        return c.json({ message: "投稿にはこの大会へのエントリーが必要です。" }, 403);
      case "stopped":
        return c.json({ message: "現在、公開チャットへの投稿は停止されています。" }, 403);
      case "rateLimited":
        return c.json(
          {
            message: "10秒に1件まで投稿できます。少し待ってから再試行してください。",
            availableAtMs: result.availableAtMs,
          },
          429,
        );
    }
  });

  lobbyChatRoutes.post(`${chatPath}/reports`, async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ message: "ログインしてください。" }, 401);
    const input = lobbyReportSchema.safeParse(await body(c.req.raw));
    if (!input.success) return c.json({ message: "通報する発言が正しくありません。" }, 400);
    const result = await reportChatMessage(
      new D1ChatReports(c.env.APP_DB),
      { accountId: user.id, messageId: input.data.messageId, tournamentId: c.get("tournamentId") },
      Date.now(),
    );
    if (result === "created") return c.json({ message: "通報を受け付けました。" }, 201);
    return result === "existing"
      ? c.json({ message: "通報を受け付けています。" }, 200)
      : c.json({ message: "発言が見つからないか、通報回数の上限に達しています。" }, 429);
  });
}

lobbyChatRoutes.get("/admin/lobby-chat", async (c) => {
  const query = c.req.query("tournamentId");
  const tournamentId = query === undefined ? null : tournamentIdSchema.safeParse(query);
  if (tournamentId && !tournamentId.success)
    return c.json({ message: "大会番号を確認してください。" }, 400);
  const view = await readChatModeration(c.env.APP_DB, tournamentId?.data ?? null, Date.now);
  return view ? c.json(lobbyAdminSchema.parse(view)) : c.notFound();
});

lobbyChatRoutes.post("/admin/lobby-chat", async (c) => {
  const input = lobbyModerationSchema.safeParse(await body(c.req.raw));
  if (!input.success) return c.json({ message: "操作内容が正しくありません。" }, 400);
  if (!(await moderateChat(c.env.APP_DB, input.data, Date.now))) return c.notFound();
  return c.json({ message: "変更しました。" });
});
