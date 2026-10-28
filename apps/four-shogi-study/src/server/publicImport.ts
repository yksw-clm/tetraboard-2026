import {
  getPublicMatchContract,
  getPublicMatchReplayContract,
  isFourShogiMatch,
} from "@tetraboard/protocol";
import { HttpError, readBoundedJson } from "./http";

const publicOrigins = new Set([
  "https://tetraboard.net",
  "https://tetraboard-dev.chaossi-lab.workers.dev",
]);

export function publicMatchLocation(input: unknown) {
  if (typeof input !== "string") throw new HttpError(400, "公開棋譜のURLを入力してください");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new HttpError(400, "公開棋譜のURLを入力してください");
  }
  const match = /^\/(?:api\/)?matches\/([0-9a-f-]{36})\/?$/i.exec(url.pathname);
  if (!publicOrigins.has(url.origin) || url.username || url.password || !match)
    throw new HttpError(400, "TetraBoardの公開棋譜URLを指定してください");
  return { origin: url.origin, id: match[1], sourceUrl: `${url.origin}/matches/${match[1]}` };
}

/** 公開棋譜の取得だけを外部通信に限定し、転送先へ認証情報を送信しません。 */
export async function fetchPublicReplay(input: unknown, fetcher: typeof fetch = fetch) {
  const location = publicMatchLocation(input);
  const signal = AbortSignal.timeout(30000);
  const read = async (path: string) => {
    const response = await fetcher(`${location.origin}/api${path}`, {
      signal,
      redirect: "error",
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    if (!response.ok)
      throw new HttpError(400, `棋譜を取得できませんでした（HTTP ${response.status}）`);
    return readBoundedJson(response, 4 * 1024 * 1024);
  };
  const { match: detail } = getPublicMatchContract.response.parse(
    await read(`/matches/${location.id}`),
  );
  if (!isFourShogiMatch(detail) || detail.settings.mode !== "singles")
    throw new HttpError(400, "四人将棋シングルスの棋譜に対応しています");
  if (detail.replay.eventCount > 10000)
    throw new HttpError(413, "棋譜のイベント数が上限を超えています");
  const pages = [];
  let cursor = 0;
  for (;;) {
    const page = getPublicMatchReplayContract.response.parse(
      await read(`/matches/${location.id}/replay?cursor=${cursor}`),
    );
    if (page.matchId !== location.id || page.eventCount !== detail.replay.eventCount)
      throw new HttpError(400, "棋譜の対局IDまたはイベント数が一致しません");
    pages.push(page);
    const next = cursor + page.events.length;
    if (
      next > page.eventCount ||
      (page.nextCursor === null
        ? next !== page.eventCount
        : page.nextCursor !== next || next <= cursor || next >= page.eventCount)
    )
      throw new HttpError(400, "棋譜のページが連続していません");
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return { detail, pages, sourceUrl: location.sourceUrl };
}
