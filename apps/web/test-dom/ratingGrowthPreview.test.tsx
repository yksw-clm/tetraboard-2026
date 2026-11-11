import { expect, spyOn, test } from "bun:test";
import { RatingGrowthPreview } from "../src/features/matchmaking/RatingGrowthPreview";
import { act, clock, render, rerender } from "./harness";

test("1500から1秒ごとに増え、1600で停止し、再描画では再開しない", () => {
  const view = render(<RatingGrowthPreview />);
  expect(view.textContent).toContain("1500");
  expect(view.textContent).toContain("レートのイメージ");
  expect(view.querySelector("[aria-live]")).toBeNull();
  clock.advance(999);
  expect(view.textContent).toContain("1500");
  clock.advance(1);
  expect(view.textContent).toContain("1512");
  expect(view.textContent).toContain("+12");
  for (const rating of [1528, 1547, 1565, 1582, 1600]) {
    clock.advance(1000);
    expect(view.textContent).toContain(String(rating));
  }
  clock.advance(60000);
  rerender(view, <RatingGrowthPreview />);
  expect(view.textContent).toContain("1600");
});

test("閉じた演出のタイマーを破棄し、開き直すと1500から始まる", () => {
  const view = render(<RatingGrowthPreview />);
  clock.advance(1000);
  expect(view.textContent).toContain("1512");
  rerender(view, null);
  clock.advance(10000);
  rerender(view, <RatingGrowthPreview />);
  expect(view.textContent).toContain("1500");
  clock.advance(1000);
  expect(view.textContent).toContain("1512");
});

test("動きを減らす設定では1600の静止表示にし、途中の設定変更でも更新を止める", () => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const mock = spyOn(window, "matchMedia").mockReturnValue(media);
  try {
    const view = render(<RatingGrowthPreview />);
    clock.advance(1000);
    expect(view.textContent).toContain("1512");
    act(() => {
      Object.defineProperty(media, "matches", { configurable: true, value: true });
      media.dispatchEvent(new Event("change"));
    });
    expect(view.textContent).toContain("1600");
    expect(view.textContent).not.toContain("+12");
    clock.advance(10000);
    expect(view.textContent).toContain("1600");
    rerender(view, null);
    rerender(view, <RatingGrowthPreview />);
    expect(view.textContent).toContain("1600");
  } finally {
    mock.mockRestore();
  }
});
