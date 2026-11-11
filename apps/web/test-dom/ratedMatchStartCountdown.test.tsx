import { expect, test } from "bun:test";
import { MemoryRouter } from "react-router";
import type { ComponentProps } from "react";
import { reversiRoomSchema, type Room } from "@tetraboard/protocol";
import { RatedMatchStartCountdown } from "../src/features/room/RatedMatchStartCountdown";
import { PlayerProfileProvider } from "../src/features/players/PlayerProfileProvider";
import { waitingRoom, now, playerIds } from "../test/fixtures/rooms";
import { waitingShogiRoom } from "../test/fixtures/fourShogiFixtures";
import { standardWaitingRoom } from "../test/fixtures/standardShogiFixtures";
import { flush, render, rerender, requests } from "./harness";

type Props = ComponentProps<typeof RatedMatchStartCountdown>;
const wrap = (props: Props) => (
  <MemoryRouter>
    <PlayerProfileProvider>
      <RatedMatchStartCountdown {...props} />
    </PlayerProfileProvider>
  </MemoryRouter>
);
function response(room: Room, index: number) {
  return {
    kind: "account",
    profileId: playerIds[index],
    game: room.settings.game,
    name: "現在のプロフィール名",
    username: `player_${index}`,
    avatarUrl: null,
    rating: { timing: "before", status: "rated", rating: 1500 + index * 10 },
    stats: room.settings.game.startsWith("four-")
      ? { singles: { total: 10, first: 3 }, doubles: { total: 0, wins: 0 } }
      : { total: 10, wins: 6, losses: 3, draws: 1 },
  };
}
function respond(room: Room) {
  for (const request of requests) {
    const index = room.players.findIndex((player) => request.url.includes(player.id));
    if (index >= 0) request.respond(response(room, index));
  }
}

test("入室後に先読みし、相手3人と実際の本人を分けて対局前情報を表示する", async () => {
  const room = waitingShogiRoom();
  const props = { room, ownPlayerId: playerIds[2], serverNowMs: now };
  const view = render(wrap(props));
  expect(view.querySelector("section")).toBeNull();
  expect(requests).toHaveLength(4);
  for (const request of requests) {
    const query = new URL(request.url, "https://example.test").searchParams;
    expect(query.get("source")).toBe("room");
    expect(query.get("instanceId")).toBe(room.instanceId);
    expect(query.get("includeRating")).toBe("1");
    expect(query.get("includeStats")).toBe("1");
  }
  respond(room);
  await flush();
  rerender(view, wrap({ ...props, startsAtMs: now + 5000 }));
  expect(requests).toHaveLength(4);
  expect(view.querySelectorAll('ul[aria-label="対戦相手"] li')).toHaveLength(3);
  const self = view.querySelector('[data-self="true"]')!;
  expect(self.textContent).toContain(room.players[2]!.name);
  expect(self.textContent).toContain("@player_2");
  expect(self.textContent).toContain("1520");
  expect(self.textContent).toContain("10戦 3優勝");
  expect(self.textContent).not.toContain("現在のプロフィール名");
  expect(view.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("開始まで5秒");
  rerender(view, wrap({ ...props, startsAtMs: now + 5000, serverNowMs: now + 1500 }));
  expect(view.querySelector('[role="status"]')?.textContent).toBe("4");
  rerender(view, wrap(props));
  expect(view.querySelector("section")).toBeNull();
});

test.each(["shogi", "reversi"] as const)(
  "%sは相手1人と本人を表示し、通算を勝数にする",
  async (game) => {
    const base = waitingRoom();
    const room =
      game === "shogi"
        ? standardWaitingRoom()
        : reversiRoomSchema.parse({
            ...base,
            settings: { game, timeControl: base.settings.timeControl },
            players: base.players.slice(0, 2),
          });
    const view = render(
      wrap({ room, ownPlayerId: playerIds[1], startsAtMs: now + 5000, serverNowMs: now }),
    );
    respond(room);
    await flush();
    expect(view.querySelectorAll("li")).toHaveLength(1);
    expect(view.querySelector('[data-self="true"]')?.textContent).toContain("10戦 6勝");
    expect(view.textContent).not.toContain("優勝");
  },
);

test("認定中・CPU基準値・取得失敗を区別し、取得待ちでもサーバー時刻で開始表示へ進む", async () => {
  const room = waitingShogiRoom();
  room.players[3] = {
    id: playerIds[3]!,
    name: "CPU",
    kind: "cpu",
    level: 2,
    ready: true,
    side: null,
    reconnectDeadline: null,
  };
  const props = { room, ownPlayerId: playerIds[0], startsAtMs: now + 5000, serverNowMs: now };
  const view = render(wrap(props));
  expect(view.textContent).toContain("取得中");
  requests[0]!.respond({ ...response(room, 0), rating: { timing: "before", status: "placement" } });
  requests[1]!.respond({ message: "失敗" }, 503);
  requests[3]!.respond({
    kind: "cpu",
    level: 2,
    rating: { timing: "reference", status: "rated", rating: 1437 },
  });
  await flush();
  expect(view.querySelector('[data-self="true"]')?.textContent).toContain("認定中");
  expect(view.querySelector('[data-self="true"]')?.textContent).not.toContain("1500");
  const opponents = [...view.querySelectorAll("li")];
  expect(opponents[0]!.textContent).toContain("取得失敗");
  expect(opponents[0]!.textContent).not.toContain("0戦");
  expect(opponents[1]!.textContent).toContain("取得中");
  expect(opponents[2]!.textContent).toContain("基準レート1437");
  expect(opponents[2]!.textContent).toContain("通算成績—");
  rerender(view, wrap({ ...props, serverNowMs: now + 6000 }));
  expect(view.querySelector('[role="status"]')?.textContent).toBe("開始");
});

test("観戦では誰も本人扱いせず、退会者のID・画像・戦績と現在レートを出さない", async () => {
  const room = waitingRoom();
  const props = { room, startsAtMs: now + 5000, serverNowMs: now };
  const view = render(wrap(props));
  requests[0]!.respond({
    ...response(room, 0),
    rating: { timing: "current", status: "rated", rating: 1900 },
  });
  requests[1]!.respond(response(room, 1));
  await flush();
  expect(view.querySelector('[data-self="true"]')).toBeNull();
  expect(view.querySelectorAll('ul[aria-label="対戦者"] li')).toHaveLength(4);
  expect(view.textContent).not.toContain("1900");
  const players = room.players.map((player, index) =>
    index === 1 && player.kind === "human" ? { ...player, retired: true as const } : player,
  );
  rerender(view, wrap({ ...props, room: { ...room, players } }));
  const retired = view.querySelectorAll("li")[1]!;
  expect(retired.textContent).toContain("退会したプレイヤー");
  expect(retired.textContent).not.toContain("@player_1");
  expect(retired.textContent).not.toContain("10戦");
});
