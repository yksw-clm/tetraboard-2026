import { expect, test } from "bun:test";
import { MemoryRouter, useNavigate } from "react-router";
import { AcquisitionDashboard } from "../src/AcquisitionDashboard";
import { TrackingLinks } from "../src/TrackingLinks";
import { act, render, flush, requests, press, enter, clock } from "../../web/test-dom/support";
function Back() {
  const navigate = useNavigate();
  return <button onClick={() => void navigate(-1)}>戻る</button>;
}
const meta = () => ({
  collectedFromMs: Date.now() - 60 * 86400000,
  aggregatedAtMs: Date.now(),
  metricVersion: 1 as const,
  status: "ready" as const,
});
test("集客と登録は実参照元・リンク・新規と既存を区別し、URLの条件と戻る操作・権限喪失へ追従する", async () => {
  const view = render(
    <MemoryRouter>
      <AcquisitionDashboard />
      <Back />
    </MemoryRouter>,
  );
  requests[0]!.respond({
    ...meta(),
    hostAvailable: true,
    rows: [
      {
        dimension: "link",
        value: "1",
        medium: "social",
        campaign: "profile",
        label: "開発者Xプロフィール",
        visits: 9,
        started: 2,
      },
      {
        dimension: "host",
        value: "private.example",
        medium: "",
        campaign: "",
        label: null,
        visits: 9,
        started: null,
      },
    ],
  });
  requests[1]!.respond({
    ...meta(),
    dateBasis: "entry",
    rows: [
      {
        day: "2026-10-03",
        entryDay: "2026-10-03",
        entry: "room-result",
        game: "shogi",
        kind: "guest",
        stage: "registered",
        linkId: 1,
        source: "link-1",
        medium: "social",
        campaign: "profile",
        referrerClass: "social",
        device: "mobile",
        count: 2,
      },
      {
        day: "2026-10-03",
        entryDay: "2026-10-03",
        entry: "room-result",
        game: "shogi",
        kind: "guest",
        stage: "existing_login",
        linkId: 1,
        source: "link-1",
        medium: "social",
        campaign: "profile",
        referrerClass: "social",
        device: "mobile",
        count: 3,
      },
    ],
  });
  await flush();
  expect(view.textContent).toContain("開発者Xプロフィール (#1)");
  expect(view.textContent).toContain("private.example");
  expect(view.textContent).toContain("新規登録");
  expect(view.textContent).toContain("既存ログイン");
  expect(view.textContent).toContain("対局結果");
  const game = view.querySelector<HTMLSelectElement>('[aria-label="ゲーム"]')!;
  act(() => {
    game.value = "shogi";
    game.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const old = requests.at(-1)!;
  expect(old.url).toContain("game=shogi");
  expect(view.textContent).not.toContain("private.example");
  const basis = view.querySelector<HTMLSelectElement>('[aria-label="日付基準"]')!;
  act(() => {
    basis.value = "event";
    basis.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(old.init.signal!.aborted).toBe(true);
  expect(requests.at(-1)!.url).toContain("dateBasis=event");
  press(view, "戻る");
  expect(requests.at(-1)!.url).toContain("dateBasis=entry");
  const lastAcquisition = requests.at(-2)!;
  lastAcquisition.respond({ ...meta(), hostAvailable: true, rows: [] });
  requests.at(-1)!.respond({ ...meta(), dateBasis: "entry", rows: [] });
  await flush();
  expect(view.textContent).toContain("0件");
  press(view, "直近7日");
  requests.at(-2)!.respond({ message: "権限がありません" }, 403);
  old.respond({ ...meta(), dateBasis: "entry", rows: [] });
  await flush();
  expect(view.textContent).not.toContain("private.example");
  expect(view.textContent).toContain("権限がありません");
});
test("導入前の空期間は未計測を示し、0件へ置き換えない", async () => {
  const view = render(
    <MemoryRouter initialEntries={["/?from=2020-01-01&to=2020-01-02"]}>
      <AcquisitionDashboard />
    </MemoryRouter>,
  );
  requests[0]!.respond({ ...meta(), hostAvailable: false, rows: [] });
  requests[1]!.respond({ ...meta(), dateBasis: "entry", rows: [] });
  await flush();
  expect(view.textContent).toContain("未計測");
  expect(view.textContent).not.toContain("0件");
});
const link = (id: number, label: string) => ({
  id,
  label,
  medium: "social",
  campaign: "post",
  archived: false,
  createdAtMs: 1,
});
test("計測リンクを追加発行・改名・アーカイブし、失敗時の入力と固定番号の意味を維持する", async () => {
  const view = render(<TrackingLinks />);
  requests[0]!.respond({ links: [link(1, "固定"), link(5, "追加")], nextCursor: 50 });
  await flush();
  const fixed = [...view.querySelectorAll("tr")].find((r) => r.textContent?.includes("固定"))!;
  expect(
    [...fixed.querySelectorAll("button")].find((b) => b.textContent === "表示名を変更")!.disabled,
  ).toBe(true);
  enter(view.querySelector<HTMLInputElement>('[aria-label="表示名"]')!, "新しい投稿");
  enter(view.querySelector<HTMLInputElement>('[aria-label="媒体"]')!, "social");
  enter(view.querySelector<HTMLInputElement>('[aria-label="施策名"]')!, "launch");
  act(() =>
    view
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  act(() =>
    view
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(requests).toHaveLength(2);
  expect(JSON.parse(String(requests[1]!.init.body)).label).toBe("新しい投稿");
  requests[1]!.respond(link(6, "新しい投稿"), 201);
  await flush();
  requests[2]!.respond({
    links: [link(1, "固定"), link(5, "追加"), link(6, "新しい投稿")],
    nextCursor: 50,
  });
  await flush();
  expect(view.querySelector<HTMLInputElement>('[aria-label="発行したURL"]')!.value).toBe(
    "https://tetraboard.test/?utm=6",
  );
  const added = [...view.querySelectorAll("tr")].find((r) => r.textContent?.includes("追加"))!;
  act(() =>
    [...added.querySelectorAll("button")].find((b) => b.textContent === "表示名を変更")!.click(),
  );
  await flush();
  const label = document.querySelector<HTMLInputElement>('[aria-label="新しい表示名"]')!;
  enter(label, "変更した表示名");
  press(document.body, "保存");
  requests[3]!.respond({ message: "保存に失敗" }, 503);
  await flush();
  expect(label.value).toBe("変更した表示名");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("保存に失敗");
  press(document.body, "保存");
  requests[4]!.respond(link(5, "変更した表示名"));
  await flush();
  clock.advance(300);
  await flush();
  expect(view.textContent).toContain("変更した表示名");
  const renamed = [...view.querySelectorAll("tr")].find((r) =>
    r.textContent?.includes("変更した表示名"),
  )!;
  act(() =>
    [...renamed.querySelectorAll("button")].find((b) => b.textContent === "アーカイブ")!.click(),
  );
  expect(JSON.parse(String(requests[5]!.init.body))).toEqual({ archived: true });
  requests[5]!.respond({ ...link(5, "変更した表示名"), archived: true });
  await flush();
  expect(renamed.textContent).toContain("アーカイブ済み");
  press(view, "もっと見る");
  requests[6]!.respond({ message: "権限がありません" }, 403);
  await flush();
  expect(view.textContent).not.toContain("変更した表示名");
});
