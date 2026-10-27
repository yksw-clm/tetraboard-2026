import { expect, spyOn, test } from "bun:test";
import { LobbyRankings } from "../src/features/lobby/LobbyRankings";
import { LobbyView } from "../src/features/lobby/LobbyView";
import { RoomEntryDialog } from "../src/features/lobby/RoomEntryDialog";
import { useRoomInvitation } from "../src/features/room/useRoomInvitation";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { useLocation } from "react-router";
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
test("全6ロビーの作成導線はダイアログだけを開き、再訪時の作成意図を消費", async () => {
  function Location() {
    const location = useLocation();
    return <output>{JSON.stringify(location.state)}</output>;
  }
  for (const game of gameIds) {
    const props = {
      game,
      name: "",
      roomCode: "",
      mode: "singles" as const,
      cpuLevel: 1 as const,
      timeControl: { mainTimeMs: 60000, byoyomiMs: 0 } as const,
      isSubmitting: null,
      message: null,
      renderRooms: () => null,
      onNameChange() {},
      onRoomCodeChange() {},
      onModeChange() {},
      onCpuLevelChange() {},
      onTimeControlChange() {},
      onClearMessage() {},
    };
    const view = render(
      wrap(null, {
        pathname: gameCatalog[game].lobbyPath,
        state: { roomEntryIntent: "create", preserved: true },
      })(
        <>
          <LobbyView {...props} />
          <Location />
        </>,
      ),
    );
    await flush();
    const preview = view.querySelector('main [data-testid="lobby-board-preview"]')!;
    expect(preview.tagName).toBe("IMG");
    expect(preview.getAttribute("src")).toEndWith(
      `/lobby/${game === "four-gomoku" ? "gomoku" : game}.webp`,
    );
    expect(preview.getAttribute("alt")).toBe("");
    expect(preview.getAttribute("aria-hidden")).toBe("true");
    expect(Number(preview.getAttribute("width"))).toBeGreaterThan(0);
    expect(Number(preview.getAttribute("height"))).toBeGreaterThan(0);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("ルームを作る");
    expect(JSON.parse(view.querySelector("output")!.textContent!)).toEqual({ preserved: true });
    expect(requests.some((request) => request.init.method === "POST")).toBe(false);
    rerender(view, null);
  }
});
test("両ゲームのランキングは上位3人・詳細10人・集計選択、失敗時保持・空一覧を表示", async () => {
  for (const game of ["four-reversi", "four-shogi"] as const) {
    const view = render(<LobbyRankings game={game} />);
    clock.advance(0);
    expect(requests.at(-1)!.url).toBe(
      `/api/games/${game}/rankings?profilePreview=1${game === "four-shogi" ? "&includeKnockouts=1" : ""}`,
    );
    expect(view.textContent).toContain("読み込んで");
    requests.at(-1)!.respond(rankings);
    await flush();
    expect(view.querySelectorAll("li")).toHaveLength(3);
    expect(view.textContent).toContain("対人戦のみ集計");
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

test("ロビーは幅に関わらず公開ルーム・ランキング・最近の対局・大会一覧の順と詳細の選択を保持", async () => {
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
    const request = requests.find((r) => r.url.includes("/rankings?profilePreview=1"))!;
    request.respond(rankings);
    await flush();
    const ranking = view.querySelector<HTMLElement>(
      'section[aria-labelledby="lobby-rankings-title"]',
    )!;
    const roomSection = view.querySelector('section[aria-label="公開部屋"]')!.parentElement!;
    const recentSection = view.querySelector('section[aria-labelledby="recent-matches-title"]')!;
    const tournamentSection = view.querySelector(
      'section[aria-labelledby="tournament-list-four-shogi-title"]',
    )!.parentElement!;
    const sectionOrder = () => [...ranking.parentElement!.children];
    function expectSectionOrder() {
      const sections = sectionOrder();
      expect(sections).toHaveLength(4);
      [roomSection, ranking, recentSection, tournamentSection].forEach((section, index) => {
        expect(sections[index]).toBe(section);
      });
    }
    expectSectionOrder();
    press(ranking, "もっと見る");
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    act(() => dialog.querySelector<HTMLElement>('[role="tab"][id$="doubles"]')!.click());
    await flush();
    const count = requests.length;
    mobile = true;
    act(() => media.dispatchEvent(new Event("change")));
    await flush();
    expect(requests).toHaveLength(count);
    expect(view.querySelector('section[aria-labelledby="lobby-rankings-title"]')).toBe(ranking);
    expect(dialog.querySelector('[role="tab"][id$="doubles"]')!.getAttribute("aria-selected")).toBe(
      "true",
    );
    expectSectionOrder();
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

test("公開ルームは実アバター・CPU・空席と総数を示し、3件から全件へ展開できる", async () => {
  const { LobbyList } = await import("../src/features/lobby/LobbyList");
  const requestedImages: HTMLImageElement[] = [];
  const NativeImage = window.Image;
  const descriptor = Object.getOwnPropertyDescriptor(window, "Image")!;
  Object.defineProperty(window, "Image", {
    configurable: true,
    value: function () {
      const image = new NativeImage();
      requestedImages.push(image);
      return image;
    },
  });
  try {
    const rooms = Array.from({ length: 25 }, (_, index) => ({
      id: String(12345 + index),
      instanceId: "11111111-1111-4111-8111-111111111111",
      game: "four-reversi" as const,
      mode: "singles" as const,
      timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 } as const,
      status: "waiting" as const,
      hostName: `ホスト${index}`,
      hostAvatarUrl: null,
      humanCount: 1,
      cpuCount: 1,
      capacity: 4 as const,
      openSeats: 2,
      updatedAtMs: 1,
      participants: [
        {
          kind: "human" as const,
          avatarUrl: "/api/avatars/11111111-1111-4111-8111-111111111111",
          profileTarget: null,
        },
        { kind: "cpu" as const, level: 2 as const },
      ],
    }));
    const view = render(
      wrap()(
        <LobbyList
          game="four-reversi"
          rooms={rooms}
          totalCount={25}
          error={null}
          loading={false}
          isInitialLoading={false}
          onRefresh={() => {}}
          onJoin={() => {}}
          onWatch={() => {}}
        />,
      ),
    );
    await flush();
    const list = view.querySelector('ul[aria-label="公開ルーム一覧"]')!;
    expect(list.children).toHaveLength(3);
    const first = list.firstElementChild!;
    expect(first.querySelector('[role="group"]')!.getAttribute("aria-label")).toBe(
      "人間1人、CPU1人、空席2席",
    );
    expect(first.querySelectorAll('[data-testid="player-avatar"]')).toHaveLength(2);
    expect(
      requestedImages.some((image) =>
        image.src.endsWith("/api/avatars/11111111-1111-4111-8111-111111111111"),
      ),
    ).toBe(true);
    expect(first.textContent).toContain("ホスト0の部屋");
    expect(first.textContent).toContain("05:00 / 00:30");
    press(view, "すべてのルームを見る（25部屋）");
    expect(list.children).toHaveLength(25);
    list.parentElement!.scrollTop = 100;
    press(view, "シングルス");
    expect(list.children).toHaveLength(3);
    expect(list.parentElement!.scrollTop).toBe(0);
    press(view, "すべてのルームを見る（25部屋）");
    expect(
      [...view.querySelectorAll("button")].some((button) => button.textContent === "もっと見る"),
    ).toBe(false);
    press(view, "ルームを折りたたむ");
    expect(list.children).toHaveLength(3);
  } finally {
    Object.defineProperty(window, "Image", descriptor);
  }
});
