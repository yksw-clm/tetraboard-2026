import { expect, test } from "bun:test";
import { scanBoardLinks } from "../src/board";

const origin = "https://tetraboard.test";
const matchId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";
const matchUrl = `${origin}/matches/${matchId}`;
const tournamentUrl = `${origin}/tournaments/3`;
const roomUrl = `${origin}/rooms/12345`;
const inviteUrl = `${roomUrl}?invite=${instanceId}`;

test("本文のURLを出現順に切り出し、sliceに使える位置とリンク先を返す", () => {
  const prefix = "🎲棋譜は";
  const separator = "です。\n大会は";
  const matchWithPosition = matchUrl + "?position=0";
  const text = prefix + matchWithPosition + separator + tournamentUrl + "です。";
  const secondStart = prefix.length + matchWithPosition.length + separator.length;
  const occurrences = scanBoardLinks(text, origin);

  expect(occurrences).toEqual([
    {
      start: prefix.length,
      end: prefix.length + matchWithPosition.length,
      url: matchWithPosition,
      link: { kind: "match", matchId, position: 0 },
    },
    {
      start: secondStart,
      end: secondStart + tournamentUrl.length,
      url: tournamentUrl,
      link: { kind: "tournament", tournamentId: 3 },
    },
  ]);
  expect(occurrences.map(({ start, end }) => text.slice(start, end))).toEqual([
    matchWithPosition,
    tournamentUrl,
  ]);
});

test("局面指定なしの棋譜と、ルームの通常・招待・観戦リンクを判定する", () => {
  const text = [matchUrl, roomUrl, inviteUrl, inviteUrl + "&watch=1"].join("\n");
  expect(scanBoardLinks(text, origin).map(({ link }) => link)).toEqual([
    { kind: "match", matchId, position: null },
    { kind: "room", roomId: "12345", instanceId: null, watch: false },
    { kind: "room", roomId: "12345", instanceId, watch: false },
    { kind: "room", roomId: "12345", instanceId, watch: true },
  ]);
});

test.each([
  "https://example.test/tournaments/3",
  `${origin}/account/matches/${matchId}`,
  `${origin}/matches/invalid`,
  matchUrl + "/",
  matchUrl + ".",
  matchUrl + "#detail",
  matchUrl + "?position=-1",
  matchUrl + "?position=9007199254740992",
  matchUrl + "?position=1&other=1",
  `${origin}/tournaments/0`,
  tournamentUrl + "?tab=rooms",
  `${origin}/rooms/1234`,
  roomUrl + "?invite=invalid",
  roomUrl + "?watch=1",
  `${roomUrl}?watch=1&invite=${instanceId}`,
  inviteUrl + "&watch=0",
  inviteUrl + "&watch=01",
  inviteUrl + "&watch=1&other=1",
  inviteUrl + "&watch=1#room",
])("許可する形式以外の URL はリンク先を返さない (%s)", (url) => {
  expect(scanBoardLinks(url, origin)).toEqual([{ start: 0, end: url.length, url, link: null }]);
});

test("www. と裸のドメインを検出し、後続の外部 URL も出現順に返す", () => {
  const text = `${tournamentUrl}です。 外部はhttps://example.testです。www.example example.com`;
  expect(scanBoardLinks(text, origin).map(({ url, link }) => ({ url, link }))).toEqual([
    { url: tournamentUrl, link: { kind: "tournament", tournamentId: 3 } },
    { url: "https://example.test", link: null },
    { url: "www.", link: null },
    { url: "example.com", link: null },
  ]);
  expect(scanBoardLinks("リンクのない本文です。", origin)).toEqual([]);
});
