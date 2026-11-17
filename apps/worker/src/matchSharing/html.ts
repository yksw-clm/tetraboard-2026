import { getPublicMatchContract } from "@tetraboard/protocol";
import { matchShareMetadata } from "@tetraboard/protocol/match-sharing";
import { roomShareMetadata } from "@tetraboard/protocol/room-sharing";
import { serveShareHtml } from "../roomShareHtml";
import { readPublicShareMetadata } from "./readMatch";

export async function serveMatchShareHtml(request: Request, env: Env, assets: Fetcher) {
  const url = new URL(request.url);
  const parsed = getPublicMatchContract.params.safeParse({ matchId: url.pathname.split("/")[2] });
  let metadata = roomShareMetadata(url.origin, null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (parsed.success) {
    try {
      const match = await Promise.race([
        readPublicShareMetadata(env.APP_DB, parsed.data.matchId),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1500);
        }),
      ]);
      if (match)
        metadata = matchShareMetadata(url.origin, { id: match.id, settings: { game: match.game } });
    } catch {
      // メタ情報の障害でも棋譜画面と再試行の入口を配信します。
      console.error("Match share metadata unavailable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return serveShareHtml(request, assets, metadata);
}
