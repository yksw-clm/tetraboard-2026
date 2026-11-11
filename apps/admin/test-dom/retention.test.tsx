import { expect, test } from "bun:test";
import { MemoryRouter, useNavigate } from "react-router";
import { RetentionDashboard } from "../src/RetentionDashboard";
import { act, render, flush, press, requests } from "../../web/test-dom/support";
const row = {
  game: "all",
  kind: "registered",
  enrolled: 3,
  eligible: 2,
  retained: 0,
  retainedNextDay: 0,
  observing: 1,
  unknown: 0,
  rate: 0,
  nextDayRate: 0,
  reached: [0, 0, 0, 0, 0],
};
function report() {
  return {
    collectedFromMs: Date.now() - 60 * 86400000,
    aggregatedAtMs: Date.now(),
    metricVersion: 2,
    status: "ready",
    coverage: "ready",
    returns: [
      row,
      {
        ...row,
        game: "shogi",
        enrolled: 1,
        eligible: 0,
        observing: 1,
        rate: null,
        nextDayRate: null,
      },
    ],
    placement: [
      {
        ...row,
        game: "shogi",
        enrolled: 5,
        eligible: 0,
        observing: 5,
        rate: null,
        nextDayRate: null,
        reached: [5, 4, 3, 2, 1],
      },
    ],
    postPlacement: [
      { ...row, game: "shogi", enrolled: 1, eligible: 1, retained: 1, observing: 0, rate: 1 },
    ],
  };
}
function Back() {
  const navigate = useNavigate();
  return <button onClick={() => void navigate(-1)}>戻る</button>;
}
test("再対局・認定は分子分母・観測中・0%と異なる起点を表示し、条件と戻る・失敗時保持・権限喪失を扱う", async () => {
  const view = render(
    <MemoryRouter>
      <RetentionDashboard />
      <Back />
    </MemoryRouter>,
  );
  expect(requests[0]!.url).toContain("/api/admin/analytics/retention?");
  expect(view.querySelector('[aria-label="日付基準"]') === null).toBe(true);
  requests[0]!.respond(report());
  await flush();
  expect(view.textContent).toContain("0.0% (0/2人)");
  expect(view.textContent).toContain("100.0% (1/1人)");
  expect(view.textContent).toContain("観測中");
  expect(view.textContent).toContain("90日以内");
  expect(view.textContent).toContain("認定5局目の完了日");
  expect(view.textContent).toContain("指標版2");
  press(view, "更新");
  requests[1]!.respond({ message: "一時的な障害" }, 503);
  await flush();
  expect(view.textContent).toContain("0.0% (0/2人)");
  expect(view.textContent).toContain("一時的な障害");
  const game = view.querySelector<HTMLSelectElement>('[aria-label="ゲーム"]')!;
  act(() => {
    game.value = "shogi";
    game.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const old = requests.at(-1)!;
  expect(old.url).toContain("game=shogi");
  expect(view.textContent).not.toContain("0.0% (0/2人)");
  press(view, "戻る");
  expect(old.init.signal!.aborted).toBe(true);
  const current = requests.at(-1)!;
  old.respond(report());
  current.respond({ ...report(), status: "delayed" });
  await flush();
  expect(view.textContent).toContain("更新遅延");
  press(view, "更新");
  requests.at(-1)!.respond({ message: "権限がありません" }, 403);
  await flush();
  expect(view.textContent).not.toContain("0.0% (0/2人)");
  expect(view.textContent).toContain("権限がありません");
});
test("導入前の期間と対象者なし・分母なし・不明を0%にしない", async () => {
  const view = render(
    <MemoryRouter>
      <RetentionDashboard />
    </MemoryRouter>,
  );
  requests[0]!.respond({
    ...report(),
    coverage: "unmeasured",
    returns: [],
    placement: [],
    postPlacement: [],
  });
  await flush();
  expect(view.textContent).toContain("この期間は未計測");
  expect(view.textContent).not.toContain("対象者なし（計測済み）");
  expect(view.textContent).not.toContain("0.0%");
  press(view, "更新");
  requests.at(-1)!.respond({ ...report(), returns: [], placement: [], postPlacement: [] });
  await flush();
  expect(view.textContent).toContain("対象者なし（計測済み）");
  press(view, "更新");
  requests.at(-1)!.respond({
    ...report(),
    returns: [
      {
        ...row,
        kind: "unknown",
        eligible: 0,
        unknown: 3,
        observing: 0,
        rate: null,
        nextDayRate: null,
      },
    ],
    placement: [],
    postPlacement: [],
  });
  await flush();
  expect(view.textContent).toContain("不明（起点情報不足）");
  expect(view.textContent).not.toContain("0.0%");
});
