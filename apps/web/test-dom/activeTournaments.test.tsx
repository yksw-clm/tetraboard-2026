import { expect, test } from "bun:test";
import { Link } from "react-router";
import type { TournamentPublic } from "@tetraboard/protocol";
import { ActiveTournamentProvider } from "../src/features/tournaments/ActiveTournamentProvider";
import { ActiveTournamentsContext } from "../src/features/tournaments/useActiveTournaments";
import { ActiveTournamentNotice } from "../src/features/tournaments/ActiveTournamentNotice";
import { AppHeader } from "../src/shared/ui/AppHeader";
import { GeneralLobbyPage } from "../src/features/lobby/GeneralLobbyPage";
import { act, clock, flush, render, requests, wrap } from "./harness";

function tournament(id = 1, now = Date.now(), ends = 120000): TournamentPublic {
  return {
    id,
    name: `四人将棋大会${id}`,
    description: "",
    rulesDescription: "",
    status: "active",
    startsAtMs: now - 1000,
    endsAtMs: now + ends,
    entryCount: 10,
    waitingCount: 0,
    playingCount: 0,
    pendingCount: 0,
    completedCount: 0,
    ruleVersion: 1,
    finalizedAtMs: null,
  };
}
function page(entry = "/") {
  return render(
    wrap(
      null,
      entry,
    )(
      <ActiveTournamentProvider>
        <AppHeader homeTo="/" homeLabel="ホーム" />
        <ActiveTournamentNotice />
        <Link to="/rooms/12345">対局画面へ</Link>
      </ActiveTournamentProvider>,
    ),
  );
}
const loads = () => requests.filter((request) => request.url.includes("/api/tournaments/lobby?"));

test("ヘッダーの大会リンクは大会ページの移動制御を通し、修飾クリックを妨げない", () => {
  const navigations: string[] = [];
  const view = render(
    wrap(
      null,
      "/tournaments/1",
    )(
      <ActiveTournamentsContext value={{ tournaments: [tournament(2)], serverNowMs: Date.now() }}>
        <AppHeader homeTo="/" homeLabel="ホーム" onNavigate={(to) => navigations.push(to)} />
      </ActiveTournamentsContext>,
    ),
  );
  const link = view.querySelector<HTMLAnchorElement>('header a[href="/tournaments/2"]')!;
  act(() => link.click());
  expect(navigations).toEqual(["/tournaments/2"]);
  act(() =>
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })),
  );
  expect(navigations).toEqual(["/tournaments/2"]);
});
async function respond(current: TournamentPublic[], serverTimeMs = Date.now()) {
  loads().at(-1)!.respond({ current, upcoming: [], serverTimeMs });
  await flush();
}

test("ホームでは説明文とゲーム一覧の間に案内を置き、ヘッダーと取得を共用する", async () => {
  const view = render(
    wrap()(
      <ActiveTournamentProvider>
        <GeneralLobbyPage />
      </ActiveTournamentProvider>,
    ),
  );
  clock.advance(0);
  await respond([tournament()]);
  expect(loads()).toHaveLength(1);
  const main = view.querySelector("main")!;
  const notice = main.querySelector('[aria-label="開催中の大会"]')!;
  expect(notice.previousElementSibling!.textContent).toContain("オンラインボードゲームサイト");
  expect(notice.nextElementSibling!.getAttribute("aria-labelledby")).toBe("game-list-title");
  const headerLink = view.querySelector('header a[href="/tournaments/1"]')!;
  expect(headerLink.textContent).toBe("大会開催中");
  expect(headerLink.nextElementSibling?.textContent).toContain("登録・ログイン");
  expect(notice.textContent).toContain("四人将棋大会1開催中終了まであと2分");
  expect(notice.querySelector('a[href="/tournaments/1"]')?.textContent).toContain("大会詳細");
});

test("サーバー時刻で開催中だけ表示し、複数件を保持してヘッダーへ件数を示す", async () => {
  const view = page();
  clock.advance(0);
  const server = Date.now() - 86400000;
  await respond(
    [
      tournament(1, server),
      tournament(2, server),
      { ...tournament(3, server), status: "settling" },
      { ...tournament(4, server), startsAtMs: server + 1000 },
      tournament(5, server, 0),
    ],
    server,
  );
  expect(view.querySelectorAll('[aria-label="開催中の大会"] h2')).toHaveLength(2);
  expect(view.querySelector('header a[href="/tournaments/1"]')?.textContent).toBe("大会開催中+1");
  expect(view.textContent).toContain("終了まであと2分");
});

test("通信失敗中も時刻が進み、終了時刻からホームとヘッダーの両方を消す", async () => {
  const view = page();
  clock.advance(0);
  await respond([tournament(1, Date.now(), 6500)]);
  clock.advance(5000);
  loads().at(-1)!.reject();
  await flush();
  expect(view.querySelector('[aria-label="開催中の大会"]')).not.toBeNull();
  clock.advance(1500);
  await flush();
  expect(view.querySelector('[aria-label="開催中の大会"]')).toBeNull();
  expect(view.querySelector('header a[href="/tournaments/1"]')).toBeNull();
});

test("初回失敗では表示せず再取得で回復し、非表示で中断・復帰時に期限を再確認する", async () => {
  const view = page();
  clock.advance(0);
  loads()[0]!.reject();
  await flush();
  expect(view.textContent).not.toContain("大会開催中");
  clock.advance(5000);
  await respond([tournament(1, Date.now(), 6000)]);
  act(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const count = loads().length;
  clock.advance(10000);
  expect(loads()).toHaveLength(count);
  act(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush();
  expect(loads()).toHaveLength(count + 1);
  expect(view.querySelector('[aria-label="開催中の大会"]')).toBeNull();
});

test("対局画面へ移ると取得を中止し、古い応答で案内を復活させない", async () => {
  const view = page();
  clock.advance(0);
  act(() => view.querySelector<HTMLAnchorElement>('a[href="/rooms/12345"]')!.click());
  await flush();
  expect(loads()[0]!.init.signal!.aborted).toBe(true);
  await respond([tournament()]);
  clock.advance(10000);
  expect(loads()).toHaveLength(1);
  expect(view.textContent).not.toContain("大会開催中");
});
