import { gameCatalog, type GameId } from "./games";
import type { MatchSummary } from "./matches";

export type ShareMatch = {
  id: string;
  settings: { game: GameId; mode?: "singles" | "doubles" };
  participants: readonly {
    id: string;
    name: string;
    color?: string;
    side?: string;
    kind?: "human" | "cpu";
  }[];
  game: { result: MatchSummary["result"] };
};
export type ShareResultRow = {
  id: string;
  name: string;
  marker: string;
  markerLabel: string;
  cpu: boolean;
  label: string;
  winner: boolean;
  rank?: number;
  tied: boolean;
  draw: boolean;
  count?: number | null;
  team?: string;
};

export const shareMarkerNames: Record<string, string> = {
  black: "黒",
  white: "白",
  red: "赤",
  blue: "青",
  south: "南",
  west: "西",
  north: "北",
  east: "東",
};
const markerOrder = ["black", "white", "red", "blue", "south", "west", "north", "east"];
const teamFor = (marker: string) =>
  ["south", "north"].includes(marker)
    ? "south-north"
    : ["west", "east"].includes(marker)
      ? "west-east"
      : ["black", "red"].includes(marker)
        ? "black-red"
        : "white-blue";
export const shareTeamNames: Record<string, string> = {
  "south-north": "南・北チーム",
  "west-east": "西・東チーム",
  "black-red": "黒・赤チーム",
  "white-blue": "白・青チーム",
};

export function matchShareRows(match: ShareMatch): ShareResultRow[] {
  const result = match.game.result;
  return match.participants
    .map((player): ShareResultRow => {
      const marker = player.color ?? player.side;
      if (!marker) throw new Error("Missing result marker");
      const markerLabel =
        match.settings.game === "shogi"
          ? marker === "south"
            ? "先"
            : "後"
          : shareMarkerNames[marker]!;
      const base = {
        id: player.id,
        name: player.name,
        marker,
        markerLabel,
        cpu: player.kind === "cpu",
      };
      if ("standings" in result) {
        const standing = result.standings.find(
          (entry) => ("color" in entry ? entry.color : entry.side) === marker,
        );
        if (!standing) throw new Error("Missing result standing");
        const draw =
          ["agreement", "repetition", "no_survivors"].includes(result.reason) &&
          standing.rank === 1;
        return {
          ...base,
          rank: standing.rank,
          label: `${standing.rank}位`,
          winner: standing.rank === 1 && !draw,
          draw,
          tied: result.standings.filter((entry) => entry.rank === standing.rank).length > 1,
          ...(match.settings.game === "four-reversi"
            ? { count: "stoneCount" in standing ? standing.stoneCount : null }
            : {}),
        };
      }
      const doubles = "mode" in result && result.mode === "doubles";
      const team = doubles ? teamFor(marker) : undefined;
      const winner = result.winner !== null && result.winner === (team ?? marker);
      const counts = "stoneCounts" in result ? result.stoneCounts : undefined;
      const count = Array.isArray(counts)
        ? (counts.find((entry) => entry.color === marker)?.count ?? null)
        : counts?.[marker as "black" | "white"];
      return {
        ...base,
        team,
        winner,
        tied: false,
        draw: result.winner === null,
        label: result.winner === null ? "引き分け" : winner ? "勝利" : "敗北",
        ...(counts ? { count } : {}),
      };
    })
    .sort(
      (a, b) =>
        (a.rank ?? (a.winner ? 0 : 1)) - (b.rank ?? (b.winner ? 0 : 1)) ||
        markerOrder.indexOf(a.marker) - markerOrder.indexOf(b.marker),
    );
}

export function matchPostText(match: ShareMatch, selfId: string, url: string): string | null {
  const self = matchShareRows(match).find((row) => row.id === selfId);
  if (!self) return null;
  const name = gameCatalog[match.settings.game].name;
  const title = match.settings.game.endsWith("reversi") ? `${name}（オセロ）` : name;
  const mode = match.settings.mode === "doubles" ? "のダブルス" : "";
  const outcome = self.draw
    ? `引き分けでした${self.rank !== undefined ? `（同率${self.rank}位）` : ""}。`
    : self.rank !== undefined
      ? `${self.tied ? "同率" : ""}${self.rank}位${self.winner ? "になりました！🏆" : "でした！"}`
      : self.winner
        ? "勝ちました！🏆"
        : self.label === "引き分け"
          ? "引き分けでした。"
          : "対局しました。結果は敗北でした。";
  return `${title}${mode}で${outcome}\n棋譜はこちら👇\n${url}\n#${name} #TetraBoard`;
}

export function matchPostIntent(match: ShareMatch, selfId: string, origin: string): string | null {
  const text = matchPostText(match, selfId, new URL(`/matches/${match.id}`, origin).href);
  if (!text) return null;
  const url = new URL("https://x.com/intent/tweet");
  url.searchParams.set("text", text);
  return url.href;
}

export function matchShareMetadata(origin: string, match: Pick<ShareMatch, "id" | "settings">) {
  const name = gameCatalog[match.settings.game].name;
  const title = `${name}の対局結果 | TetraBoard`;
  const description = `${name}の最終盤面と対局結果。棋譜を再生して振り返れます。`;
  const image = new URL(`/assets/ogp/${match.settings.game}.png`, origin).href;
  const alt = `${name}の盤面とTetraBoardのロゴ`;
  return {
    title,
    tags: [
      { kind: "name", key: "description", value: description },
      { kind: "property", key: "og:title", value: title },
      { kind: "property", key: "og:description", value: description },
      { kind: "property", key: "og:type", value: "website" },
      { kind: "property", key: "og:url", value: new URL(`/matches/${match.id}`, origin).href },
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
