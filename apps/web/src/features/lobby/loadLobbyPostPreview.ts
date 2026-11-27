import type { GameId } from "@tetraboard/protocol/games";
import { boardLoadError, readTimeline } from "../board/boardApi";
import { LobbyPostPreviewContent } from "./LobbyPostPreviewContent";

export async function readLobbyPostPreview(game: GameId, signal: AbortSignal) {
  try {
    const timeline = await readTimeline(
      game,
      AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    );
    return {
      status: "ready",
      Posts: LobbyPostPreviewContent,
      data: {
        acceptingPosts: timeline.acceptingPosts,
        posts: timeline.posts.filter((post) => post.status === "published").slice(0, 3),
        nowMs: timeline.serverTimeMs,
      },
    } as const;
  } catch {
    return { status: "api-error", message: boardLoadError } as const;
  }
}
