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

export async function readBoardJson(request: Request, limit: number): Promise<unknown> {
  const bytes = await readLimitedBody(request, limit);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
}

export async function readBoardInput(request: Request, origin: string) {
  const input = boardPostInputSchema.safeParse(await readBoardJson(request, 64 * 1024));
  if (!input.success) return { status: "invalidBody" } as const;
  if (scanBoardLinks(input.data.text, origin).some(({ link }) => link === null))
    return { status: "invalidLink" } as const;
  return { status: "valid", input: input.data } as const;
}
