import { expect, test } from "bun:test";
import { Link, Route, Routes, useLocation } from "react-router";
import type { TournamentDetail, TournamentParticipation } from "@tetraboard/protocol";
import {
  legalAcknowledgement,
  legalVersion,
  publicRecordNotice,
} from "@tetraboard/protocol/privacy";
import { TournamentPage } from "../src/features/tournaments/TournamentPage";
import { TournamentEntrance } from "../src/features/tournaments/TournamentEntrance";
import { readRegistrationReturn } from "../src/features/account/registrationReturn";
import { readRoomMembershipToken } from "../src/shared/roomMembership";
import { readTournamentQueue } from "../src/features/tournaments/tournamentQueueStorage";
import { profile } from "../test/fixtures/account";
import { act, clock, denyStorage, flush, press, render, rerender, requests, wrap } from "./harness";

const player = {
  rank: 1,
  username: "tetra",
  name: "あいうえおかきくけこ",
  avatarUrl: null,
  pointsUnits: 84,
  games: 2,
  first: 2,
  second: 0,
  third: 0,
  fourth: 0,
  knockouts: 3,
  rankSum: 2,
};
function detail(status: TournamentDetail["tournament"]["status"] = "upcoming"): TournamentDetail {
  return {
    nextTournament: null,
    tournament: {
      id: 1,
      name: "四人将棋大会",
      description: "大会の説明\n次の行",
      rulesDescription: "今回のご案内",
      startsAtMs: Date.now() + 3600000,
      endsAtMs: Date.now() + 7200000,
      status,
      entryCount: 8,
      waitingCount: 2,
      playingCount: 1,
      pendingCount: 0,
      completedCount: status === "finished" ? 1 : 0,
      ruleVersion: 1,
      finalizedAtMs: status === "finished" ? Date.now() : null,
    },
    standings: status === "upcoming" ? [] : [player],
    self:
      status === "upcoming"
        ? null
        : { ...player, username: profile.username, name: profile.name, self: true, rank: 6 },
    nextCursor: null,
  };
}
function Path() {
  return <p data-path>{useLocation().pathname}</p>;
}
function page(
  user: typeof profile | null = profile,
  entry: string | { pathname: string; state: unknown } = "/tournaments/1",
) {
  return render(
    wrap(
      user,
      entry,
    )(
      <>
        <Routes>
          <Route path="/tournaments/:id" element={<TournamentPage />} />
          <Route
            path="*"
            element={
              <>
                <Path />
                <Link to="/tournaments/1">大会に戻る</Link>
              </>
            }
          />
        </Routes>
        <Path />
      </>,
    ),
  );
}
async function respond(
  state = detail(),
  participation: TournamentParticipation = { entered: true, status: "idle" },
) {
  for (const request of requests.filter((request) => !request.init.signal?.aborted)) {
    if (request.url === "/api/tournaments/1") request.respond(state);
    if (request.url === "/api/tournaments/1/participation") request.respond(participation);
  }
  await flush();
}
function expectConsent(note: Element) {
  expect(note.getAttribute("role")).toBe("note");
  expect(note.textContent).toContain(legalAcknowledgement);
  expect(note.textContent).toContain(publicRecordNotice);
  for (const path of ["/terms", "/privacy"])
    expect(note.querySelector(`a[href="${path}"]`)?.getAttribute("target")).toBe("_blank");
  expect(note.querySelector('input[type="checkbox"]')).toBeNull();
}
function expectConsentBefore(button: Element) {
  expectConsent(button.previousElementSibling!);
}

test("エントリー直前に既存の規約・年齢・棋譜公開説明と文書リンクを出し、現行同意版を送る", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail(), { entered: false, status: "idle" });
  const button = [...view.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === "エントリー",
  )!;
  expectConsentBefore(button);
  press(view, "エントリー");
  await flush();
  const entry = requests.find(
    (request) => request.url.endsWith("/entries") && request.init.method === "POST",
  )!;
  expect(new Headers(entry.init.headers).get("X-Legal-Consent")).toBe(legalVersion);
});

test("開催前は人数を大きく右側へ置き、名簿・本人の成績・順位表を表示しない", async () => {
  const view = page();
  clock.advance(0);
  await respond();
  expect(view.textContent).toContain("エントリー済み");
  expect(view.textContent).not.toContain("大会成績");
  expect(view.textContent).not.toContain("順位表");
  expect(view.querySelector("strong.text-\\[36px\\]")?.textContent).toBe("8");
  expect(view.textContent).toContain("今回のご案内");
  expect(view.textContent).toContain("持ち時間なし・秒読み30秒");
});
test("開催中は対局操作と本人の成績を左、全成績列を右に置き、10文字の名前を省略しない", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail("active"));
  expect(view.textContent).toContain(`${profile.name}さんの大会成績`);
  expect(view.textContent).toContain("あいうえおかきくけこ");
  const table = view.querySelector("table")!;
  expect(table.querySelectorAll("thead th").length).toBe(10);
  expect(table.textContent).toContain("優勝数");
  expect(table.textContent).toContain("4位数");
  expect(table.textContent).toContain("7");
  expect(view.textContent).not.toContain("成績の内訳");
  expect(
    [...view.querySelectorAll("button")].some((button) => button.textContent === "対戦相手を探す"),
  ).toBe(false);
  const name = [...table.querySelectorAll("span")].find(
    (element) =>
      element.textContent === player.name && element.classList.contains("whitespace-nowrap"),
  );
  expect(name?.classList.contains("min-w-[10em]")).toBe(true);
});
test("対局するは保存した資格で待機へ入り、待機中は取り消すへ変化する", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail("active"));
  expectConsentBefore(
    [...view.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "対局する",
    )!,
  );
  press(view, "対局する");
  await flush();
  const queue = requests.find(
    (request) => request.url.endsWith("/queue") && request.init.method === "POST",
  )!;
  const credential = JSON.parse(queue.init.body as string);
  expect(new Headers(queue.init.headers).get("X-Legal-Consent")).toBe(legalVersion);
  expect(credential.token).toMatch(/^[0-9a-f]{64}$/);
  expect(readTournamentQueue(1, profile.username!)?.token).toBe(credential.token);
  queue.respond({ entered: true, status: "waiting" });
  await flush();
  await respond(detail("active"), {
    entered: true,
    status: "waiting",
    operationId: credential.operationId,
  });
  expect(view.textContent).toContain("対戦相手を探しています...");
  press(view, "取り消す");
  await flush();
  const cancellation = requests.find(
    (request) => request.url.endsWith("/queue") && request.init.method === "DELETE",
  )!;
  expect(JSON.parse(cancellation.init.body as string)).toEqual({
    operationId: credential.operationId,
  });
  cancellation.respond({ entered: true, status: "idle" });
  await flush();
  expect(readTournamentQueue(1, profile.username!)).toBeNull();
});
test("保存不可なら対局資格を送信せず説明する", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail("active"));
  const denied = denyStorage();
  try {
    press(view, "対局する");
    await flush();
    expect(requests.some((request) => request.init.method === "POST")).toBe(false);
    expect(view.textContent).toContain("対局の参加資格を保存できません");
  } finally {
    denied.mockRestore();
  }
});
test("参加確認を経て、保管した資格をルームへ移して遷移する", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail("active"));
  press(view, "対局する");
  await flush();
  const queue = requests.find(
    (request) => request.url.endsWith("/queue") && request.init.method === "POST",
  )!;
  const credential = JSON.parse(queue.init.body as string);
  queue.respond({ entered: true, status: "waiting" });
  await flush();
  const matchId = "00000000-0000-4000-8000-000000000011";
  await respond(detail("active"), {
    entered: true,
    status: "confirming",
    operationId: credential.operationId,
    matchId,
    confirmed: false,
    confirmedCount: 2,
    expiresAtMs: Date.now() + 30000,
  });
  expectConsentBefore(
    [...view.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "参加する",
    )!,
  );
  press(view, "参加する");
  await flush();
  const confirmation = requests.find((request) => request.url.endsWith("/confirmation"))!;
  expect(new Headers(confirmation.init.headers).get("X-Legal-Consent")).toBe(legalVersion);
  expect(JSON.parse(confirmation.init.body as string)).toEqual({
    operationId: credential.operationId,
    matchId,
    accept: true,
  });
  confirmation.respond({});
  await flush();
  await respond(detail("active"), {
    entered: true,
    status: "matched",
    operationId: credential.operationId,
    roomId: "12345",
    instanceId: matchId,
  });
  expect(readRoomMembershipToken("12345")).toBe(credential.token);
  expect(readTournamentQueue(1, profile.username!)).toEqual(credential);
  expect(view.querySelector("[data-path]")?.textContent).toBe("/rooms/12345");
});

test("接続不成立で待機へ戻っても同じ操作・資格で継続し、再配信されたルームへ入れる", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail("active"));
  press(view, "対局する");
  await flush();
  const queue = requests.find(
    (request) => request.url.endsWith("/queue") && request.init.method === "POST",
  )!;
  const credential = JSON.parse(queue.init.body as string);
  queue.respond({});
  await flush();
  await respond(detail("active"), {
    entered: true,
    status: "matched",
    operationId: credential.operationId,
    roomId: "12345",
    instanceId: "00000000-0000-4000-8000-000000000011",
  });
  expect(readRoomMembershipToken("12345")).toBe(credential.token);
  expect(readTournamentQueue(1, profile.username!)).toEqual(credential);
  act(() => view.querySelector<HTMLAnchorElement>('a[href="/tournaments/1"]')!.click());
  await flush();
  clock.advance(0);
  await respond(detail("active"), {
    entered: true,
    status: "waiting",
    operationId: credential.operationId,
  });
  expect(view.textContent).toContain("対戦相手を探しています...");
  clock.advance(10_000);
  await flush();
  const heartbeat = requests.find(
    (request) => request.url.endsWith("/queue") && request.init.method === "PATCH",
  )!;
  expect(JSON.parse(heartbeat.init.body as string)).toEqual({
    operationId: credential.operationId,
  });
  await respond(detail("active"), {
    entered: true,
    status: "matched",
    operationId: credential.operationId,
    roomId: "23456",
    instanceId: "00000000-0000-4000-8000-000000000012",
  });
  expect(readRoomMembershipToken("23456")).toBe(credential.token);
  expect(readTournamentQueue(1, profile.username!)).toEqual(credential);
  expect(view.querySelector("[data-path]")?.textContent).toBe("/rooms/23456");
  expect(
    requests.filter((request) => request.url.endsWith("/queue") && request.init.method === "POST"),
  ).toHaveLength(1);
  expect(requests.some((request) => request.init.method === "DELETE")).toBe(false);
});
test("集計中は同じ配置で受付終了を示し、結果確定後は同率優勝を全員表彰する", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail("settling"));
  expect(view.textContent).toContain("対局受付終了");
  expect(view.textContent).toContain("順位表");
  expect(view.textContent).toContain(`${profile.name}さんの大会成績`);
  const completed = detail("finished");
  completed.standings.push({ ...player, username: "other", name: "ふたりめ" });
  clock.advance(5000);
  await respond(completed);
  const awards = view.querySelector('[aria-label="大会の表彰"]')!;
  expect(awards.textContent).toContain("あいうえおかきくけこ");
  expect(awards.textContent).toContain("ふたりめ");
  expect(awards.textContent?.match(/同率優勝/g)?.length).toBe(2);
});
test("全員を見るはページを取得し、未対局者も表示する", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail("active"));
  press(view, "全員を見る");
  clock.advance(0);
  await flush();
  requests
    .find((request) => request.url.endsWith("/standings?all=1"))!
    .respond({
      standings: [{ ...player, rank: null, games: 0, name: "まだ未対局" }],
      self: null,
      nextCursor: "page2",
    });
  await flush();
  expect(view.textContent).toContain("まだ未対局");
  press(view, "もっと見る");
  await flush();
  requests
    .find((request) => request.url.endsWith("cursor=page2"))!
    .respond({
      standings: [{ ...player, username: "next", name: "次のページ" }],
      self: null,
      nextCursor: null,
    });
  await flush();
  expect(view.textContent).toContain("次のページ");
});
test("表示取得の失敗は0人に置き換えず、再取得できる", async () => {
  const view = page(null);
  clock.advance(0);
  requests
    .find((request) => request.url === "/api/tournaments/1")!
    .respond({ message: "取得失敗" }, 503);
  await flush();
  expect(view.textContent).toContain("取得失敗");
  expect(view.textContent).not.toContain("0人");
  press(view, "再取得");
  await respond(detail("active"));
  expect(view.textContent).toContain("あいうえおかきくけこ");
});
test("入口のエントリー操作からだけ参加意図を保存し、ログインへ進む", async () => {
  const view = page(null, {
    pathname: "/tournaments/1",
    state: { tournamentEntryRequested: true },
  });
  clock.advance(0);
  await respond();
  clock.advance(0);
  await flush();
  expect(readRegistrationReturn()?.tournamentEntry).toBe(1);
  expect(view.querySelector("[data-path]")?.textContent).toBe("/login");
});
test("OAuth復帰時に受付終了なら自動エントリーしない", async () => {
  const view = page(profile, {
    pathname: "/tournaments/1",
    state: {
      registrationReturn: {
        path: "/tournaments/1",
        createdAt: Date.now(),
        oauthStarted: true,
        tournamentEntry: 1,
      },
    },
  });
  clock.advance(0);
  await respond(detail("settling"));
  clock.advance(0);
  await flush();
  expect(view.textContent).toContain("エントリー受付は終了しました");
  expect(requests.some((request) => request.url.endsWith("/entries"))).toBe(false);
});
test("ロビー入口は公開情報を取得し、開催中の案内と実人数を表示する", async () => {
  const view = render(wrap(null)(<TournamentEntrance />));
  clock.advance(0);
  requests
    .find((request) => request.url === "/api/tournaments/lobby")!
    .respond({ tournament: detail("active").tournament });
  await flush();
  expect(view.textContent).toContain("現在8人がエントリー中");
  expect(view.textContent).toContain("ログインまたは登録してエントリー");
  expect(view.querySelector('a[href="/tournaments/1"]')).not.toBeNull();
  expectConsent(view.querySelector('[aria-label="四人将棋大会"]')!.firstElementChild!);
});

test("表示は5秒ごとに更新し、非表示では停止、再表示で取得する", async () => {
  page();
  clock.advance(0);
  await respond(detail("active"));
  const count = () => requests.filter((request) => request.url === "/api/tournaments/1").length;
  expect(count()).toBe(1);
  clock.advance(4999);
  expect(count()).toBe(1);
  clock.advance(1);
  expect(count()).toBe(2);
  await respond(detail("active"));
  const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    clock.advance(10000);
    expect(count()).toBe(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(count()).toBe(3);
  } finally {
    if (original) Object.defineProperty(document, "visibilityState", original);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});
test("待機継続は10秒で送信し、ページを離れると同じ操作IDで待機を解除する", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail("active"));
  press(view, "対局する");
  await flush();
  const queue = requests.find(
    (request) => request.url.endsWith("/queue") && request.init.method === "POST",
  )!;
  const credential = JSON.parse(queue.init.body as string);
  queue.respond({});
  await flush();
  await respond(detail("active"), {
    entered: true,
    status: "waiting",
    operationId: credential.operationId,
  });
  clock.advance(10000);
  await flush();
  const heartbeat = requests.find((request) => request.init.method === "PATCH")!;
  expect(JSON.parse(heartbeat.init.body as string)).toEqual({
    operationId: credential.operationId,
  });
  act(() => window.dispatchEvent(new Event("pagehide")));
  const cancellation = requests.find((request) => request.init.method === "DELETE")!;
  expect(cancellation.init.keepalive).toBe(true);
  expect(JSON.parse(cancellation.init.body as string)).toEqual({
    operationId: credential.operationId,
  });
});
test("アカウントだけで成立した席の資格を再発行せず、既存タブへの案内を出す", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail("active"), {
    entered: true,
    status: "matched",
    operationId: "00000000-0000-4000-8000-000000000011",
    roomId: "12345",
    instanceId: "00000000-0000-4000-8000-000000000012",
  });
  expect(readRoomMembershipToken("12345")).toBeNull();
  expect(view.textContent).toContain("参加資格を保存したタブ");
  expect(requests.some((request) => request.init.method === "POST")).toBe(false);
});
test("通常ログインの大会復帰では自動エントリーしない", async () => {
  page(profile, {
    pathname: "/tournaments/1",
    state: {
      registrationReturn: { path: "/tournaments/1", createdAt: Date.now(), oauthStarted: true },
    },
  });
  clock.advance(0);
  await respond(detail("active"));
  clock.advance(0);
  await flush();
  expect(requests.some((request) => request.url.endsWith("/entries"))).toBe(false);
});
test("結果確定後は公開済みの次回大会を案内する", async () => {
  const view = page();
  clock.advance(0);
  const state = detail("finished");
  state.nextTournament = { ...state.tournament, id: 2, name: "次回の大会", status: "upcoming" };
  await respond(state);
  expect(view.querySelector('a[href="/tournaments/2"]')?.textContent).toBe("次回大会の詳細へ");
});

test("アカウント切替後の取得失敗では前の本人の成績と参加状態を表示しない", async () => {
  const tree = (user: typeof profile) =>
    wrap(
      user,
      "/tournaments/1",
    )(
      <Routes>
        <Route path="/tournaments/:id" element={<TournamentPage />} />
      </Routes>,
    );
  const view = render(tree(profile));
  clock.advance(0);
  await respond(detail("active"));
  expect(view.textContent).toContain(`${profile.name}さんの大会成績`);
  rerender(view, tree({ ...profile, username: "anotheruser", name: "別の人" }));
  clock.advance(0);
  for (const request of requests.filter((request) => !request.init.signal?.aborted)) {
    if (request.url === "/api/tournaments/1") request.respond({ message: "切替後の取得失敗" }, 503);
    if (request.url.endsWith("/participation")) request.respond({ entered: false, status: "idle" });
  }
  await flush();
  expect(view.textContent).toContain("切替後の取得失敗");
  expect(view.textContent).not.toContain(`${profile.name}さんの大会成績`);
  expect(view.textContent).not.toContain("対局する");
});
