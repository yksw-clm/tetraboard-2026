import {
  boardCursorSchema,
  boardPostInputSchema,
  scanBoardLinks,
} from "@tetraboard/protocol/board";
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
  if (scanBoardLinks(input.data.text, origin).some(({ link }) => link === null))
    return { status: "invalidLink" } as const;
  return { status: "valid", input: input.data } as const;
}
