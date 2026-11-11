import { expect, test } from "bun:test";
import { MatchmakingWaitTime } from "../src/features/matchmaking/MatchmakingWaitTime";
import { act, clock, flush, render, rerender } from "./harness";

const serverNowMs = 1_800_000;
const initial = {
  joinedAtMs: serverNowMs - 5000,
  serverNowMs,
  receivedAtMs: 0,
  estimatedMatchAtMs: serverNowMs + 12_000,
};

test("端末時刻と異なるサーバー時刻から毎秒減らし、期限到達で経過時間に切り替える", () => {
  const view = render(<MatchmakingWaitTime {...initial} />);
  expect(view.textContent).toContain("マッチングの目安：あと約12秒");
  expect(view.querySelector('[aria-live="off"]')?.textContent).toContain("あと約12秒");
  clock.advance(1000);
  expect(view.textContent).toContain("あと約11秒");
  clock.advance(11_000);
  expect(view.textContent).toContain("引き続き対戦相手を探しています…");
  expect(view.textContent).toContain("待機時間：17秒");
  expect(view.textContent).not.toContain("マッチングの目安");
});

test("更新で残り秒を増やさず、省略時に経過時間を出して、期限前だけ目安に復帰できる", async () => {
  const view = render(<MatchmakingWaitTime {...initial} />);
  const update = (estimate?: number) =>
    rerender(
      view,
      <MatchmakingWaitTime
        {...initial}
        serverNowMs={serverNowMs + clock.now}
        receivedAtMs={clock.now}
        estimatedMatchAtMs={estimate}
      />,
    );
  clock.advance(3000);
  update(serverNowMs + 20_000);
  expect(view.textContent).toContain("あと約9秒");
  clock.advance(3000);
  update();
  expect(view.textContent).toContain("待機時間：11秒");
  expect(view.textContent).not.toContain("マッチングの目安");
  clock.advance(3000);
  update(initial.estimatedMatchAtMs);
  expect(view.textContent).toContain("あと約3秒");
  clock.advance(3000);
  update(serverNowMs + 30_000);
  expect(view.textContent).toContain("待機時間：17秒");
  expect(view.textContent).not.toContain("マッチングの目安");
  // 別の検索では前回の期限を引き継ぎません。
  rerender(
    view,
    <MatchmakingWaitTime
      key="next-search"
      {...initial}
      joinedAtMs={serverNowMs + 12_000}
      serverNowMs={serverNowMs + 12_000}
      receivedAtMs={clock.now}
      estimatedMatchAtMs={serverNowMs + 27_000}
    />,
  );
  await flush();
  expect(view.textContent).toContain("あと約15秒");
});

test("旧Workerの応答でも経過時間を表示し、背景から戻ると実際の経過へ追いつく", () => {
  const view = render(<MatchmakingWaitTime {...initial} estimatedMatchAtMs={undefined} />);
  expect(view.textContent).toContain("待機時間：5秒");
  act(() => {
    clock.now += 25_000;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(view.textContent).toContain("待機時間：30秒");
  expect(view.textContent).not.toContain("マッチングの目安");
  rerender(
    view,
    <MatchmakingWaitTime
      {...initial}
      estimatedMatchAtMs={serverNowMs + 12_000}
      receivedAtMs={clock.now}
    />,
  );
  expect(view.textContent).toContain("待機時間：30秒");
});
