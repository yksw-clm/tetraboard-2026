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
export const boardPostApiPath = (id: string | number) => `/posts/${encodeURIComponent(id)}`;

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

export function boardEntriesRequest(
  path: string,
  init: RequestInit,
  fallback: string,
  query?: { before: string } | { after: string } | { includeIndexable: "1" },
) {
  const search = new URLSearchParams({ includeAttachments: "1", ...query });
  return boardRequest(`${path}?${search}`, init, fallback);
}

export async function readTimeline(game: GameId, signal: AbortSignal, before?: string) {
  const response = await boardEntriesRequest(
    boardTimelinePath(game),
    { signal },
    boardLoadError,
    before ? { before } : undefined,
  );
  return boardTimelineSchema.parse(await response.json());
}

export async function readDetail(id: string | number, signal: AbortSignal) {
  const response = await boardEntriesRequest(boardPostApiPath(id), { signal }, boardLoadError, {
    includeIndexable: "1",
  });
  return boardDetailSchema.parse(await response.json());
}

export async function readDetailOrMissing(id: string | number, signal: AbortSignal) {
  try {
    return await readDetail(id, signal);
  } catch (error) {
    if (error instanceof BoardRequestError && error.status === 404) return null;
    throw error;
  }
}

export async function readReplies(id: string, signal: AbortSignal, after: string) {
  const response = await boardEntriesRequest(
    `${boardPostApiPath(id)}/replies`,
    { signal },
    boardLoadError,
    { after },
  );
  return boardRepliesSchema.parse(await response.json());
}
