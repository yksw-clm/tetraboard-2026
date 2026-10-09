import { expect, test } from "bun:test";
import { roomPublicMetadataSchema } from "@tetraboard/protocol";
import { gameIds, gameCapacity } from "@tetraboard/protocol/games";
import { LobbyList } from "../src/features/lobby/LobbyList";
import { useLobby } from "../src/features/lobby/useLobby";
import { clock, flush, press, render, requests } from "./harness";

const loadingText = "公開ルームを読み込んでいます…";

for (const game of gameIds) {
  function Lobby() {
    const lobby = useLobby(game);
    return (
      <LobbyList
        {...lobby}
        onRefresh={() => void lobby.refresh("refresh")}
        onLoadMore={() => void lobby.loadMore()}
        onJoin={() => {}}
        onWatch={() => {}}
      />
    );
  }

  for (const count of [0, 1]) {
    test(`${game}: ${count}件の一覧を自動更新中に保持し、手動更新だけ案内する`, async () => {
      const rooms = count
        ? [
            roomPublicMetadataSchema.parse({
              id: "12345",
              game,
              mode: game === "reversi" ? undefined : "singles",
              timeControl: { mainTimeMs: 300_000, byoyomiMs: 30_000 },
              status: "waiting",
              hostName: "ホスト",
              humanCount: 1,
              cpuCount: 0,
              capacity: gameCapacity(game),
              openSeats: gameCapacity(game) - 1,
              updatedAtMs: 1,
            }),
          ]
        : [];
      const page = { rooms, nextCursor: null };
      const view = render(<Lobby />);
      expect(view.textContent).toContain(loadingText);
      clock.advance(0);
      const initial = requests.at(-1)!;
      clock.advance(10_000);
      expect(requests).toHaveLength(1);
      expect(initial.init.signal?.aborted).toBe(false);
      initial.respond(page);
      await flush();
      const retainedText = count ? "ホスト" : "公開ルームはまだありません";
      expect(view.textContent).toContain(retainedText);
      expect(view.textContent).not.toContain(loadingText);

      clock.advance(10_000);
      expect(requests).toHaveLength(2);
      expect(view.textContent).toContain(retainedText);
      expect(view.textContent).not.toContain(loadingText);
      expect(view.querySelector('[data-pending="true"]')).toBeNull();
      requests.at(-1)!.respond(page);
      await flush();

      press(view, "更新");
      const manual = requests.at(-1)!;
      expect(view.textContent).toContain(retainedText);
      expect(view.textContent).toContain(loadingText);
      expect(view.querySelector('[data-pending="true"]')).not.toBeNull();
      clock.advance(20_000);
      expect(requests).toHaveLength(3);
      expect(manual.init.signal?.aborted).toBe(false);
      expect(view.textContent).toContain(loadingText);
      manual.respond({}, 503);
      await flush();
      expect(view.textContent).not.toContain(loadingText);
      expect(view.textContent).toContain("ロビーの一覧を取得できませんでした。");
      if (count) expect(view.textContent).toContain(retainedText);
      clock.advance(10_000);
      requests.at(-1)!.respond(page);
      await flush();
      expect(view.textContent).toContain(retainedText);
      expect(view.textContent).not.toContain("ロビーの一覧を取得できませんでした。");
    });
  }

  test(`${game}: 初回失敗後の自動再取得では初回の案内を繰り返さない`, async () => {
    const view = render(<Lobby />);
    clock.advance(0);
    requests.at(-1)!.respond({}, 503);
    await flush();
    expect(view.textContent).not.toContain(loadingText);
    expect(view.textContent).toContain("ロビーの一覧を取得できませんでした。");
    clock.advance(10_000);
    expect(view.textContent).not.toContain(loadingText);
    requests.at(-1)!.respond({ rooms: [], nextCursor: null });
    await flush();
    expect(view.textContent).toContain("公開ルームはまだありません");
  });
}
