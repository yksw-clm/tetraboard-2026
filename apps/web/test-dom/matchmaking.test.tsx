import { expect, test } from "bun:test";
import { Routes, Route, useLocation } from "react-router";
import { MatchmakingPage } from "../src/features/matchmaking/MatchmakingPage";
import {
  QueueControllerContext,
  QueueDocumentController,
} from "../src/shared/QueueDocumentController";
import { profile } from "../test/fixtures/account";
import { clock, flush, press, render, requests, wrap, denyStorage } from "./harness";
const identity = "00000000-0000-4000-8000-000000000001";
const user = { ...profile, profileId: identity };
function Path() {
  const location = useLocation();
  return <p data-path>{location.pathname}</p>;
}
function page(game: "four-reversi" | "shogi" = "four-reversi", viewer = user) {
  const path = `/games/${game}/matchmaking`;
  const controller = new QueueDocumentController({
    isReload: () => false,
    locks: () => undefined,
    channel: () => null,
  });
  const view = render(
    <QueueControllerContext value={controller}>
      {wrap(
        viewer,
        path,
      )(
        <Routes>
          <Route path={path} element={<MatchmakingPage game={game} />} />
          <Route path="*" element={<Path />} />
        </Routes>,
      )}
    </QueueControllerContext>,
  );
  return { view, controller };
}
const latest = (path: string) => requests.filter((r) => r.url.includes(path)).at(-1)!;
test("将棋は専用の待機列を使い、CPU戦の条件を入室前に表示する", async () => {
  const { view, controller } = page("shogi");
  latest("/api/matchmaking/shogi?").respond({
    status: "idle",
    serverNowMs: Date.now(),
    enabled: true,
  });
  await flush();
  expect(view.textContent).toContain("15秒");
  press(view, "対戦相手を探す");
  await flush();
  const join = latest("/api/matchmaking/shogi/join");
  const { operationId } = JSON.parse(String(join.init.body));
  const roomId = "12345",
    instanceId = crypto.randomUUID();
  const assigned = {
    status: "matched",
    operationId,
    controllerId: controller.getIdentity(),
    version: 1,
    serverNowMs: Date.now(),
    enabled: true,
    assignment: {
      opponent: "cpu",
      matchId: crypto.randomUUID(),
      roomId,
      instanceId,
      expiresAtMs: Date.now() + 30000,
      membership: { playerId: crypto.randomUUID(), role: "host", token: "a".repeat(64) },
    },
  };
  join.respond(assigned);
  await flush();
  expect(view.textContent).toContain("CPU戦・5分＋30秒・レート対象");
  press(view, "入室する");
  await flush();
  latest("/api/matchmaking/shogi?").respond(assigned);
  await flush();
  expect(view.querySelector("[data-path]")?.textContent).toBe("/rooms/12345");
  expect(JSON.parse(sessionStorage.getItem("tetraboard:matchmaking-room:12345")!).game).toBe(
    "shogi",
  );
});

test("ゲストには将棋レートマッチの登録案内を表示する", async () => {
  const { view } = page("shogi", { ...user, isGuest: true });
  latest("/api/matchmaking/shogi?").respond({
    status: "idle",
    serverNowMs: Date.now(),
    enabled: true,
  });
  await flush();
  expect(view.textContent).toContain("参加には登録アカウントが必要");
  expect(view.querySelector('a[href="/login"]')).not.toBeNull();
  expect(view.textContent).not.toContain("対戦相手を探す");
});
test("Web Locksがなくても明示参加でき、再読み込み用の待機とCPU補充の案内を保持する", async () => {
  const { view, controller } = page();
  latest("/api/matchmaking/four-reversi?").respond({
    status: "idle",
    serverNowMs: Date.now(),
    enabled: true,
  });
  await flush();
  expect(view.textContent).toContain("3分切れ負け");
  expect(view.textContent).toContain("CPU「ヨミ」（Lv3）");
  press(view, "対戦相手を探す");
  await flush();
  const join = latest("/join");
  expect(join).toBeDefined();
  const body = JSON.parse(String(join.init.body));
  expect(body.controllerId).toBe(controller.getIdentity());
  join.respond({
    status: "waiting",
    operationId: body.operationId,
    controllerId: body.controllerId,
    version: 1,
    joinedAtMs: Date.now(),
    expiresAtMs: Date.now() + 30000,
    serverNowMs: Date.now(),
    enabled: true,
  });
  await flush();
  expect(view.textContent).toContain("対戦相手を探しています");
  expect(view.textContent).not.toContain("ニックネーム");
  press(view, "取り消す");
  await flush();
  const cancel = latest("/cancel");
  expect(JSON.parse(String(cancel.init.body))).toMatchObject({
    operationId: body.operationId,
    version: 1,
  });
  cancel.respond({ status: "idle", serverNowMs: Date.now(), enabled: true });
  await flush();
  expect(view.textContent).toContain("対戦相手を探す");
});
test("成立後の5秒で参加資格を保存して入室し、ポーリングで待ち時間を数え直さない", async () => {
  const { view, controller } = page();
  const operationId = crypto.randomUUID(),
    roomId = "12345",
    instanceId = crypto.randomUUID();
  const state = {
    status: "matched",
    operationId,
    controllerId: controller.getIdentity(),
    version: 1,
    joinedAtMs: Date.now() - 1000,
    expiresAtMs: Date.now() + 30000,
    serverNowMs: Date.now(),
    enabled: true,
    assignment: {
      matchId: crypto.randomUUID(),
      roomId,
      instanceId,
      expiresAtMs: Date.now() + 30000,
      membership: { playerId: crypto.randomUUID(), role: "host", token: "a".repeat(64) },
    },
  };
  latest("/api/matchmaking/four-reversi?").respond(state);
  await flush();
  expect(view.textContent).toContain("対戦相手が決まりました");
  clock.advance(3000);
  latest("/api/matchmaking/four-reversi?").respond({ ...state, serverNowMs: Date.now() });
  await flush();
  clock.advance(1999);
  await flush();
  expect(view.querySelector("[data-path]")).toBeNull();
  clock.advance(1);
  await flush();
  latest("/api/matchmaking/four-reversi?").respond(state);
  await flush();
  expect(view.querySelector("[data-path]")?.textContent).toBe(`/rooms/${roomId}`);
  expect(sessionStorage.getItem(`tetraboard:room:${roomId}:membership`)).toBe("a".repeat(64));
});
test("別の操作元の待機を勝手に引き継がず、ボタンから同じ待機を引き継ぐ", async () => {
  const { view } = page();
  const operationId = crypto.randomUUID();
  latest("/api/matchmaking/four-reversi?").respond({
    status: "waiting",
    operationId,
    controllerId: crypto.randomUUID(),
    version: 2,
    joinedAtMs: Date.now(),
    expiresAtMs: Date.now() + 30000,
    serverNowMs: Date.now(),
    enabled: true,
  });
  await flush();
  expect(view.textContent).toContain("別のタブまたは端末");
  expect(view.textContent).not.toContain("マッチングを取り消す");
  expect(requests.some((r) => r.url.endsWith("/takeover"))).toBe(false);
  press(view, "このタブで続ける");
  await flush();
  const transfer = latest("/takeover");
  expect(transfer).toBeDefined();
  expect(JSON.parse(String(transfer.init.body)).operationId).toBe(operationId);
});

test("継続確認の応答待ちでも取消を送れ、遅れた応答で待機を復活させない", async () => {
  const { view, controller } = page();
  const operationId = crypto.randomUUID();
  const waiting = {
    status: "waiting",
    operationId,
    controllerId: controller.getIdentity(),
    version: 1,
    joinedAtMs: Date.now(),
    expiresAtMs: Date.now() + 30000,
    serverNowMs: Date.now(),
    enabled: true,
  };
  latest("/api/matchmaking/four-reversi?").respond(waiting);
  await flush();
  clock.advance(10000);
  await flush();
  const heartbeat = latest("/heartbeat");
  expect(heartbeat).toBeDefined();
  press(view, "取り消す");
  await flush();
  const cancel = latest("/cancel");
  expect(cancel).toBeDefined();
  cancel.respond({ status: "idle", serverNowMs: Date.now(), enabled: true });
  await flush();
  heartbeat.respond({ ...waiting, expiresAtMs: Date.now() + 30000 });
  await flush();
  expect(view.textContent).toContain("対戦相手を探す");
  expect(view.textContent).not.toContain("対戦相手を探しています");
});

test("待機時間は端末の時計のずれに影響されずサーバー時刻から表示する", async () => {
  const { view, controller } = page();
  const serverNow = Date.now() + 60000;
  latest("/api/matchmaking/four-reversi?").respond({
    status: "waiting",
    operationId: crypto.randomUUID(),
    controllerId: controller.getIdentity(),
    version: 1,
    joinedAtMs: serverNow - 10000,
    expiresAtMs: serverNow + 20000,
    serverNowMs: serverNow,
    enabled: true,
  });
  await flush();
  expect(view.textContent).toContain("待機時間：10秒");
  clock.advance(1000);
  await flush();
  expect(view.textContent).toContain("待機時間：11秒");
});

test("保存できない端末では新しい待機を送信せず、入力を保持して案内する", async () => {
  const { view } = page();
  latest("/api/matchmaking/four-reversi?").respond({
    status: "idle",
    serverNowMs: Date.now(),
    enabled: true,
  });
  await flush();
  const denied = denyStorage();
  try {
    press(view, "対戦相手を探す");
    await flush();
    expect(requests.some((r) => r.url.endsWith("/join"))).toBe(false);
    expect(view.textContent).toContain("保存");
  } finally {
    denied.mockRestore();
  }
});
