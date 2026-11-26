import {
  getPublicMatchContract,
  roomCodeSchema,
  roomSocketContract,
  tournamentIdSchema,
} from "@tetraboard/protocol";
import { boardCursorSchema, boardPostInputSchema } from "@tetraboard/protocol/board";
import { z } from "zod";
import { readLimitedBody } from "./readLimitedBody";

const boardPageCursor = boardCursorSchema.transform((cursor) => ({
  postedAtMs: Number(cursor.slice(0, cursor.indexOf(":"))),
  id: cursor.slice(cursor.indexOf(":") + 1),
}));

const timelineLimit = z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(1).max(20));
export const boardTimelineQuery = z.strictObject({
  before: boardPageCursor.optional(),
  limit: timelineLimit.prefault("20"),
});
export const boardRepliesQuery = z.strictObject({ after: boardPageCursor.optional() });

// 公開チャットと同じ URL の目印を使い、http(s) URL はパスとクエリまで照合します。
const urlLike = /https?:\/\/[\x21-\x7E]*|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b/gi;

function isBoardLink(url: string, origin: string) {
  if (!url.startsWith(origin + "/")) return false;
  const path = url.slice(origin.length);
  const match = /^\/matches\/([0-9a-fA-F-]+)(?:\?position=(\d+))?$/.exec(path);
  if (match)
    return (
      getPublicMatchContract.params.safeParse({ matchId: match[1] }).success &&
      (match[2] === undefined || Number.isSafeInteger(Number(match[2])))
    );
  const tournament = /^\/tournaments\/(\d+)$/.exec(path);
  if (tournament) return tournamentIdSchema.safeParse(tournament[1]).success;
  const room = /^\/rooms\/(\d+)(?:\?invite=([0-9a-fA-F-]+))?$/.exec(path);
  return (
    room !== null &&
    roomCodeSchema.safeParse(room[1]).success &&
    roomSocketContract.query.safeParse({ instanceId: room[2] }).success
  );
}

export async function readBoardInput(request: Request, origin: string) {
  const bytes = await readLimitedBody(request, 64 * 1024);
  if (!bytes) return { status: "invalidBody" } as const;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return { status: "invalidBody" } as const;
  }
  const input = boardPostInputSchema.safeParse(body);
  if (!input.success) return { status: "invalidBody" } as const;
  for (const [url] of input.data.text.matchAll(urlLike))
    if (!isBoardLink(url, origin)) return { status: "invalidLink" } as const;
  return { status: "valid", input: input.data } as const;
}
