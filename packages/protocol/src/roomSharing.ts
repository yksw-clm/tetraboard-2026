import { gameCatalog, type GameId } from "./games";

export type ShareRoom = { id: string; instanceId: string; settings: { game: GameId } };

export function roomSharePath(room: Pick<ShareRoom, "id" | "instanceId">): string {
  return `/rooms/${room.id}?invite=${encodeURIComponent(room.instanceId)}`;
}

export function roomRecruitmentText(game: GameId, url: string): string {
  const name = gameCatalog[game].name;
  return `${name}の対戦相手を募集中！\nブラウザですぐ遊べます。気軽に参加してください！\n${url}\n#${name} #TetraBoard`;
}

export function roomRecruitmentIntent(game: GameId, url: string): string {
  const intent = new URL("https://x.com/intent/tweet");
  intent.searchParams.set("text", roomRecruitmentText(game, url));
  return intent.href;
}

export function recruitmentUnavailable(room: {
  status: "waiting" | "playing";
  settings: { game: GameId };
  players: readonly unknown[];
}): string | null {
  if (room.status === "playing") return "対局中のため、現在は観戦のみできます";
  return room.players.length >= gameCatalog[room.settings.game].capacity
    ? "満室のため、現在は参加できません"
    : null;
}

export function roomShareMetadata(origin: string, room: ShareRoom | null) {
  const game = room?.settings.game;
  const name = game ? gameCatalog[game].name : "TetraBoard";
  const title = game ? `${name}のルーム | TetraBoard` : "TetraBoard | ブラウザでボードゲーム";
  const description = game
    ? `ブラウザで遊べる${name}。リンクからルームに参加・観戦できます。`
    : "ブラウザですぐ遊べるオンラインボードゲーム。友達と対戦・観戦を楽しめます。";
  const image = new URL(`/assets/ogp/${game ?? "tetraboard"}.png`, origin).href;
  const alt = game ? `${name}の盤面とTetraBoardのロゴ` : "TetraBoardのロゴとボードゲームの盤面";
  const url = new URL(room ? roomSharePath(room) : "/", origin).href;
  return {
    title,
    tags: [
      { kind: "name", key: "description", value: description },
      { kind: "property", key: "og:title", value: title },
      { kind: "property", key: "og:description", value: description },
      { kind: "property", key: "og:type", value: "website" },
      { kind: "property", key: "og:url", value: url },
      { kind: "property", key: "og:image", value: image },
      { kind: "property", key: "og:image:width", value: "1200" },
      { kind: "property", key: "og:image:height", value: "630" },
      { kind: "property", key: "og:image:alt", value: alt },
      { kind: "property", key: "og:site_name", value: "TetraBoard" },
      { kind: "name", key: "twitter:card", value: "summary_large_image" },
      { kind: "name", key: "twitter:title", value: title },
      { kind: "name", key: "twitter:description", value: description },
      { kind: "name", key: "twitter:image", value: image },
      { kind: "name", key: "twitter:image:alt", value: alt },
    ] as const,
  };
}
