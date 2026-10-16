import { expect, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  Tournaments,
  TournamentCreatePage,
  TournamentEditPage,
  tournamentDateInput,
  tournamentDateValue,
} from "../src/Tournaments";
import { act, enter, flush, press, render, requests } from "../../web/test-dom/support";

const key = "00000000-0000-4000-8000-000000000001";
const record = {
  key,
  id: null,
  name: "第1回大会",
  description: "一行目\n二行目",
  rulesDescription: "途中参加できます。",
  startsAtMs: Date.parse("2099-10-24T20:00:00+09:00"),
  endsAtMs: Date.parse("2099-10-24T22:00:00+09:00"),
  published: false,
  version: 1,
  ruleVersion: 1,
  createdAtMs: 1,
  updatedAtMs: 1,
  entryCount: 2,
  status: "draft",
};
const entry = {
  name: "てとら",
  username: "tetra",
  avatarUrl: null,
  enteredAtMs: 1000,
  status: "waiting",
  games: 1,
  pointsUnits: 21,
  knockouts: 0,
  rank: 1,
};
const route = (path = `/tournaments/${key}`) => (
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/tournaments/new" element={<TournamentCreatePage />} />
      <Route path="/tournaments/:key" element={<TournamentEditPage />} />
    </Routes>
  </MemoryRouter>
);
async function loadEditor() {
  const view = render(route());
  requests[0]!.respond(record);
  await flush();
  requests[1]!.respond({ entries: [entry], total: 2, nextCursor: "more" });
  await flush();
  return view;
}
function input(view: HTMLElement, label: string) {
  return view.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
}

test("日本時間の入力を実行環境に依存せず変換し、存在しない日付を拒否する", () => {
  expect(tournamentDateInput(Date.parse("2026-10-16T15:00:00Z"))).toBe("2026-10-17T00:00");
  expect(tournamentDateValue("2026-10-17T00:00")).toBe(Date.parse("2026-10-16T15:00:00Z"));
  expect(tournamentDateValue("")).toBeNull();
  expect(Number.isNaN(tournamentDateValue("2026-02-30T20:00"))).toBe(true);
});

test("新規下書きは日時なしで保存でき、文字数・日時順を検証して二重送信を防ぐ", async () => {
  const view = render(route("/tournaments/new"));
  press(view, "保存");
  expect(requests).toHaveLength(0);
  enter(input(view, "大会名"), "新しい大会");
  enter(input(view, "大会の詳細"), "詳細\n<script>実行しない</script>");
  enter(input(view, "大会ごとの説明文"), "あ".repeat(2001));
  press(view, "保存");
  expect(requests).toHaveLength(0);
  enter(input(view, "大会ごとの説明文"), "気軽に参加してください。");
  enter(input(view, "開始日時（日本時間）"), "2099-10-24T22:00");
  enter(input(view, "終了日時（日本時間）"), "2099-10-24T20:00");
  press(view, "保存");
  expect(requests).toHaveLength(0);
  enter(input(view, "開始日時（日本時間）"), "");
  enter(input(view, "終了日時（日本時間）"), "");
  press(view, "プレビュー");
  const preview = view.querySelector('[aria-label="大会ページのプレビュー"]')!;
  expect(preview.textContent).toContain("詳細\n<script>実行しない</script>");
  expect(preview.querySelector("script")).toBeNull();
  expect(preview.textContent).toContain("秒読み30秒");
  expect(preview.querySelector("button")!.disabled).toBe(true);
  press(view, "保存");
  press(view, "保存");
  expect(requests).toHaveLength(1);
  const value = JSON.parse(String(requests[0]!.init.body));
  expect(value).toMatchObject({ name: "新しい大会", startsAtMs: null, endsAtMs: null });
  expect(Object.keys(value).sort()).toEqual([
    "description",
    "endsAtMs",
    "name",
    "rulesDescription",
    "startsAtMs",
  ]);
  requests[0]!.respond({ ...record, ...value }, 201);
  await flush();
  expect(requests[1]!.url).toBe(`/api/admin/tournaments/${key}`);
  requests[1]!.respond({ ...record, ...value });
  await flush();
  expect(view.textContent).toContain("大会を編集");
});

test("保存とプレビュー後の明示公開で版を送り、公開後は日時と機械条件を編集しない", async () => {
  const view = await loadEditor();
  expect(input(view, "開始日時（日本時間）").value).toBe("2099-10-24T20:00");
  expect(view.textContent).not.toContain("この内容で公開する");
  press(view, "プレビュー");
  press(view, "この内容で公開する");
  press(view, "公開しています…");
  expect(requests).toHaveLength(3);
  expect(requests[2]!.url).toBe(`/api/admin/tournaments/${key}/publish`);
  expect(JSON.parse(String(requests[2]!.init.body))).toEqual({ version: 1 });
  requests[2]!.respond({ ...record, id: 1, published: true, status: "upcoming", version: 2 });
  await flush();
  expect(view.textContent).toContain("公開しました");
  expect(input(view, "開始日時（日本時間）").disabled).toBe(true);
  expect(input(view, "終了日時（日本時間）").disabled).toBe(true);
  expect(view.querySelector('a[href="/tournaments/1"]')).not.toBeNull();
  enter(input(view, "大会名"), "表記を修正");
  press(view, "保存");
  expect(JSON.parse(String(requests[3]!.init.body))).toMatchObject({
    version: 2,
    name: "表記を修正",
    startsAtMs: record.startsAtMs,
    endsAtMs: record.endsAtMs,
  });
  requests[3]!.respond({
    ...record,
    name: "表記を修正",
    id: 1,
    published: true,
    status: "upcoming",
    version: 3,
  });
  await flush();
  press(view, "プレビュー");
  expect(view.textContent).not.toContain("この内容で公開する");
});

test("409と保存失敗で入力を保持し、明示再読込後に最新の版で保存する", async () => {
  const view = await loadEditor();
  enter(input(view, "大会名"), "保持する大会名");
  press(view, "プレビュー");
  expect(
    view.querySelector<HTMLButtonElement>('[aria-label="大会ページのプレビュー"] button')!.disabled,
  ).toBe(true);
  press(view, "保存");
  requests[2]!.respond({ message: "保存できません" }, 503);
  await flush();
  expect(input(view, "大会名").value).toBe("保持する大会名");
  press(view, "保存");
  requests[3]!.respond({ message: "他の管理者が変更しました" }, 409);
  await flush();
  expect(input(view, "大会名").value).toBe("保持する大会名");
  expect(view.textContent).toContain("入力を保持しています");
  press(view, "最新データを読み直す");
  requests[4]!.respond({ ...record, name: "別の編集", version: 2 });
  await flush();
  expect(input(view, "大会名").value).toBe("別の編集");
  press(view, "保存");
  expect(JSON.parse(String(requests[5]!.init.body)).version).toBe(2);
  requests[5]!.respond({ message: "権限がありません" }, 403);
  await flush();
  expect(view.querySelector("input")).toBeNull();
  expect(view.textContent).not.toContain(entry.name);
  expect(view.textContent).not.toContain("別の編集");
});

test("大会一覧の追加取得と再試行で既存行を保ち、権限喪失で全行を破棄する", async () => {
  const view = render(
    <MemoryRouter>
      <Tournaments />
    </MemoryRouter>,
  );
  requests[0]!.respond({ tournaments: [record], nextCursor: "more" });
  await flush();
  expect(view.textContent).toContain("下書き");
  expect(view.textContent).toContain("エントリー 2人");
  press(view, "次の50件");
  expect(requests[1]!.url).toBe("/api/admin/tournaments?cursor=more");
  requests[1]!.respond({ message: "一時的な失敗" }, 503);
  await flush();
  expect(view.textContent).toContain(record.name);
  press(view, "次の50件");
  requests[2]!.respond({
    tournaments: [
      {
        ...record,
        key: "00000000-0000-4000-8000-000000000002",
        name: "次の大会",
        published: true,
        status: "upcoming",
        id: 1,
      },
    ],
    nextCursor: "last",
  });
  await flush();
  expect(view.textContent).toContain("次の大会");
  expect(view.textContent).toContain(record.name);
  press(view, "次の50件");
  requests[3]!.respond({ message: "ログインしてください" }, 401);
  await flush();
  expect(view.textContent).not.toContain(record.name);
  expect(view.textContent).not.toContain("次の大会");
  expect(view.querySelector('a[href="/login?destination=admin"]')).not.toBeNull();
});

test("管理名簿は未対局者も追加表示し、名前・公開ID検索で条件を分離して権限喪失で編集内容も破棄する", async () => {
  const view = await loadEditor();
  expect(view.textContent).toContain("全エントリー 2人");
  expect(view.textContent).toContain("1.75");
  expect(view.textContent).toContain("対戦相手を待機中");
  press(view, "次の50人");
  expect(requests[2]!.url).toContain("search=&cursor=more");
  requests[2]!.respond({
    entries: [
      {
        ...entry,
        username: "unplayed",
        name: "未対局の人",
        games: 0,
        pointsUnits: 0,
        rank: null,
        status: "idle",
      },
    ],
    total: 2,
    nextCursor: null,
  });
  await flush();
  expect(view.textContent).toContain("未対局の人");
  enter(input(view, "名前・公開IDで検索"), "@tetra");
  act(() =>
    view
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(requests[3]!.url).toContain("search=%40tetra");
  expect(view.textContent).not.toContain("未対局の人");
  expect(view.textContent).not.toContain("検索結果 0人");
  requests[3]!.respond({
    entries: [{ ...entry, status: "matched" }],
    total: 1,
    nextCursor: "restricted",
  });
  await flush();
  expect(view.textContent).toContain("検索結果 1人");
  expect(view.textContent).toContain("入室待ち");
  enter(input(view, "大会名"), "破棄する入力");
  press(view, "次の50人");
  requests[4]!.respond({ message: "権限がありません" }, 403);
  await flush();
  expect(view.querySelector("input")).toBeNull();
  expect(view.textContent).not.toContain(entry.name);
  expect(view.textContent).not.toContain(record.name);
  expect(view.textContent).not.toContain("破棄する入力");
});
