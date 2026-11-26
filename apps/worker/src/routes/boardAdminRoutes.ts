import { boardAdminSchema, boardModerationSchema } from "@tetraboard/protocol/board";
import { Hono } from "hono";
import { moderateBoard, readBoardModeration } from "../adapters/community/boardModeration";
import { adminIdentity } from "../admin/auth";
import { readBoardJson } from "./boardInput";

export const boardAdminRoutes = new Hono<{ Bindings: Env }>();
const path = "/admin/board";

boardAdminRoutes.use(path, async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "GET" && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const identity = await adminIdentity(c.req.raw, c.env);
  if (identity.status !== 200) return c.json({ message: identity.message }, identity.status);
  await next();
});

boardAdminRoutes.onError((_error, c) =>
  c.json({ message: "掲示板を処理できませんでした。もう一度お試しください。" }, 503),
);

boardAdminRoutes.get(path, async (c) => {
  const page = await readBoardModeration(c.env.APP_DB, Date.now());
  return c.json(boardAdminSchema.parse(page));
});

boardAdminRoutes.post(path, async (c) => {
  const input = boardModerationSchema.safeParse(await readBoardJson(c.req.raw, 4096));
  if (!input.success) return c.json({ message: "操作内容が正しくありません。" }, 400);
  if (!(await moderateBoard(c.env.APP_DB, input.data, Date.now()))) return c.notFound();
  return c.json({ message: "変更しました。" });
});
