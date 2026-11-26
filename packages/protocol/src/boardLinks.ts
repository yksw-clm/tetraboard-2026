import { getPublicMatchContract } from "./matches";
import { roomCodeSchema, roomSocketContract } from "./rooms";
import { tournamentIdSchema } from "./tournaments";

export type BoardLink =
  | { kind: "match"; matchId: string; position: number | null }
  | { kind: "tournament"; tournamentId: number }
  | { kind: "room"; roomId: string; instanceId: string | null; watch: boolean };

export type BoardLinkOccurrence = {
  start: number;
  end: number;
  url: string;
  link: BoardLink | null;
};

// 公開チャットと同じ URL の目印を使い、日本語が直後に続く場合も URL を切り出します。
const urlLike = /https?:\/\/[\x21-\x7E]*|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b/gi;

function parseBoardLink(url: string, origin: string): BoardLink | null {
  if (!url.startsWith(origin + "/")) return null;
  const path = url.slice(origin.length);
  const match = /^\/matches\/([0-9a-fA-F-]+)(?:\?position=(\d+))?$/.exec(path);
  if (match) {
    const params = getPublicMatchContract.params.safeParse({ matchId: match[1] });
    const position = match[2] === undefined ? null : Number(match[2]);
    if (!params.success || (position !== null && !Number.isSafeInteger(position))) return null;
    return { kind: "match", matchId: params.data.matchId, position };
  }

  const tournament = /^\/tournaments\/(\d+)$/.exec(path);
  if (tournament) {
    const id = tournamentIdSchema.safeParse(tournament[1]);
    return id.success ? { kind: "tournament", tournamentId: id.data } : null;
  }

  const room = /^\/rooms\/(\d+)(?:\?invite=([0-9a-fA-F-]+)(&watch=1)?)?$/.exec(path);
  if (!room) return null;
  const id = roomCodeSchema.safeParse(room[1]);
  const invitation = roomSocketContract.query.safeParse({ instanceId: room[2] });
  if (!id.success || !invitation.success) return null;
  return {
    kind: "room",
    roomId: id.data,
    instanceId: invitation.data.instanceId ?? null,
    watch: room[3] !== undefined,
  };
}

export function scanBoardLinks(text: string, origin: string): BoardLinkOccurrence[] {
  return Array.from(text.matchAll(urlLike), (match) => {
    const [url] = match;
    const start = match.index;
    return { start, end: start + url.length, url, link: parseBoardLink(url, origin) };
  });
}
