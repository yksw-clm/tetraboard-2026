import { expect, test } from "bun:test";
import type { LobbyRoomCard as CardData } from "@tetraboard/protocol/general-lobby";
import { LobbyRoomCard } from "../src/features/lobby/LobbyRoomCard";
import { PlayerProfileProvider } from "../src/features/players/PlayerProfileProvider";
import { GeneralLobbyRooms } from "../src/features/lobby/GeneralLobbyRooms";
import { useGeneralLobbyRooms } from "../src/features/lobby/useGeneralLobbyRooms";
import { act, clock, flush, render, requests, wrap } from "./harness";

const target = {
  source: "room" as const,
  roomId: "12345",
  instanceId: "11111111-1111-4111-8111-111111111111",
  playerId: "22222222-2222-4222-8222-222222222222",
};
const room: CardData = {
  id: target.roomId,
  instanceId: target.instanceId,
  game: "four-reversi",
  mode: "singles",
  status: "waiting",
  hostName: "募集者",
  hostAvatarUrl: null,
  profileTarget: target,
  humanCount: 1,
  cpuCount: 0,
  capacity: 4,
  openSeats: 3,
  updatedAtMs: 1,
  timeControl: { mainTimeMs: 180000, byoyomiMs: 0 },
  participants: [{ kind: "human", avatarUrl: null, profileTarget: target }],
};
for (const [kind, sequence, title] of [
  ["tournament", 1, "大会1局目"],
  ["rated", 1, "レート戦 #1"],
  ["tournament", undefined, "大会戦"],
  ["rated", undefined, "レート戦"],
  ["normal", undefined, "募集者の部屋"],
  ["unknown", undefined, "募集者の部屋"],
] as const) {
  test(`${kind}/${sequence ?? "番号なし"}の見出しと参加者の操作を維持する`, () => {
    const view = render(
      wrap()(
        <PlayerProfileProvider>
          <LobbyRoomCard room={{ ...room, matchKind: kind, matchSequence: sequence }}>
            <button>観戦</button>
          </LobbyRoomCard>
        </PlayerProfileProvider>,
      ),
    );
    const heading = view.querySelector("strong")!;
    expect(heading.textContent).toBe(title);
    expect(Boolean(heading.querySelector("button"))).toBe(kind === "normal" || kind === "unknown");
    expect(view.textContent).toContain("#12345");
    expect(
      view.querySelector('[aria-label="ルーム12345の参加者1のプレイヤー情報"]'),
    ).not.toBeNull();
    const before = requests.length;
    act(() => heading.click());
    expect(requests.length).toBe(before);
  });
}
for (const game of [undefined, "four-reversi"] as const) {
  test(`${game ?? "総合"}ロビーが通し番号を要求し、更新でも応答の番号を表示する`, async () => {
    function Page() {
      const page = useGeneralLobbyRooms(game);
      return <GeneralLobbyRooms page={page} onRoomAction={() => {}} />;
    }
    const view = render(wrap()(<Page />));
    clock.advance(0);
    expect(
      new URL(requests.at(-1)!.url, "http://localhost").searchParams.get("includeMatchSequence"),
    ).toBe("1");
    const data = { ...room, matchKind: "rated", matchSequence: 123456789 };
    requests.at(-1)!.respond({ rooms: [data], nextCursor: null, totalCount: 1 });
    await flush();
    expect(view.textContent).toContain("レート戦 #123456789");
    clock.advance(10000);
    requests.at(-1)!.respond({ rooms: [data], nextCursor: null, totalCount: 1 });
    await flush();
    expect(view.textContent).toContain("レート戦 #123456789");
    expect(requests.length).toBe(2);
  });
}
