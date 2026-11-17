import { expect, test } from "bun:test";
import { publicMatchDetailSchema } from "@tetraboard/protocol";
import {
  matchShareRows,
  matchPostText,
  matchPostIntent,
  matchShareMetadata,
} from "@tetraboard/protocol/match-sharing";
import { reversiArchives, shogiArchives } from "../../../test-fixtures/matches";
import reversiDraw from "../../../test-fixtures/matches/reversi-standard-draw.json";
import gomoku from "../../../test-fixtures/matches/gomoku-on-five.json";
import fourGomoku from "../../../test-fixtures/matches/four-gomoku-singles-ranked.json";
import { standardSavedRound } from "./fixtures/standardShogiFixtures";

test("6ゲームの共有は保存された全員の結果に対応し、本人の文章と公開URLを渡す", () => {
  const matches = [
    ...reversiArchives,
    ...shogiArchives.filter((f) => f.name !== "shogi-legacy"),
    reversiDraw,
    gomoku,
    fourGomoku,
  ].map((f) => parsePublic(f.detail));
  matches.push(parsePublic(standardSavedRound().match));
  expect(new Set(matches.map((m) => m.settings.game)).size).toBe(6);
  for (const match of matches) {
    const tags = Object.fromEntries(
      matchShareMetadata("https://preview.example", match).tags.map((tag) => [tag.key, tag.value]),
    );
    expect(tags["og:image"]).toBe(`https://preview.example/assets/ogp/${match.settings.game}.png`);
    expect(tags["twitter:image"]).toBe(tags["og:image"]);
    expect(
      matchShareMetadata("https://preview.example", { ...match, id: "another-match" }).tags.find(
        (tag) => tag.key === "og:image",
      )?.value,
    ).toBe(tags["og:image"]);
    const rows = matchShareRows(match);
    expect(new Set(rows.map((row) => row.id))).toEqual(
      new Set(match.participants.map((p) => p.id)),
    );
    for (const row of rows) {
      const text = matchPostText(match, row.id, `https://tetraboard.net/matches/${match.id}`)!;
      expect(text).toContain(
        row.draw ? "引き分け" : row.rank ? `${row.rank}位` : row.winner ? "勝ちました" : "敗北",
      );
      const intent = new URL(matchPostIntent(match, row.id, "https://tetraboard.net")!);
      expect(intent.origin + intent.pathname).toBe("https://x.com/intent/tweet");
      expect(intent.searchParams.get("text")).toBe(text);
      expect(text).not.toContain("/account/");
    }
    expect(matchPostIntent(match, "spectator", "https://tetraboard.net")).toBeNull();
  }
});

test("同順位・脱落・チーム勝利と引き分けを区別する", () => {
  const normal = parsePublic(reversiArchives[0]!.detail);
  const rows = matchShareRows(normal);
  expect(rows.map((r) => [r.marker, r.rank, r.tied, r.count])).toEqual([
    ["blue", 1, false, 31],
    ["white", 2, true, 15],
    ["red", 2, true, 15],
    ["black", 4, false, 1],
  ]);
  const eliminated = matchShareRows(parsePublic(reversiArchives[2]!.detail));
  expect(eliminated.filter((row) => row.count === null)).toHaveLength(3);
  const team = matchShareRows(parsePublic(shogiArchives[1]!.detail));
  expect(team.filter((r) => r.winner).map((r) => r.marker)).toEqual(["south", "north"]);
  const draw = parsePublic(shogiArchives[2]!.detail);
  expect(matchShareRows(draw).every((r) => r.draw && !r.winner)).toBe(true);
  expect(matchPostText(draw, draw.participants[0]!.id, "url")).toContain(
    "引き分けでした（同率1位）",
  );
});

test("棋譜メタ情報はゲーム別固定画像と対局別の公開棋譜を参照する", () => {
  const match = parsePublic(gomoku.detail);
  const metadata = matchShareMetadata("https://preview.example", match);
  const tags = Object.fromEntries(metadata.tags.map((tag) => [tag.key, tag.value]));
  expect(tags["og:url"]).toBe(`https://preview.example/matches/${match.id}`);
  expect(tags["og:image"]).toBe(`https://preview.example/assets/ogp/${match.settings.game}.png`);
  expect(tags["twitter:card"]).toBe("summary_large_image");
});

function parsePublic(value: object) {
  const copy = { ...value };
  Reflect.deleteProperty(copy, "selfPlayerId");
  return publicMatchDetailSchema.parse(copy);
}
