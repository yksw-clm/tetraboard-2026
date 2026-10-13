import { expect, spyOn, test } from "bun:test";
import { LobbyRankings } from "../src/features/lobby/LobbyRankings";
import { LobbyView } from "../src/features/lobby/LobbyView";
import { RoomEntryDialog } from "../src/features/lobby/RoomEntryDialog";
import { useRoomInvitation } from "../src/features/room/useRoomInvitation";
import { GameLobbyNavigation } from "../src/features/lobby/GameLobbyNavigation";
import { profile } from "../test/fixtures/account";
import { waitingRoom } from "../test/fixtures/rooms";
import {
  act,
  clock,
  denyStorage,
  flush,
  press,
  render,
  renderHook,
  rerender,
  requests,
  wrap,
} from "./harness";

const entries = Array.from({ length: 10 }, (_, i) => ({
  rank: i + 1,
  username: `player${i}`,
  name: `参加者${i}`,
  avatarUrl: null,
  value: 10 - i,
}));
const rankings = {
  singles: { first: entries, total: entries },
  doubles: { wins: entries, total: entries },
};
test("両ゲームのランキングは上位3人・詳細10人・集計選択、失敗時保持・空一覧を表示", async () => {
  for (const game of ["four-reversi", "four-shogi"] as const) {
    const view = render(<LobbyRankings game={game} />);
    clock.advance(0);
    expect(requests.at(-1)!.url).toBe(`/api/games/${game}/rankings?profilePreview=1`);
    expect(view.textContent).toContain("読み込んで");
    requests.at(-1)!.respond(rankings);
    await flush();
    expect(view.querySelectorAll("li")).toHaveLength(3);
    expect(view.textContent).toContain("対人戦・登録済ユーザーのみ集計");
    press(view, "もっと見る");
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelectorAll("li")).toHaveLength(10);
    expect(dialog.textContent).toContain("対戦相手にゲストがいても対象です。");
    act(() => dialog.querySelector<HTMLElement>('[role="tab"][id$="doubles"]')!.click());
    await flush();
    expect(dialog.textContent).toContain("勝利数");
    act(() => dialog.querySelector<HTMLElement>('[role="tab"][id$="total"]')!.click());
    await flush();
    expect(dialog.querySelector("h3")!.textContent).toBe("対局数");
    press(dialog, "更新");
    act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click());
    requests.at(-1)!.respond({}, 503);
    await flush();
    expect(view.querySelectorAll("li")).toHaveLength(3);
    expect(view.querySelector('[role="alert"]')).not.toBeNull();
    press(view, "再試行");
    requests
      .at(-1)!
      .respond({ singles: { first: [], total: [] }, doubles: { wins: [], total: [] } });
    await flush();
    expect(view.textContent).toContain("対象者がいません");
    rerender(view, null);
  }
});

test("ロビーの幅通知はセクションのDOM順だけを変え、ランキングの取得と選択を保持", async () => {
  const media = new window.EventTarget();
  let mobile = false;
  const matchMedia = spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        media: query,
        get matches() {
          return query === "(max-width: 767px)" && mobile;
        },
        addEventListener: media.addEventListener.bind(media),
        removeEventListener: media.removeEventListener.bind(media),
      }) as unknown as MediaQueryList,
  );
  try {
    const props = {
      game: "four-shogi" as const,
      name: "",
      roomCode: "",
      mode: "singles" as const,
      timeControl: { mainTimeMs: 60000, byoyomiMs: 0 } as const,
      isSubmitting: null,
      message: null,
      renderRooms: () => <section aria-label="公開部屋">公開部屋</section>,
      rankings: <LobbyRankings game="four-shogi" />,
      onNameChange() {},
      onRoomCodeChange() {},
      onModeChange() {},
      cpuLevel: 1 as const,
      onCpuLevelChange() {},
      onTimeControlChange() {},
      onClearMessage() {},
    };
    const view = render(wrap()(<LobbyView {...props} />));
    clock.advance(0);
    const request = requests.find((r) => r.url.endsWith("/rankings?profilePreview=1"))!;
    request.respond(rankings);
    await flush();
    const ranking = view.querySelector('section[aria-labelledby="lobby-rankings-title"]')!;
    act(() => ranking.querySelector<HTMLElement>('[role="tab"][id$="doubles"]')!.click());
    await flush();
    const count = requests.length;
    mobile = true;
    act(() => media.dispatchEvent(new Event("change")));
    await flush();
    expect(requests).toHaveLength(count);
    expect(view.querySelector('section[aria-labelledby="lobby-rankings-title"]')).toBe(ranking);
    expect(
      ranking.querySelector('[role="tab"][id$="doubles"]')!.getAttribute("aria-selected"),
    ).toBe("true");
    expect([...ranking.parentElement!.children].findIndex((n) => n === ranking)).toBeGreaterThan(
      [...ranking.parentElement!.children].findIndex(
        (n) => n.getAttribute("aria-label") === "公開部屋",
      ),
    );
    rerender(view, wrap()(<GameLobbyNavigation />));
    expect(view.querySelectorAll('a[href^="/games/"]')).toHaveLength(6);
  } finally {
    matchMedia.mockRestore();
  }
});

test("参加ダイアログはアカウントCPU確認条件と入力・送信ロック・取消を制御", async () => {
  let sent = 0,
    closed = 0;
  const props = {
    intent: "quick" as const,
    name: "入力",
    roomCode: "12345",
    mode: "singles" as const,
    timeControl: { mainTimeMs: 60000, byoyomiMs: 0 } as const,
    busy: false,
    message: null,
    onTimeControlChange() {},
    onNameChange() {},
    onRoomCodeChange() {},
    onModeChange() {},
    cpuLevel: 1 as const,
    onCpuLevelChange() {},
    onSubmit: () => sent++,
    onClose: () => closed++,
  };
  const view = render(wrap(profile)(<RoomEntryDialog {...props} />));
  await flush();
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
    "CPUを含んだ対局は、戦績に反映されません",
  );
  act(() =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(sent).toBe(1);
  rerender(view, wrap(profile)(<RoomEntryDialog {...props} busy message="再試行してください" />));
  act(() => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    document.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click();
  });
  expect(sent).toBe(1);
  expect(closed).toBe(0);
  rerender(view, wrap(profile)(<RoomEntryDialog {...props} message="失敗" />));
  expect(document.querySelector('[role="alert"]')!.textContent).toBe("失敗");
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click());
  expect(closed).toBe(1);
  rerender(view, wrap()(<RoomEntryDialog {...props} />));
  expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain(
    "CPUを含んだ対局は、戦績に反映されません",
  );
});

test("共有コピーは世代付きURLと連打防止、失敗時の案内、保存不可でも取消と焦点指定", async () => {
  const room = waitingRoom();
  room.players = room.players.slice(0, 1);
  let focused = 0,
    copied = 0,
    finish!: () => void;
  const failure = denyStorage();
  const write = spyOn(navigator.clipboard, "writeText").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const h = renderHook(
      () => useRoomInvitation(room, null, true, () => focused++),
      undefined,
      wrap(),
    );
    expect(h.current.dialog).toBe("join");
    act(() => h.current.close());
    clock.advance(16);
    expect(focused).toBe(1);
    act(() => h.current.openShare());
    act(() => {
      void h.current.copy(() => copied++);
      void h.current.copy(() => copied++);
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toContain(`invite=${room.instanceId}`);
    finish();
    await flush();
    expect(copied).toBe(1);
    write.mockRejectedValue(new Error("denied"));
    act(() => {
      void h.current.copy(() => copied++);
    });
    await flush();
    expect(h.current.dialog).toBe("share");
    expect(h.current.copyError).toContain("コピーできませんでした");
    act(() => h.current.close());
    expect(h.current.dialog).toBeNull();
    act(() => h.current.openJoin());
    expect(h.current.dialog).toBe("join");
  } finally {
    write.mockRestore();
    failure.mockRestore();
  }
});
