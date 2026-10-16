import { afterEach, expect, test } from "bun:test";
import { MemoryRouter } from "react-router";
import type { AccountProfile } from "@tetraboard/protocol";
import { AccountContext } from "../src/features/account/useAccount";
import { advanceAccountRequestGeneration } from "../src/features/account/accountRequestScope";
import FourShogiMatchReplayView from "../src/features/room/FourShogiMatchReplayView";
import {
  analysisFixture,
  fixtureAnalysis,
  analysisHealth,
  analysisCode,
  analysisModel,
} from "../test/fixtures/fourShogiAnalysis";
import { act, clock, flush, press, render, rerender, requests, wrap } from "./harness";
async function searchFixture(...args: Parameters<typeof fixtureAnalysis>) {
  let result!: Awaited<ReturnType<typeof fixtureAnalysis>>;
  await act(async () => {
    result = await fixtureAnalysis(...args);
  });
  return result;
}
const originalUrl = location.href;
afterEach(() => {
  location.href = originalUrl;
});
const user: AccountProfile = {
  profileId: "10000000-0000-4000-8000-000000000001",
  name: "本人",
  username: "self",
  avatarUrl: null,
  profileCompleted: true,
};
function open(prohibited = true, index = 0) {
  location.href = "https://tetraboard-dev.chaossi-lab.workers.dev/";
  const fixture = analysisFixture(prohibited);
  const view = render(wrap(user)(<FourShogiMatchReplayView {...fixture} />));
  press(view, "解析（試用）");
  for (let i = fixture.frames.length - 1; i > index; i--) press(document.body, "前の局面");
  return { fixture, view };
}
async function start() {
  const count = requests.length;
  press(document.body, "この局面を解析");
  // Web Cryptoの完了は偽時計では進まないため、要求が現れるまでイベントループを譲ります。
  for (let turn = 0; turn < 50 && requests.length === count; turn++) {
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  }
  await flush();
  const health = requests.at(-1)!;
  expect(health.url).toBe("/api/four-shogi-ai/health");
  health.respond(analysisHealth);
  await flush();
  const post = requests.at(-1)!;
  expect(post.init.method).toBe("POST");
  const body = JSON.parse(String(post.init.body));
  const job = {
    schemaVersion: 1,
    serviceInstanceId: analysisHealth.serviceInstanceId,
    jobId: crypto.randomUUID(),
    requestId: body.requestId,
    stateHash: body.stateHash,
    inputHash: "c".repeat(64),
    codeVersion: analysisCode,
    engineVersion: analysisHealth.engineVersion,
    modelId: analysisModel,
    context: { kind: "analysis", matchId: body.matchId, eventOffset: body.eventOffset },
    status: "queued",
    error: null,
    timing: { queueMs: 0, computeMs: 0, restoreMs: 0, searchMs: 0, inferenceMs: 0 },
    result: null as unknown,
  };
  return { post, body, job };
}
for (const prohibited of [true, false])
  test(`ON/OFF=${prohibited}: 保存棋譜の任意局面で候補・実戦着手・実手番PV・4人評価・条件を表示する`, async () => {
    const { fixture } = open(prohibited);
    const before = JSON.stringify(fixture);
    if (!prohibited) press(document.body, "30秒");
    const profile = prohibited ? "trial-500ms" : "trial-30000ms";
    const { result, root } = await searchFixture(fixture, 0, profile);
    const { post, body, job } = await start();
    expect(body).toMatchObject({
      matchId: fixture.match.id,
      eventOffset: 0,
      stateHash: root.position.stateHash,
      profile,
    });
    expect(body).not.toHaveProperty("position");
    post.respond(job, 202);
    await flush();
    expect(document.body.textContent).toContain("順番待ち");
    clock.advance(750);
    await flush();
    requests.at(-1)!.respond({ ...job, status: "running" });
    await flush();
    expect(document.body.textContent).toContain("解析しています");
    clock.advance(750);
    await flush();
    requests.at(-1)!.respond({ ...job, status: "completed", result });
    await flush();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("解析が完了しました");
    expect(dialog.textContent).toContain("上位5候補");
    expect(dialog.textContent).toContain("実際の着手（同じ条件で比較）");
    expect(dialog.textContent).toContain("候補5");
    expect(dialog.textContent).toContain("現在の確定王手：なし");
    expect(dialog.textContent).toContain("必然とは限りません");
    expect(dialog.textContent).toContain("次の自手番までは未読");
    expect(dialog.textContent).toContain("未校正");
    expect(dialog.textContent).not.toMatch(/[%％]/);
    expect(dialog.querySelector("table tbody")?.querySelectorAll("tr")).toHaveLength(4);
    expect(dialog.textContent).toContain("西");
    expect(dialog.textContent).toContain(analysisModel);
    expect(dialog.textContent).toContain(analysisCode);
    expect(dialog.textContent).toContain("deadline");
    expect(JSON.stringify(fixture)).toBe(before);
    press(document.body, "次の局面");
    await flush();
    expect(document.body.textContent).not.toContain("候補5");
    expect(requests.filter((r) => r.init.method === "POST")).toHaveLength(1);
  });
test("局面切替後に旧POSTが遅れて受理されても、新局面の結果へ混ぜず旧ジョブを取り消す", async () => {
  const { fixture } = open();
  const old = await start();
  press(document.body, "次の局面");
  await flush();
  const latest = await start();
  const { result } = await searchFixture(fixture, 1);
  latest.post.respond({ ...latest.job, status: "completed", result });
  await flush();
  expect(document.body.textContent).toContain("解析が完了しました");
  old.post.respond(old.job, 202);
  await flush();
  expect(requests.at(-1)!.url).toContain(old.job.jobId);
  expect(requests.at(-1)!.init.method).toBe("DELETE");
  requests.at(-1)!.respond({ ...old.job, status: "cancelled" });
  await flush();
  expect(document.body.textContent).toContain("イベント位置 1");
  expect(document.body.textContent).toContain("解析が完了しました");
});
test("取消後の受付応答とポーリング完了を捨て、既知のジョブはVPSへ取消を依頼する", async () => {
  const { fixture } = open();
  const pending = await start();
  press(document.body, "解析を取消");
  pending.post.respond(pending.job, 202);
  await flush();
  expect(requests.at(-1)!.init.method).toBe("DELETE");
  requests.at(-1)!.respond({ ...pending.job, status: "cancelled" });
  await flush();
  expect(document.body.textContent).toContain("解析を取り消しました");
  const active = await start();
  active.post.respond(active.job, 202);
  await flush();
  clock.advance(750);
  await flush();
  const poll = requests.at(-1)!;
  press(document.body, "解析を取消");
  await flush();
  requests.at(-1)!.respond({ ...active.job, status: "cancelled" });
  poll.respond({
    ...active.job,
    status: "completed",
    result: (await searchFixture(fixture)).result,
  });
  await flush();
  expect(document.body.textContent).toContain("解析を取り消しました");
  expect(document.body.textContent).not.toContain("候補1");
});
test("認証・権限・過負荷・サービス更新・計算失敗を明示し、同じ操作から再試行できる", async () => {
  open();
  for (const [status, text] of [
    [401, "ログイン状態"],
    [403, "試用を利用できません"],
    [429, "上限"],
    [503, "利用できません"],
  ] as const) {
    press(document.body, "この局面を解析");
    await flush();
    requests.at(-1)!.respond({}, status);
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(text);
    expect(document.body.textContent).not.toContain("候補1");
  }
  const active = await start();
  active.post.respond({ ...active.job, status: "failed", error: "model_not_used" });
  await flush();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("完了できませんでした");
  const restarted = await start();
  restarted.post.respond({}, 409);
  await flush();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("更新されたか");
});
test("局面・版・モデル・inputHashの不一致を画面へ採用しない", async () => {
  const { fixture } = open();
  const { result } = await searchFixture(fixture);
  for (const corrupt of [
    (job: Awaited<ReturnType<typeof start>>["job"]) => ({ ...job, stateHash: "d".repeat(64) }),
    (job: Awaited<ReturnType<typeof start>>["job"]) => ({
      ...job,
      modelId: "four-shogi-tiny-policy-value-v1:" + "d".repeat(64),
    }),
    (job: Awaited<ReturnType<typeof start>>["job"]) => ({
      ...job,
      result: { ...result, versions: { ...result.versions, actionVersion: "old" } },
    }),
  ]) {
    const active = await start();
    active.post.respond(corrupt({ ...active.job, status: "completed", result }));
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("確認できません");
    expect(document.body.textContent).not.toContain("候補1");
  }
  const active = await start();
  active.post.respond(active.job);
  await flush();
  clock.advance(750);
  await flush();
  requests
    .at(-1)!
    .respond({ ...active.job, inputHash: "d".repeat(64), status: "completed", result });
  await flush();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("確認できません");
});
test("ログアウト・認証世代変更と画面を閉じた後の応答を表示しない", async () => {
  location.href = "https://tetraboard-dev.chaossi-lab.workers.dev/";
  const fixture = analysisFixture();
  const tree = (account: AccountProfile | null, generation: number) => (
    <MemoryRouter>
      <AccountContext.Provider
        value={{
          user: account,
          generation,
          loading: false,
          error: null,
          refresh: async () => {},
          update: () => {},
        }}
      >
        <FourShogiMatchReplayView {...fixture} />
      </AccountContext.Provider>
    </MemoryRouter>
  );
  const view = render(tree(user, 0));
  press(view, "解析（試用）");
  const active = await start();
  rerender(view, tree(null, advanceAccountRequestGeneration()));
  await flush();
  active.post.respond(active.job);
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(view.textContent).not.toContain("解析（試用）");
  expect(requests.at(-1)!.init.method).toBe("DELETE");
  requests.at(-1)!.respond({ ...active.job, status: "cancelled" });
  await flush();
});
test("終局位置の解析は確定順位を表示し、着手候補を作らない", async () => {
  const { fixture } = open(true, 7);
  const active = await start();
  const { result } = await searchFixture(fixture, 7);
  active.post.respond({ ...active.job, status: "completed", result });
  await flush();
  expect(document.body.textContent).toContain("なし（終局または合法手なし）");
  expect(document.body.textContent).toContain("1位（確定）");
  expect(document.body.textContent).toContain("比較対象がありません");
  expect(document.body.textContent).not.toMatch(/[%％]/);
});
