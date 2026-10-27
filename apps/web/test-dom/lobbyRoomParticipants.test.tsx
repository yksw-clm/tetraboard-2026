import { expect, test } from "bun:test";
import { MemoryRouter } from "react-router";
import type { LobbyRoomCard as RoomCardData } from "@tetraboard/protocol/general-lobby";
import { LobbyRoomCard } from "../src/features/lobby/LobbyRoomCard";
import { PlayerProfileProvider } from "../src/features/players/PlayerProfileProvider";
import { act, clock, flush, render, rerender, requests } from "./harness";

const instanceId = "11111111-1111-4111-8111-111111111111";
const firstPlayerId = "22222222-2222-4222-8222-222222222222";
const secondPlayerId = "33333333-3333-4333-8333-333333333333";
const room: RoomCardData = {
  id: "12345",
  instanceId,
  game: "four-shogi",
  mode: "doubles",
  status: "waiting",
  hostName: "同じ名前",
  hostAvatarUrl: null,
  profileTarget: null,
  timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
  humanCount: 2,
  cpuCount: 1,
  capacity: 4,
  openSeats: 1,
  updatedAtMs: 1,
  participants: [
    ...[firstPlayerId, secondPlayerId].map((playerId) => ({
      kind: "human" as const,
      avatarUrl: null,
      profileTarget: { source: "room" as const, roomId: "12345", instanceId, playerId },
    })),
    { kind: "cpu", level: 2 },
  ],
};
const profile = {
  kind: "account",
  profileId: "44444444-4444-4444-8444-444444444444",
  game: "four-shogi",
  name: "同じ名前",
  username: "first_player",
  avatarUrl: null,
  stats: { singles: { total: 3, first: 1 }, doubles: { total: 4, wins: 2 } },
};
const renderCard = (data = room, gameLink = false) => (
  <MemoryRouter>
    <PlayerProfileProvider>
      <LobbyRoomCard room={data} gameLink={gameLink}>
        <span>観戦操作</span>
      </LobbyRoomCard>
    </PlayerProfileProvider>
  </MemoryRouter>
);
const enter = (element: HTMLElement) =>
  act(() =>
    element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })),
  );
const leave = (element: HTMLElement) =>
  act(() =>
    element.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" })),
  );
const region = () => document.querySelector<HTMLElement>('[role="region"]');

for (const gameLink of [false, true]) {
  test(`${gameLink ? "総合" : "ゲーム別"}の参加者アイコンは本人ごとの既存プロフィールをhoverで開き、CPUは通信しない`, async () => {
    const view = render(renderCard(room, gameLink));
    const group = view.querySelector<HTMLElement>('[role="group"]')!;
    expect(group.getAttribute("aria-label")).toBe("人間2人、CPU1人、空席1席");
    const [first, second, cpu] = [...group.querySelectorAll<HTMLButtonElement>("button")];
    expect(group.querySelectorAll("button")).toHaveLength(3);
    expect(first!.getAttribute("aria-label")).toBe("ルーム12345の参加者1のプレイヤー情報");
    expect(second!.getAttribute("aria-label")).toBe("ルーム12345の参加者2のプレイヤー情報");
    expect(requests).toHaveLength(0);
    enter(first!);
    clock.advance(299);
    expect(requests).toHaveLength(0);
    clock.advance(1);
    await flush();
    expect(requests).toHaveLength(1);
    const firstQuery = new URL(requests[0]!.url, "https://tetraboard.test").searchParams;
    expect(firstQuery.get("source")).toBe("room");
    expect(firstQuery.get("roomId")).toBe(room.id);
    expect(firstQuery.get("instanceId")).toBe(instanceId);
    expect(firstQuery.get("playerId")).toBe(firstPlayerId);
    expect(firstQuery.get("game")).toBe("four-shogi");
    requests[0]!.respond(profile);
    await flush();
    expect(region()?.textContent).toContain("first_player");
    expect(region()?.textContent).toContain("ダブルス");

    leave(first!);
    enter(second!);
    clock.advance(300);
    await flush();
    expect(requests).toHaveLength(2);
    expect(new URL(requests[1]!.url, "https://tetraboard.test").searchParams.get("playerId")).toBe(
      secondPlayerId,
    );
    requests[1]!.respond({ kind: "guest", name: "同じ名前", avatarUrl: null });
    await flush();
    expect(region()?.textContent).toContain("ゲスト／ID・戦績なし");
    leave(second!);
    enter(cpu!);
    clock.advance(300);
    await flush();
    expect(requests).toHaveLength(2);
    expect(region()?.textContent).toContain("CPU Lv2");
    expect(region()?.textContent).toContain("戦績集計対象外");
  });
}

test("退会した席と空席は操作対象にせず、開いていた参加者カードも閉じる", async () => {
  const view = render(renderCard());
  const first = view.querySelector<HTMLButtonElement>(
    '[aria-label="ルーム12345の参加者1のプレイヤー情報"]',
  )!;
  act(() => first.click());
  await flush();
  requests[0]!.respond(profile);
  await flush();
  expect(region()?.textContent).toContain("first_player");
  rerender(
    view,
    renderCard({
      ...room,
      participants: [
        { kind: "human", avatarUrl: null, retired: true, profileTarget: null },
        ...room.participants.slice(1),
      ],
    }),
  );
  clock.advance(500);
  await flush();
  expect(region()).toBeNull();
  const group = view.querySelector<HTMLElement>('[role="group"]')!;
  expect(group.querySelectorAll("button")).toHaveLength(2);
  expect(group.querySelector('[aria-label="ルーム12345の参加者1のプレイヤー情報"]')).toBeNull();
  const retiredIcon = group.querySelector('[data-testid="player-avatar"]')!;
  const emptySeat = group.querySelector('[class*="border-dashed"]')!;
  enter(retiredIcon as HTMLElement);
  enter(emptySeat as HTMLElement);
  clock.advance(300);
  await flush();
  expect(requests).toHaveLength(1);
  expect(region()).toBeNull();
});
