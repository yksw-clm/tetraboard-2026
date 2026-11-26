import type { GameId } from "@tetraboard/protocol/games";
import { readTimeline } from "../board/boardApi";

export { boardLoadError } from "../board/boardApi";
export { LobbyPostPreviewContent } from "./LobbyPostPreviewContent";

export async function readLobbyPostPreview(game: GameId, signal: AbortSignal) {
  const timeline = await readTimeline(game, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
  return {
    acceptingPosts: timeline.acceptingPosts,
    posts: timeline.posts.filter((post) => post.status === "published").slice(0, 3),
    nowMs: timeline.serverTimeMs,
  };
}
