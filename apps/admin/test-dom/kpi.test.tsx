import { expect, test } from "bun:test";
import type { KpiReport } from "@tetraboard/protocol";
import { MemoryRouter } from "react-router";
import { Kpi } from "../src/Kpi";
import { AdminApp } from "../src/AdminApp";
import { ThemeProvider } from "../src/components/ThemeProvider";
import { act, clock, enter, flush, press, render, requests } from "../../web/test-dom/support";

function setNow(value = "2026-11-30T15:30:00Z") {
  clock.advance(Date.parse(value) - Date.now());
}
function report(overrides: Partial<KpiReport> = {}): KpiReport {
  return {
    from: "2026-11-02",
    to: "2026-12-01",
    computedAtMs: Date.now(),
    completedMatches: 1234,
    players: 567,
    replayWithin7Days: { numerator: 2, denominator: 8, rate: 0.25, observing: 3 },
    newRegistrations: 12,
    events: {
      visitingBrowsers: 20,
      matchStartRate: { numerator: 9, denominator: 20, rate: 0.45 },
      matchCompletionRate: { numerator: 0, denominator: 0, rate: null },
      humanMatchRate: { numerator: 3, denominator: 5, rate: 0.6 },
      acquisition: [
        {
          referrerClass: "social",
          utmSource: "test-source",
          utmMedium: "test-medium",
          utmCampaign: "test-campaign",
          device: "smartphone",
          visitingBrowsers: 10,
          participatingBrowsers: 4,
        },
        {
          referrerClass: "",
          utmSource: "",
          utmMedium: "",
          utmCampaign: "",
          device: "",
          visitingBrowsers: 0,
          participatingBrowsers: 0,
        },
      ],
      registration: [{ entry: "room-result", stage: "registered", flows: 6 }],
      matchmaking: [
        { stage: "matched", count: 4, waitingMs: { median: 1250, p90: 12500 } },
        { stage: "failed", count: 0, waitingMs: { median: null, p90: null } },
      ],
    },
    eventsUnavailableReason: null,
    sampling: "unknown",
    ...overrides,
  };
}
function card(view: HTMLElement, title: string) {
  return [...view.querySelectorAll("h2")].find((heading) => heading.textContent === title)!
    .parentElement!;
}
function period(view: HTMLElement, label: "開始日" | "終了日") {
  return view.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
}
function expectPeriod(view: HTMLElement, from: string, to: string) {
  expect(period(view, "開始日").value).toBe(from);
  expect(period(view, "終了日").value).toBe(to);
  expect(requests.at(-1)!.url).toBe(`/api/admin/kpi?from=${from}&to=${to}`);
}

test("日本時間の今日を含む30日で取得し、実数・割合・分母0・観測中の人数と各表を表示する", async () => {
  setNow();
  const view = render(<Kpi />);
  expectPeriod(view, "2026-11-02", "2026-12-01");
  expect(requests).toHaveLength(1);
  expect(requests[0]!.init.credentials).toBe("same-origin");
  expect(requests[0]!.init.cache).toBe("no-store");
  expect(view.querySelector('[role="status"]')?.textContent).toBe("KPIを取得中…");
  requests[0]!.respond(report());
  await flush();
  expect(view.querySelector('[role="status"]')).toBeNull();
  expect(card(view, "訪問ブラウザ数").querySelector("p")?.textContent).toBe("20");
  expect(card(view, "対局開始率").querySelector("p")?.textContent).toBe("45.0%（9 / 20）");
  expect(card(view, "対局開始率").querySelector("small")?.textContent).toBe("（9 / 20）");
  expect(card(view, "対局完了率").querySelector("p")?.textContent).toBe("—（0 / 0）");
  expect(card(view, "完了対局数").querySelector("p")?.textContent).toBe("1,234");
  expect(card(view, "対局者数").querySelector("p")?.textContent).toBe("567");
  expect(card(view, "対人戦の割合").querySelector("p")?.textContent).toBe("60.0%（3 / 5）");
  expect(card(view, "7 日以内の再対局率").querySelector("p")?.textContent).toBe("25.0%（2 / 8）");
  expect(card(view, "7 日以内の再対局率").textContent).toContain("観測中 3 人");
  expect(card(view, "新規登録数").querySelector("p")?.textContent).toBe("12");
  const tables = [...view.querySelectorAll("table")];
  expect(tables).toHaveLength(3);
  const cells = (table: HTMLTableElement, row = 0) =>
    [...table.querySelectorAll("tbody tr")[row]!.querySelectorAll("td")].map(
      (cell) => cell.textContent,
    );
  expect(cells(tables[0]!)).toEqual([
    "SNS・動画・配信",
    "test-source",
    "test-medium",
    "test-campaign",
    "スマートフォン",
    "10",
    "4",
  ]);
  expect(cells(tables[0]!, 1)).toEqual(["不明", "—", "—", "—", "不明", "0", "0"]);
  expect(cells(tables[1]!)).toEqual(["対局結果", "新規登録", "6"]);
  expect(cells(tables[2]!)).toEqual(["成立", "4", "1.3", "12.5"]);
  expect(cells(tables[2]!, 1)).toEqual(["失敗", "0", "—", "—"]);
  expect(tables[2]!.textContent).toContain("待ち時間の中央値（秒）");
  expect(tables[2]!.textContent).toContain("待ち時間の90パーセンタイル（秒）");
  expect(view.textContent).toContain("間引きの有無は確認できません");
  expect(view.textContent).toContain(
    "訪問数・ページビュー・表示速度は Cloudflare のダッシュボードの Web Analytics で確認します",
  );
  const link = view.querySelector('a[href="https://dash.cloudflare.com/"]')!;
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
});

test("4つのプリセットで日本時間の期間を切り替え、その期間で再取得する", async () => {
  setNow();
  const view = render(<Kpi />);
  for (const [label, from, to] of [
    ["直近 7 日", "2026-11-25", "2026-12-01"],
    ["直近 30 日", "2026-11-02", "2026-12-01"],
    ["今月", "2026-12-01", "2026-12-01"],
    ["先月", "2026-11-01", "2026-11-30"],
  ]) {
    const previous = requests.at(-1)!;
    const count = requests.length;
    press(view, label!);
    expectPeriod(view, from!, to!);
    expect(requests).toHaveLength(count + 1);
    expect(previous.init.signal?.aborted).toBe(true);
    requests.at(-1)!.respond(report({ from, to }));
    await flush();
    expect(card(view, "完了対局数").textContent).toContain("1,234");
  }
});

test("先月のプリセットは年をまたぐ場合と閏年の2月にも対応する", () => {
  for (const [now, from, to] of [
    ["2026-12-31T15:30:00Z", "2026-12-01", "2026-12-31"],
    ["2028-02-29T15:30:00Z", "2028-02-01", "2028-02-29"],
  ]) {
    setNow(now);
    const view = render(<Kpi />);
    press(view, "先月");
    expectPeriod(view, from!, to!);
  }
});

test("両端を含めて92日は取得でき、93日以上・逆転・空の日付では取得を止めて理由を示す", async () => {
  setNow();
  const view = render(<Kpi />);
  enter(period(view, "開始日"), "2026-09-01");
  expectPeriod(view, "2026-09-01", "2026-12-01");
  expect(requests).toHaveLength(2);
  requests.at(-1)!.respond(report({ from: "2026-09-01" }));
  await flush();
  enter(period(view, "開始日"), "2026-08-31");
  expect(requests).toHaveLength(2);
  expect(view.querySelector('[role="alert"]')?.textContent).toBe(
    "期間は開始日と終了日を含めて92日以内にしてください。",
  );
  expect(view.querySelector("h2")).toBeNull();
  expect(view.querySelector('[role="status"]')).toBeNull();
  enter(period(view, "開始日"), "2026-12-02");
  expect(view.querySelector('[role="alert"]')?.textContent).toBe(
    "開始日は終了日以前の日付を選択してください。",
  );
  expect(requests).toHaveLength(2);
  enter(period(view, "終了日"), "");
  expect(view.querySelector('[role="alert"]')?.textContent).toBe(
    "開始日と終了日を選択してください。",
  );
  expect(requests).toHaveLength(2);
  press(view, "直近 7 日");
  expectPeriod(view, "2026-11-25", "2026-12-01");
  expect(requests).toHaveLength(3);
  expect(view.querySelector('[role="alert"]')).toBeNull();
});

test("期間を変えたら以前の値を消し、不正な期間で中止した応答も表示しない", async () => {
  setNow();
  const view = render(<Kpi />);
  requests[0]!.respond(report());
  await flush();
  press(view, "直近 7 日");
  expect(view.querySelector("h2")).toBeNull();
  enter(period(view, "開始日"), "2026-01-01");
  expect(requests[1]!.init.signal?.aborted).toBe(true);
  requests[1]!.respond(report());
  await flush();
  expect(view.querySelector("h2")).toBeNull();
  expect(requests).toHaveLength(2);
});

test("イベントを取得できない場合は各該当箇所に理由を示し、業務テーブル由来の値を表示する", async () => {
  const view = render(<Kpi />);
  const reason = "利用状況イベントを取得できません。時間をおいて再試行してください。";
  requests[0]!.respond(
    report({
      events: null,
      eventsUnavailableReason: reason,
      newRegistrations: 999,
      sampling: false,
    }),
  );
  await flush();
  for (const title of [
    "訪問ブラウザ数",
    "対局開始率",
    "対局完了率",
    "対人戦の割合",
    "新規登録数",
    "流入元ごと",
    "登録の段階ごと",
    "マッチングの段階ごと",
  ]) {
    expect(card(view, title).textContent).toContain(reason);
  }
  expect(card(view, "完了対局数").querySelector("p")?.textContent).toBe("1,234");
  expect(card(view, "対局者数").querySelector("p")?.textContent).toBe("567");
  expect(card(view, "7 日以内の再対局率").querySelector("p")?.textContent).toBe("25.0%（2 / 8）");
  expect(card(view, "7 日以内の再対局率").textContent).toContain("観測中 3 人");
  expect(view.querySelector("table")).toBeNull();
  expect(view.textContent).not.toContain("999");
  expect(view.textContent).not.toContain("test-source");
  expect(view.textContent).not.toContain("間引");
});

test("間引きがある場合は注意書きを表示し、空の表は記録が0件と示す", async () => {
  const view = render(<Kpi />);
  const data = report();
  requests[0]!.respond({
    ...data,
    sampling: true,
    events: { ...data.events, acquisition: [], registration: [], matchmaking: [] },
  });
  await flush();
  expect(view.textContent).toContain("一部のイベントが間引かれています");
  expect(view.textContent).not.toContain("間引きの有無は確認できません");
  for (const title of ["流入元ごと", "登録の段階ごと", "マッチングの段階ごと"]) {
    expect(card(view, title).textContent).toContain("該当する記録は0件です。");
  }
});

test("取得に失敗したら共通のエラー表示と再試行を使い、応答スキーマの不正も表示しない", async () => {
  const view = render(<Kpi />);
  requests[0]!.respond({}, 503);
  await flush();
  expect(view.querySelector('[role="alert"]')?.textContent).toBe(
    "取得できません。再試行してください。",
  );
  expect(view.querySelector("h2")).toBeNull();
  press(view, "再試行");
  expect(requests[1]!.url).toBe(requests[0]!.url);
  requests[1]!.respond({ ...report(), players: "不正な値" });
  await flush();
  expect(view.querySelector('[role="alert"]')).not.toBeNull();
  expect(view.querySelector("h2")).toBeNull();
  press(view, "再試行");
  requests[2]!.respond(report());
  await flush();
  expect(view.querySelector('[role="alert"]')).toBeNull();
  expect(card(view, "完了対局数").textContent).toContain("1,234");
});

test("KPIへの直接アクセスはセッション確認後に画面を表示し、権限喪失でデータを破棄する", async () => {
  const view = render(
    <ThemeProvider>
      <MemoryRouter basename="/admin" initialEntries={["/admin/kpi"]}>
        <AdminApp />
      </MemoryRouter>
    </ThemeProvider>,
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe("/api/admin/session");
  await act(async () => {
    requests[0]!.respond({ name: "管理者", username: null });
    await import("../src/Kpi");
  });
  clock.advance(500);
  await flush();
  expect(requests).toHaveLength(2);
  expect(requests[1]!.url).toStartWith("/api/admin/kpi?");
  expect(view.querySelector('nav a[aria-current="page"]')?.textContent).toBe("KPI");
  requests[1]!.respond(report());
  await flush();
  expect(card(view, "対局者数").textContent).toContain("567");
  const { adminMutation } = await import("../src/api");
  const pending = adminMutation("/api/admin/lobby-chat", "POST", {
    action: "accepting",
    accepting: false,
  });
  await act(async () => {
    requests[2]!.respond({ message: "権限がありません" }, 403);
    await expect(pending).rejects.toThrow();
  });
  await flush();
  expect(view.textContent).not.toContain("567");
  expect(view.querySelector("h2")).toBeNull();
  expect(view.querySelector('[role="alert"]')?.textContent).toBe("権限がありません");
});
