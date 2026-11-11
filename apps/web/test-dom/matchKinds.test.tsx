import { expect, test } from "bun:test";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ReactNode } from "react";
import { lobbyRoomCardSchema } from "@tetraboard/protocol/general-lobby";
import type { MatchKind } from "@tetraboard/protocol";
import { LobbyRoomCard } from "../src/features/lobby/LobbyRoomCard";
import { MatchHistoryCard } from "../src/features/matches/MatchHistoryCard";
import { RecentMatches } from "../src/features/matches/RecentMatches";
import { SavedMatchReplayView } from "../src/features/room/SavedMatchReplayView";
import { ReplayCard } from "../src/features/room/ReplayCard";
import { replayMatch } from "../test/fixtures/matchReplayFixtures";
import { match } from "../test/fixtures/matchSummary";
import { clock, flush, press, render, requests } from "./harness";

function wrap() {
  return (child: ReactNode) => (
    <RouterProvider router={createMemoryRouter([{ path: "*", element: child }])} />
  );
}
const labels: [MatchKind | undefined, string][] = [
  ["rated", "レート戦"],
  ["tournament", "大会戦"],
  ["normal", "通常対局"],
  ["unknown", "種別不明"],
  [undefined, "種別不明"],
];
const replay = { frames: [{ label: "開始局面" }], index: 0, select() {} };
for (const [kind, label] of labels) {
  test(`${kind ?? "旧応答"}: ルーム・棋譜カード・保存棋譜の操作欄で種別を統一する`, () => {
    const room = lobbyRoomCardSchema.parse({
      id: "12345",
      instanceId: "11111111-1111-4111-8111-111111111111",
      game: "four-reversi",
      mode: "singles",
      status: "waiting",
      hostName: "募集者",
      humanCount: 1,
      cpuCount: 1,
      capacity: 4,
      openSeats: 2,
      updatedAtMs: 1,
      timeControl: { mainTimeMs: 180000, byoyomiMs: 0 },
      matchKind: kind,
      participants: [
        { kind: "human", avatarUrl: null, profileTarget: null },
        { kind: "cpu", level: 1 },
      ],
    });
    const card = render(
      wrap()(
        <LobbyRoomCard room={room}>
          <button>観戦</button>
        </LobbyRoomCard>,
      ),
    );
    expect(card.querySelector('[aria-label^="対局種別:"]')?.textContent).toBe(label);
    expect(card.textContent).toContain("募集中");
    expect(card.textContent).toContain("2 / 4");
    const history = render(
      wrap()(<MatchHistoryCard match={{ ...match(1), matchKind: kind }} to="/matches/1" />),
    );
    expect(history.querySelector('[aria-label^="対局種別:"]')?.textContent).toBe(label);
    expect(history.textContent).toContain("CPUあり");
    const saved = render(
      wrap()(
        <SavedMatchReplayView
          match={{ ...replayMatch(), matchKind: kind }}
          board={<p>盤面</p>}
          replay={replay}
          result={<p>結果</p>}
          onRotate={() => {}}
        />,
      ),
    );
    const status = saved.querySelector('[aria-label="対局状況"]')!;
    expect(status.querySelector('[aria-label^="対局種別:"]')?.textContent).toBe(label);
    expect(status.textContent).toContain("結果");
    expect(Boolean(status.querySelector('[aria-label="盤面を時計回りに90度回転"]'))).toBe(true);
    expect(requests).toHaveLength(0);
  });
}
test("ゲーム別の最近3件と詳細カードは取得した種別を共用し、旧応答を通常対局にしない", async () => {
  const view = render(wrap()(<RecentMatches game="four-reversi" />));
  clock.advance(0);
  expect(
    new URL(requests.at(-1)!.url, "http://localhost").searchParams.get("includeMatchKind"),
  ).toBe("1");
  requests.at(-1)!.respond({
    matches: [
      { ...match(1), matchKind: "rated" },
      { ...match(2), matchKind: "tournament" },
      match(3),
    ],
  });
  await flush();
  expect(
    [...view.querySelectorAll('[aria-label^="対局種別:"]')].map((node) => node.textContent),
  ).toEqual(["レート戦", "大会戦", "種別不明"]);
  press(view, "もっと見る");
  await flush();
  expect(
    [...document.querySelectorAll('[role="dialog"] [aria-label^="対局種別:"]')].map(
      (node) => node.textContent,
    ),
  ).toEqual(["レート戦", "大会戦", "種別不明"]);
  expect(requests).toHaveLength(1);
});
test("総合ロビーの棋譜カードにも同じ種別を表示する", async () => {
  const view = render(wrap()(<RecentMatches game="all" />));
  clock.advance(0);
  requests.at(-1)!.respond({ matches: [{ ...match(1), matchKind: "normal" }] });
  await flush();
  expect(view.querySelector('article [aria-label^="対局種別:"]')?.textContent).toBe("通常対局");
  expect(requests).toHaveLength(1);
});
test("ルーム内の直前局の棋譜でも種別を表示し、局面移動を妨げない", () => {
  const view = render(<ReplayCard replay={replay} matchKind="rated" />);
  expect(view.querySelector('[aria-label^="対局種別:"]')?.textContent).toBe("レート戦");
  expect(Boolean(view.querySelector('[aria-label="棋譜を1つ戻る"]'))).toBe(true);
  expect(Boolean(view.querySelector('[aria-label="棋譜を1つ進む"]'))).toBe(true);
});
