import { GuestLinkError } from "@tetraboard/context-account";
import { Hono } from "hono";
import type { AuthEnv } from "../accounts/auth";
import {
  cancelGuestRoomLink,
  mergeGuestAccounts,
  promoteGuestLink,
  readGuestMerge,
} from "../flows/guestRegistration/guestLink";
import { clearGuestSession } from "./guestSession";

export const guestLinkRoutes = new Hono<{ Bindings: AuthEnv }>();
guestLinkRoutes.use("/account/guest-merge", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
guestLinkRoutes.onError((err, c) =>
  c.json(
    {
      message:
        err instanceof GuestLinkError
          ? err.message
          : "引き継ぎできませんでした。同じ対局・大会への重複参加や参加中のルームを確認してください。",
    },
    err instanceof GuestLinkError ||
      /guest_merge_conflict|guest_promotion_conflict|UNIQUE constraint/.test(err.message)
      ? 409
      : 503,
  ),
);
guestLinkRoutes.get("/account/guest-merge", async (c) => {
  const flow = await readGuestMerge(c.req.raw, c.env);
  return c.json({
    pending: flow
      ? {
          guestName: flow.name,
          ...(flow.is_new_target ? { isNewTarget: true } : {}),
          ...(flow.room_registration_id ? { roomRegistrationId: flow.room_registration_id } : {}),
        }
      : null,
  });
});
guestLinkRoutes.post("/account/guest-merge", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const flow = await readGuestMerge(c.req.raw, c.env);
  if (!flow) return c.json({ message: "引き継ぎの本人確認をやり直してください。" }, 401);
  if (flow.is_new_target) await promoteGuestLink(c.req.raw, c.env, flow);
  else await mergeGuestAccounts(c.env, flow);
  await clearGuestSession(c.req.raw, c.env);
  return c.json({ merged: true });
});
guestLinkRoutes.delete("/account/guest-merge", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const flow = await readGuestMerge(c.req.raw, c.env);
  if (flow?.room_registration_id) await cancelGuestRoomLink(c.env, flow.room_registration_id);
  if (flow) await clearGuestSession(c.req.raw, c.env);
  return c.json({ cancelled: true });
});
