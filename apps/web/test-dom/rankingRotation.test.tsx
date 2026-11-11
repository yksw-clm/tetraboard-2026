import { expect, test } from "bun:test";
import { useRankingRotation } from "../src/features/lobby/useRankingRotation";
import { act, clock, renderHook } from "./harness";

function visibility(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}

test("非表示中は停止し、復帰から10秒を数える", () => {
  visibility(false);
  const hook = renderHook(() => useRankingRotation(true, false, true), undefined);
  try {
    clock.advance(9000);
    visibility(true);
    clock.advance(30_000);
    expect(hook.current.metric).toBe("victories");
    visibility(false);
    clock.advance(9999);
    expect(hook.current.metric).toBe("victories");
    clock.advance(1);
    expect(hook.current.metric).toBe("rating");
  } finally {
    Reflect.deleteProperty(document, "hidden");
  }
});

test("動きを減らす設定では手動・自動とも演出待ちを省略する", () => {
  const hook = renderHook(() => useRankingRotation(true, false, true), undefined);
  act(() => hook.current.select("rating"));
  expect(hook.current.metric).toBe("rating");
  expect(hook.current.phase).toBe("idle");
  clock.advance(10_000);
  expect(hook.current.metric).toBe("victories");
});

test("データ取得完了から10秒待ち、停止条件と明示停止を独立して保持する", () => {
  const hook = renderHook(
    ({ available, blocked }: { available: boolean; blocked: boolean }) =>
      useRankingRotation(available, blocked, true),
    { available: false, blocked: false },
  );
  clock.advance(30_000);
  expect(hook.current.metric).toBe("victories");
  hook.rerender({ available: true, blocked: false });
  clock.advance(9999);
  expect(hook.current.metric).toBe("victories");
  hook.rerender({ available: true, blocked: true });
  act(() => hook.current.togglePaused());
  hook.rerender({ available: true, blocked: false });
  clock.advance(30_000);
  expect(hook.current.metric).toBe("victories");
  act(() => hook.current.togglePaused());
  clock.advance(10_000);
  expect(hook.current.metric).toBe("rating");
});

test("退出100ms・登場150msの後に10秒待ち、アンマウント後は更新しない", () => {
  const hook = renderHook(() => useRankingRotation(true, false, false), undefined);
  clock.advance(10_000);
  expect(hook.current.metric).toBe("victories");
  expect(hook.current.phase).toBe("out");
  clock.advance(99);
  expect(hook.current.metric).toBe("victories");
  clock.advance(1);
  expect(hook.current.metric).toBe("rating");
  clock.advance(150);
  expect(hook.current.phase).toBe("idle");
  clock.advance(9999);
  expect(hook.current.phase).toBe("idle");
  hook.unmount();
  clock.advance(30_000);
  expect(hook.current.metric).toBe("rating");
});
