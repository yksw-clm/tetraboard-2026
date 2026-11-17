import { getPublicMatchContract } from "@tetraboard/protocol";
import { matchShareMetadata } from "@tetraboard/protocol/match-sharing";
import { roomShareMetadata } from "@tetraboard/protocol/room-sharing";
import { serveShareHtml } from "../roomShareHtml";
import { readPublicShareMatch } from "./readMatch";

export async function serveMatchShareHtml(request: Request, env: Env, assets: Fetcher) {
  const url = new URL(request.url);
  const parsed = getPublicMatchContract.params.safeParse({ matchId: url.pathname.split("/")[2] });
  let metadata = roomShareMetadata(url.origin, null);
  if (parsed.success) {
    try {
      const match = await readPublicShareMatch(env.APP_DB, parsed.data.matchId);
      if (match) metadata = matchShareMetadata(url.origin, match);
    } catch {
      // メタ情報の障害でも棋譜画面と再試行の入口を配信します。
      console.error("Match share metadata unavailable");
    }
  }
  return serveShareHtml(request, assets, metadata);
}
