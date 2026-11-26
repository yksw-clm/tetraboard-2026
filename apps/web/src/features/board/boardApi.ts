import {
  boardTimelineSchema,
  boardDetailSchema,
  boardRepliesSchema,
} from "@tetraboard/protocol/board";
import type { GameId } from "@tetraboard/protocol/games";

export const boardLoadError = "投稿を取得できませんでした。";
export const boardMissing =
  "投稿が見つかりません。削除されたか、URL が間違っている可能性があります。";

export const boardTimelinePath = (game: GameId) => `/games/${game}/posts`;
export const boardPostPath = (id: string) => `/posts/${encodeURIComponent(id)}`;

export class BoardRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function boardRequest(
  path: string,
  init: RequestInit,
  fallback: string,
): Promise<Response> {
  const response = await fetch(`/api${path}`, {
    cache: "no-store",
    ...init,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message =
      body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : fallback;
    throw new BoardRequestError(response.status, message);
  }
  return response;
}

export function mutationError(error: unknown, fallback: string) {
  return error instanceof BoardRequestError ? error.message : fallback;
}

export async function readTimeline(game: GameId, signal: AbortSignal, before?: string) {
  const query = before ? `?before=${encodeURIComponent(before)}` : "";
  const response = await boardRequest(boardTimelinePath(game) + query, { signal }, boardLoadError);
  return boardTimelineSchema.parse(await response.json());
}

export async function readDetail(id: string, signal: AbortSignal) {
  const response = await boardRequest(boardPostPath(id), { signal }, boardLoadError);
  return boardDetailSchema.parse(await response.json());
}

export async function readReplies(id: string, signal: AbortSignal, after: string) {
  const path = `${boardPostPath(id)}/replies?after=${encodeURIComponent(after)}`;
  const response = await boardRequest(path, { signal }, boardLoadError);
  return boardRepliesSchema.parse(await response.json());
}
