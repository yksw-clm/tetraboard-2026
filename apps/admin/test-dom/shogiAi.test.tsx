import { expect, test } from "bun:test";
import { useAiStatus, FourShogiAi } from "../src/FourShogiAi";
import { aiStatusFixture } from "../../../test-support/shogiAi";
import { act, clock, flush, render, renderHook, requests } from "../../web/test-dom/support";
test("監視は10秒ごとに重複取得せず、障害では値を保持し、権限喪失時に破棄します", async () => {
  const h = renderHook(() => useAiStatus(), undefined);
  expect(requests.length).toBe(1);
  clock.advance(20000);
  expect(requests.length).toBe(1);
  requests[0].respond(aiStatusFixture());
  await flush();
  expect(h.current.data?.schemaVersion).toBe(1);
  clock.advance(10000);
  requests[1].respond({ message: "offline" }, 503);
  await flush();
  expect(h.current.data).not.toBeNull();
  act(() => h.current.refresh());
  requests[2].respond({ message: "forbidden" }, 403);
  await flush();
  expect(h.current.data).toBeNull();
  h.unmount();
});
test("タブ非表示では取得せず、再表示で更新し、古い応答とunmount後の応答を捨てます", async () => {
  const hidden = Object.getOwnPropertyDescriptor(document, "hidden");
  let value = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
  try {
    const h = renderHook(() => useAiStatus(), undefined);
    requests[0].respond(aiStatusFixture());
    await flush();
    value = true;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    clock.advance(30000);
    expect(requests.length).toBe(1);
    value = false;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(requests.length).toBe(2);
    act(() => h.current.refresh());
    expect(requests[1].init.signal?.aborted).toBe(true);
    const fresh = aiStatusFixture(Date.now() + 1);
    requests[2].respond(fresh);
    requests[1].respond(aiStatusFixture(0));
    await flush();
    expect(h.current.data?.generatedAt).toBe(fresh.generatedAt);
    act(() => h.current.refresh());
    h.unmount();
    expect(requests[3].init.signal?.aborted).toBe(true);
  } finally {
    if (hidden) Object.defineProperty(document, "hidden", hidden);
    else Reflect.deleteProperty(document, "hidden");
  }
});
test("未測定・二つのルール・更新停止と最後の取得時刻を表示します", async () => {
  const view = render(<FourShogiAi />);
  const data = aiStatusFixture(Date.now() - 31000);
  requests[0].respond(data);
  await flush();
  expect(view.textContent).toContain("３人攻撃禁止あり");
  expect(view.textContent).toContain("３人攻撃禁止なし");
  expect(view.textContent).toContain("30秒以上");
  expect(view.textContent).toContain("最新取得");
  expect(view.textContent).toContain("未保存");
});
test("実終局と脱落結果・再利用を区別し、学習候補数を表示します", async () => {
  const view = render(<FourShogiAi />),
    data = aiStatusFixture();
  data.learning.games = 12;
  data.learning.training = {
    method: "teacher-preference",
    lessons: 24,
    screenedCandidates: 64,
    guidedCandidates: 2,
    reusedGames: 8,
    earlyOutcomes: 5,
    fullGames: 7,
  };
  requests[0].respond(data);
  await flush();
  expect(view.textContent).toContain("12件完了");
  expect(view.textContent).toContain("実終局 7");
  expect(view.textContent).toContain("脱落結果 5");
  expect(view.textContent).toContain("再利用 8");
  expect(view.textContent).toContain("教師からの候補 2");
});
