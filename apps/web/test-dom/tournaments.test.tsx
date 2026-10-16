import { expect, test } from "bun:test";
import { Link, Route, Routes, useLocation } from "react-router";
import type {
  TournamentDetail,
  TournamentParticipation as FullParticipation,
} from "@tetraboard/protocol";
import {
  legalAcknowledgement,
  legalVersion,
  publicRecordNotice,
} from "@tetraboard/protocol/privacy";
import { TournamentPage } from "../src/features/tournaments/TournamentPage";
import { TournamentEntrance } from "../src/features/tournaments/TournamentEntrance";
import { readRegistrationReturn } from "../src/features/account/registrationReturn";
import { readRoomMembershipToken } from "../src/shared/roomMembership";
import {
  createTournamentQueue,
  readTournamentQueue,
  saveTournamentQueue,
} from "../src/features/tournaments/tournamentQueueStorage";
import {
  TournamentControllerContext,
  TournamentDocumentController,
  tournamentDocumentController,
} from "../src/features/tournaments/tournamentController";
import { profile } from "../test/fixtures/account";
import { act, clock, denyStorage, flush, press, render, rerender, requests, wrap } from "./harness";

type TournamentParticipation = Omit<FullParticipation, "controller" | "controllerVersion"> &
  Partial<Pick<FullParticipation, "controller" | "controllerVersion">>;
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
  controller = tournamentDocumentController,
) {
  return render(
    <TournamentControllerContext value={controller}>
      {wrap(
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
      )}
    </TournamentControllerContext>,
  );
}

async function completeRoomClaim(token: string) {
  const request = requests.filter((request) => request.url.endsWith("/controller")).at(-1);
  if (!request) return;
  const body = JSON.parse(request.init.body as string);
  // テストごとの最新参加応答を引継ぎ要求と同じ席として返します。
  const participation = latestParticipation;
  request.respond({
    participation: {
      controller: "self",
      controllerVersion: 1,
      ...participation,
      operationId: body.operationId,
    },
    token,
  });
  await flush();
}
let latestParticipation: TournamentParticipation = { entered: true, status: "idle" };

async function respond(
  state = detail(),
  participation: TournamentParticipation = { entered: true, status: "idle" },
) {
  latestParticipation = participation;
  for (const request of requests.filter((request) => !request.init.signal?.aborted)) {
    if (request.url === "/api/tournaments/1") request.respond(state);
    if (request.url === "/api/tournaments/1/participation")
      request.respond({
        controller: participation.status === "idle" ? "none" : "self",
        controllerVersion: participation.status === "idle" ? 0 : 1,
        ...participation,
      });
  }
  await flush();
}
async function startQueue(view: HTMLElement) {
  press(view, "対局する");
  await flush();
  const request = requests
    .filter((request) => request.url.endsWith("/queue") && request.init.method === "POST")
    .at(-1)!;
  const credential = JSON.parse(request.init.body as string) as {
    operationId: string;
    token: string;
    controllerId: string;
  };
  request.respond({});
  await flush();
  return credential;
}
function expectConsent(note: Element) {
  expect(note.getAttribute("role")).toBe("note");
  expect(note.textContent).toContain(legalAcknowledgement);
  expect(note.textContent).toContain(publicRecordNotice);
  for (const path of ["/terms", "/privacy"])
    expect(note.querySelector(`a[href="${path}"]`)?.getAttribute("target")).toBe("_blank");
  expect(note.querySelector('input[type="checkbox"]')).toBeNull();
}
test("エントリーはdialogの説明を確認して最終操作した時だけ現行同意版で送る", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail(), { entered: false, status: "idle" });
  expect(view.querySelector('[role="note"]')).toBeNull();
  press(view, "エントリー");
  await flush();
  const dialog = document.querySelector('[role="dialog"]')!;
  expectConsent(dialog.querySelector('[role="note"]')!);
  expect(requests.some((request) => request.url.endsWith("/entries"))).toBe(false);
  press(document.body, "エントリーする");
  await flush();
  const entry = requests.find(
    (request) => request.url.endsWith("/entries") && request.init.method === "POST",
  )!;
  expect(new Headers(entry.init.headers).get("X-Legal-Consent")).toBe(legalVersion);
});

test("エントリーdialogを閉じても登録せず、同じ復帰意図で再表示しない", async () => {
  const view = page(profile, {
    pathname: "/tournaments/1",
    state: { tournamentEntryRequested: true },
  });
  clock.advance(0);
  await respond(detail(), { entered: false, status: "idle" });
  clock.advance(0);
  await flush();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  act(() =>
    document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="閉じる"]')!.click(),
  );
  await flush();
  clock.advance(5000);
  await respond(detail(), { entered: false, status: "idle" });
  clock.advance(0);
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(requests.some((request) => request.url.endsWith("/entries"))).toBe(false);
  press(view, "エントリー");
  await flush();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
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
  expect(view.querySelector('[role="note"]')).toBeNull();
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
    controllerId: credential.controllerId,
    controllerVersion: 1,
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
test("対戦成立dialogを表示し、同じmatchedの再取得で遅延せず5秒後に資格を保存して入室する", async () => {
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
  clock.advance(1000);
  const participation: TournamentParticipation = {
    entered: true,
    status: "matched",
    operationId: credential.operationId,
    matchId: "00000000-0000-4000-8000-000000000011",
    roomId: "12345",
    instanceId: "00000000-0000-4000-8000-000000000012",
  };
  await respond(detail("active"), participation);
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("対戦相手が集まりました");
  expect(
    [...dialog.querySelectorAll("button")].map((button) => button.textContent?.trim()),
  ).toEqual(["入室する"]);
  expect(readRoomMembershipToken("12345")).toBeNull();
  clock.advance(4000);
  await respond(detail("active"), participation);
  clock.advance(999);
  await flush();
  expect(view.querySelector("[data-path]")?.textContent).toBe("/tournaments/1");
  clock.advance(1);
  await flush();
  await completeRoomClaim(credential.token);
  expect(readRoomMembershipToken("12345")).toBe(credential.token);
  expect(readTournamentQueue(1, profile.username!)).toEqual({
    operationId: credential.operationId,
    token: credential.token,
    controllerVersion: 1,
  });
  expect(view.querySelector("[data-path]")?.textContent).toBe("/rooms/12345");
  expect(requests.some((request) => request.url.endsWith("/confirmation"))).toBe(false);
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
  press(document.body, "入室する");
  await flush();
  await completeRoomClaim(credential.token);
  expect(readRoomMembershipToken("12345")).toBe(credential.token);
  expect(readTournamentQueue(1, profile.username!)).toEqual({
    operationId: credential.operationId,
    token: credential.token,
    controllerVersion: 1,
  });
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
    controllerId: credential.controllerId,
    controllerVersion: 1,
  });
  await respond(detail("active"), {
    entered: true,
    status: "matched",
    operationId: credential.operationId,
    roomId: "23456",
    instanceId: "00000000-0000-4000-8000-000000000012",
  });
  press(document.body, "入室する");
  await flush();
  await completeRoomClaim(credential.token);
  expect(readRoomMembershipToken("23456")).toBe(credential.token);
  expect(readTournamentQueue(1, profile.username!)).toEqual({
    operationId: credential.operationId,
    token: credential.token,
    controllerVersion: 1,
  });
  await completeRoomClaim(credential.token);
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
  expect(view.querySelector('[role="note"]')).toBeNull();
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
test("待機継続は10秒で送信し、pagehideでは再読み込みに備え待機を解除しない", async () => {
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
    controllerId: credential.controllerId,
    controllerVersion: 1,
  });
  act(() => window.dispatchEvent(new Event("pagehide")));
  expect(requests.some((request) => request.init.method === "DELETE")).toBe(false);
});
test("操作していないタブは勝手に席を引き継がず、明示操作を案内する", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail("active"), {
    entered: true,
    status: "matched",
    operationId: "00000000-0000-4000-8000-000000000011",
    controller: "other",
    controllerVersion: 1,
    roomId: "12345",
    instanceId: "00000000-0000-4000-8000-000000000012",
  });
  expect(readRoomMembershipToken("12345")).toBeNull();
  expect(view.textContent).toContain("別のタブでマッチング中");
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

test("OAuth復帰は期限を再確認してエントリーdialogを開くだけとし、最終操作まで登録しない", async () => {
  page(profile, {
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
  await respond(detail("active"), { entered: false, status: "idle" });
  clock.advance(0);
  await flush();
  expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("エントリーする");
  expect(requests.some((request) => request.url.endsWith("/entries"))).toBe(false);
  press(document.body, "エントリーする");
  await flush();
  expect(requests.filter((request) => request.url.endsWith("/entries"))).toHaveLength(1);
});

test("エントリーdialogを開いた後に締切を過ぎたら正式POSTを送らない", async () => {
  const view = page();
  clock.advance(0);
  const event = detail("active");
  event.tournament.endsAtMs = Date.now() + 1000;
  await respond(event, { entered: false, status: "idle" });
  press(view, "エントリーして参加");
  await flush();
  clock.advance(1001);
  press(document.body, "エントリーする");
  await flush();
  expect(requests.some((request) => request.url.endsWith("/entries"))).toBe(false);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "エントリー受付は終了しました",
  );
});

test("成立dialogから別ページへ移動したら待機を解除し、5秒後の旧入室を実行しない", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail("active"));
  const credential = await startQueue(view);
  await respond(detail("active"), {
    entered: true,
    status: "matched",
    operationId: credential.operationId,
    matchId: "00000000-0000-4000-8000-000000000011",
    roomId: "12345",
    instanceId: "00000000-0000-4000-8000-000000000012",
  });
  press(view, "四人将棋ロビーへ");
  await flush();
  const cancel = requests.find(
    (request) => request.url.endsWith("/queue") && request.init.method === "DELETE",
  )!;
  expect(JSON.parse(cancel.init.body as string)).toEqual({
    operationId: credential.operationId,
    controllerId: credential.controllerId,
    controllerVersion: 1,
  });
  cancel.respond({});
  await flush();
  clock.advance(5000);
  await flush();
  expect(view.querySelector("[data-path]")?.textContent).toBe("/games/four-shogi");
  expect(readRoomMembershipToken("12345")).toBeNull();
});

test("成立取消から再抽選された場合は旧timerを止め、新しい対局の表示から5秒で入室する", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail("active"));
  const credential = await startQueue(view);
  const matched: TournamentParticipation = {
    entered: true,
    status: "matched",
    operationId: credential.operationId,
    matchId: "00000000-0000-4000-8000-000000000011",
    roomId: "12345",
    instanceId: "00000000-0000-4000-8000-000000000012",
  };
  await respond(detail("active"), matched);
  clock.advance(2000);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await respond(detail("active"), {
    entered: true,
    status: "waiting",
    operationId: credential.operationId,
  });
  expect(document.querySelectorAll('[role="dialog"]').length).toBe(0);
  clock.advance(2000);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await respond(detail("active"), {
    ...matched,
    roomId: "23456",
    matchId: "00000000-0000-4000-8000-000000000013",
    instanceId: "00000000-0000-4000-8000-000000000014",
  });
  clock.advance(1000);
  await flush();
  expect(readRoomMembershipToken("12345")).toBeNull();
  expect(view.querySelector("[data-path]")?.textContent).toBe("/tournaments/1");
  clock.advance(4000);
  await flush();
  await completeRoomClaim(credential.token);
  expect(view.querySelector("[data-path]")?.textContent).toBe("/rooms/23456");
});

test("旧公開IDの待機資格をプロフィールIDへ移し、同じ本人の公開ID変更で入室timerを延長しない", async () => {
  const profileId = "00000000-0000-4000-8000-000000000021";
  const credential = createTournamentQueue(1, profile.username!);
  const tree = (user: typeof profile) =>
    wrap(
      user,
      "/tournaments/1",
    )(
      <>
        <Routes>
          <Route path="/tournaments/:id" element={<TournamentPage />} />
          <Route path="*" element={<Path />} />
        </Routes>
        <Path />
      </>,
    );
  tournamentDocumentController.remember(`1:${profileId}`, credential.operationId, 1);
  const view = render(tree({ ...profile, profileId }));
  clock.advance(0);
  const matched: TournamentParticipation = {
    entered: true,
    status: "matched",
    operationId: credential.operationId,
    matchId: "00000000-0000-4000-8000-000000000011",
    roomId: "12345",
    instanceId: "00000000-0000-4000-8000-000000000012",
  };
  await respond(detail("active"), matched);
  expect(readTournamentQueue(1, profileId)).toEqual(credential);
  expect(readTournamentQueue(1, profile.username!)).toBeNull();
  clock.advance(2000);
  rerender(view, tree({ ...profile, profileId, username: "renamedplayer" }));
  await flush();
  expect(requests.some((request) => request.init.method === "DELETE")).toBe(false);
  clock.advance(3000);
  await flush();
  await completeRoomClaim(credential.token);
  expect(view.querySelector("[data-path]")?.textContent).toBe("/rooms/12345");
  await completeRoomClaim(credential.token);
  expect(readRoomMembershipToken("12345")).toBe(credential.token);
});

test.each(["failure-first", "matched-first"] as const)(
  "成立とheartbeat失敗の競合（%s）で旧待機警告を成立dialogに残さない",
  async (order) => {
    const view = page();
    clock.advance(0);
    await respond(detail("active"));
    const credential = await startQueue(view);
    await respond(detail("active"), {
      entered: true,
      status: "waiting",
      operationId: credential.operationId,
    });
    clock.advance(10_000);
    await flush();
    const heartbeat = requests.find(
      (request) => request.url.endsWith("/queue") && request.init.method === "PATCH",
    )!;
    const matched: TournamentParticipation = {
      entered: true,
      status: "matched",
      operationId: credential.operationId,
      matchId: "00000000-0000-4000-8000-000000000011",
      roomId: "12345",
      instanceId: "00000000-0000-4000-8000-000000000012",
    };
    if (order === "failure-first") {
      heartbeat.reject(new Error("heartbeat transition"));
      await flush();
    }
    await respond(detail("active"), matched);
    if (order === "matched-first") {
      heartbeat.reject(new Error("heartbeat transition"));
      await flush();
    }
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
      "待機を継続できませんでした",
    );
  },
);

function documentPair() {
  const held = new Map<string, object>();
  const locks = {
    request: async (
      name: string,
      options: LockOptions,
      callback: (lock: Lock | null) => Promise<void>,
    ) => {
      if (held.has(name) && !options.steal) return callback(null);
      const owner = {};
      held.set(name, owner);
      try {
        await callback({ name, mode: "exclusive" } as Lock);
      } finally {
        if (held.get(name) === owner) held.delete(name);
      }
    },
  } as LockManager;
  return (reload = true) =>
    new TournamentDocumentController({ isReload: () => reload, locks: () => locks });
}
const roomParticipation = (
  operationId: string,
  version = 1,
  status: "matched" | "playing" = "matched",
): FullParticipation => ({
  entered: true,
  status,
  operationId,
  controller: "other",
  controllerVersion: version,
  matchId: "00000000-0000-4000-8000-000000000031",
  roomId: "12345",
  instanceId: "00000000-0000-4000-8000-000000000032",
});
function controllerRequest() {
  return requests.filter((request) => request.url.endsWith("/controller")).at(-1)!;
}

test("待機reloadは生存タブ不在を確認して世代CASで復旧し、pagehideでは取消しない", async () => {
  const controller = documentPair()();
  const credential = createTournamentQueue(1, profile.username!);
  saveTournamentQueue(1, profile.username!, { ...credential, controllerVersion: 1 });
  const view = page(profile, "/tournaments/1", controller);
  clock.advance(0);
  const waiting: FullParticipation = {
    entered: true,
    status: "waiting",
    operationId: credential.operationId,
    controller: "other",
    controllerVersion: 1,
  };
  await respond(detail("active"), waiting);
  await flush();
  const request = controllerRequest();
  expect(JSON.parse(request.init.body as string)).toEqual({
    operationId: credential.operationId,
    controllerId: controller.getIdentity(),
    takeover: true,
    expectedControllerVersion: 1,
  });
  request.respond({
    participation: { ...waiting, controller: "self", controllerVersion: 2 },
    token: "b".repeat(64),
  });
  await flush();
  await respond(detail("active"), { ...waiting, controller: "self", controllerVersion: 2 });
  expect(view.textContent).toContain("対戦相手を探しています...");
  clock.advance(10_000);
  await flush();
  const heartbeat = requests.find((request) => request.init.method === "PATCH")!;
  expect(JSON.parse(heartbeat.init.body as string)).toEqual({
    operationId: credential.operationId,
    controllerId: controller.getIdentity(),
    controllerVersion: 2,
  });
  act(() => window.dispatchEvent(new Event("pagehide")));
  expect(requests.some((request) => request.init.method === "DELETE")).toBe(false);
});

test.each(["matched", "playing"] as const)(
  "%sのreloadは同じ対局へ即座に復帰し、5秒を数え直さない",
  async (status) => {
    const controller = documentPair()();
    const credential = createTournamentQueue(1, profile.username!);
    saveTournamentQueue(1, profile.username!, { ...credential, controllerVersion: 1 });
    const view = page(profile, "/tournaments/1", controller);
    clock.advance(0);
    const participation = roomParticipation(credential.operationId, 1, status);
    await respond(detail("active"), participation);
    await flush();
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(0);
    controllerRequest().respond({
      participation: { ...participation, controller: "self", controllerVersion: 2 },
      token: "c".repeat(64),
    });
    await flush();
    expect(view.querySelector("[data-path]")?.textContent).toBe("/rooms/12345");
    expect(readRoomMembershipToken("12345")).toBe("c".repeat(64));
  },
);

test("複製タブは生存ownerのlockを検知して自動引継ぎせず、明示引継ぎだけ新IDと世代を送る", async () => {
  const make = documentPair();
  const original = make();
  await original.acquire(`1:${profile.username}`);
  const duplicate = make();
  const firstId = duplicate.getIdentity();
  const credential = createTournamentQueue(1, profile.username!);
  const view = page(profile, "/tournaments/1", duplicate);
  clock.advance(0);
  const waiting: FullParticipation = {
    entered: true,
    status: "waiting",
    operationId: credential.operationId,
    controller: "other",
    controllerVersion: 3,
  };
  await respond(detail("active"), waiting);
  await flush();
  expect(view.textContent).toContain("別のタブでマッチング中");
  expect(requests.some((request) => request.url.endsWith("/controller"))).toBe(false);
  clock.advance(10_000);
  expect(requests.some((request) => ["PATCH", "DELETE"].includes(request.init.method ?? ""))).toBe(
    false,
  );
  press(view, "このタブで続ける");
  await flush();
  const request = controllerRequest();
  expect(duplicate.getIdentity()).not.toBe(firstId);
  expect(JSON.parse(request.init.body as string)).toEqual({
    operationId: credential.operationId,
    controllerId: duplicate.getIdentity(),
    takeover: true,
    expectedControllerVersion: 3,
  });
  request.respond({
    participation: { ...waiting, controller: "self", controllerVersion: 4 },
    token: "d".repeat(64),
  });
  await flush();
  await respond(detail("active"), { ...waiting, controller: "self", controllerVersion: 4 });
  expect(view.textContent).toContain("対戦相手を探しています...");
  original.release(`1:${profile.username}`);
  duplicate.release(`1:${profile.username}`);
  await flush();
  expect(await make().acquire(`1:${profile.username}`)).toBe(true);
});

test("引継ぎ成功前の古いGETが後から返っても新しい所有世代とheartbeatを失わない", async () => {
  const controller = documentPair()(false);
  const credential = createTournamentQueue(1, profile.username!);
  const view = page(profile, "/tournaments/1", controller);
  clock.advance(0);
  const waiting: FullParticipation = {
    entered: true,
    status: "waiting",
    operationId: credential.operationId,
    controller: "other",
    controllerVersion: 1,
  };
  await respond(detail("active"), waiting);
  clock.advance(5000);
  const oldRead = requests.filter((request) => request.url.endsWith("/participation")).at(-1)!;
  press(view, "このタブで続ける");
  await flush();
  controllerRequest().respond({
    participation: { ...waiting, controller: "self", controllerVersion: 2 },
    token: "e".repeat(64),
  });
  await flush();
  await respond(detail("active"), { ...waiting, controller: "self", controllerVersion: 2 });
  oldRead.respond(waiting);
  await flush();
  clock.advance(10_000);
  await flush();
  const heartbeat = requests.find((request) => request.init.method === "PATCH")!;
  expect(JSON.parse(heartbeat.init.body as string).controllerVersion).toBe(2);
  expect(view.textContent).toContain("対戦相手を探しています...");
});

test("旧タブはother取得後にheartbeatも取消も自動入室も実行しない", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail("active"));
  const credential = await startQueue(view);
  await respond(detail("active"), {
    ...roomParticipation(credential.operationId),
    controller: "self",
  });
  clock.advance(2000);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await respond(detail("active"), {
    ...roomParticipation(credential.operationId, 2),
    controller: "other",
  });
  clock.advance(10_000);
  await flush();
  expect(view.textContent).toContain("別のタブでマッチング中");
  expect(
    requests.some(
      (request) =>
        request.init.method === "PATCH" ||
        request.init.method === "DELETE" ||
        request.url.endsWith("/controller"),
    ),
  ).toBe(false);
  expect(readRoomMembershipToken("12345")).toBeNull();
});

test("大会終了後も開始済みの対局を明示引継ぎして再開できる", async () => {
  const controller = documentPair()(false);
  const credential = createTournamentQueue(1, profile.username!);
  const view = page(profile, "/tournaments/1", controller);
  clock.advance(0);
  const participation = roomParticipation(credential.operationId, 2, "playing");
  await respond(detail("settling"), participation);
  press(view, "このタブで続ける");
  await flush();
  controllerRequest().respond({
    participation: { ...participation, controller: "self", controllerVersion: 3 },
    token: "f".repeat(64),
  });
  await flush();
  expect(view.querySelector("[data-path]")?.textContent).toBe("/rooms/12345");
});

test("入室前の本人確認失敗は成立状態の再取得が成功しても説明を残す", async () => {
  const view = page();
  clock.advance(0);
  await respond(detail("active"));
  const credential = await startQueue(view);
  const participation = {
    ...roomParticipation(credential.operationId),
    controller: "self" as const,
  };
  await respond(detail("active"), participation);
  press(document.body, "入室する");
  await flush();
  controllerRequest().respond({ message: "本人確認に失敗しました。" }, 503);
  await flush();
  await respond(detail("active"), participation);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "本人確認に失敗しました。",
  );
  expect(readRoomMembershipToken("12345")).toBeNull();
});

test("引継ぎ通知は同じ操作の新しい世代だけを採用し、逆順通知で現在ownerを失わない", () => {
  const channel = { onmessage: null, postMessage: () => {} } as unknown as BroadcastChannel;
  const controller = new TournamentDocumentController({
    isReload: () => false,
    locks: () => undefined,
    channel: () => channel,
  });
  const operationId = crypto.randomUUID();
  const scope = `1:${profile.username}`;
  const identity = controller.getIdentity();
  controller.remember(scope, operationId, 3);
  const notify = (version: number, op = operationId) =>
    channel.onmessage?.(
      new MessageEvent("message", {
        data: { scope, operationId: op, version, controllerId: crypto.randomUUID() },
      }),
    );
  notify(2);
  notify(4, crypto.randomUUID());
  expect(controller.version(scope, operationId)).toBe(3);
  expect(controller.getIdentity()).toBe(identity);
  notify(4);
  expect(controller.version(scope, operationId)).toBeNull();
  expect(controller.getIdentity()).not.toBe(identity);
});

test.each([undefined, 1])(
  "旧端末の所有保存版%sと現在版が違うreloadは自動で奪い返さない",
  async (savedVersion) => {
    const controller = documentPair()();
    const credential = createTournamentQueue(1, profile.username!);
    if (savedVersion)
      saveTournamentQueue(1, profile.username!, { ...credential, controllerVersion: savedVersion });
    const view = page(profile, "/tournaments/1", controller);
    clock.advance(0);
    await respond(detail("active"), {
      ...roomParticipation(credential.operationId, 2),
      controller: "other",
    });
    await flush();
    expect(requests.some((request) => request.url.endsWith("/controller"))).toBe(false);
    expect(view.textContent).toContain("このタブで続ける");
    expect(view.querySelector("[data-path]")?.textContent).toBe("/tournaments/1");
  },
);

test("引継ぎ応答喪失後のselfも明示引継ぎを再試行して再開できる", async () => {
  const controller = documentPair()(false);
  const credential = createTournamentQueue(1, profile.username!);
  const view = page(profile, "/tournaments/1", controller);
  clock.advance(0);
  await respond(detail("active"), roomParticipation(credential.operationId, 1));
  press(view, "このタブで続ける");
  await flush();
  controllerRequest().reject(new Error("応答が届きませんでした"));
  await flush();
  await respond(detail("active"), {
    ...roomParticipation(credential.operationId, 2),
    controller: "self",
  });
  expect(view.textContent).toContain("このタブで続ける");
  press(view, "このタブで続ける");
  await flush();
  const request = controllerRequest();
  expect(JSON.parse(request.init.body as string).expectedControllerVersion).toBe(2);
  request.respond({
    participation: { ...roomParticipation(credential.operationId, 3), controller: "self" },
    token: "e".repeat(64),
  });
  await flush();
  expect(view.querySelector("[data-path]")?.textContent).toBe("/rooms/12345");
});
