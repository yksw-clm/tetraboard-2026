import { moderateRoomReport } from "@tetraboard/context-community";
import type { ModerationReport } from "@tetraboard/protocol";
import { createReport, getReport, resolveReport } from "../adapters/community/reports";

export async function reportRoomMessage(
  env: Env,
  roomId: string,
  token: string,
  messageId: string,
) {
  const target = await env.GAME_ROOM.getByName(roomId).inspectReport(token, messageId);
  if (target.status !== "found")
    return { status: target.status === "unauthorized" ? "unauthorized" : "not_found" } as const;
  return createReport(env.APP_DB, {
    roomId,
    instanceId: target.instanceId,
    message: target.message,
    reporterHash: target.reporterHash,
  });
}

export function moderateRoomMessageReport(
  env: Env,
  id: string,
  action: NonNullable<ModerationReport["action"]>,
) {
  return moderateRoomReport(
    {
      read: (id) => getReport(env.APP_DB, id),
      apply: (report, remove, mute) =>
        env.GAME_ROOM.getByName(report.roomId).moderateMessage(
          report.instanceId,
          report.message.id,
          report.message.senderId,
          remove,
          mute,
        ),
      resolve: (id, action) => resolveReport(env.APP_DB, id, action),
    },
    id,
    action,
  );
}
