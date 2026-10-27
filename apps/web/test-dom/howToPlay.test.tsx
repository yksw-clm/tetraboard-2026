import { expect, test } from "bun:test";
import { Route, Routes } from "react-router";
import { HowToPlayPage } from "../src/features/help/HowToPlayPage";
import { act, flush, render, requests, wrap } from "./harness";

const chapters = [
  ["choose-game", "ゲームを選ぶ"],
  ["cpu", "CPUと遊ぶ"],
  ["friends", "友達を招待する"],
  ["public-rooms", "公開ルームに参加・観戦する"],
  ["play", "対局画面を使う"],
  ["records", "対局の記録を見る"],
  ["tournaments", "大会に参加する"],
  ["account-settings", "アカウントと設定"],
] as const;

test("未認証でも8章の共通ガイドを読め、目次が各章の見出しへ対応する", () => {
  const view = render(wrap(null, "/how-to-play")(<HowToPlayPage />));
  const main = view.querySelector('main[aria-label="遊び方"]')!;
  expect(main.querySelector("h1")?.textContent).toBe("TetraBoardの使い方");
  const sections = [...main.querySelectorAll("section[id]")];
  expect(sections.map((section) => section.id)).toEqual(chapters.map(([id]) => id));
  const links = [...main.querySelectorAll<HTMLAnchorElement>('[aria-label="使い方の目次"] a')];
  expect(links).toHaveLength(chapters.length);
  for (const [index, [id, title]] of chapters.entries()) {
    expect(links[index]!.getAttribute("href")).toBe(`#${id}`);
    const section = main.querySelector(`#${id}`)!;
    const heading = section.querySelector("h2")!;
    expect(heading.textContent).toBe(title);
    expect(section.getAttribute("aria-labelledby")).toBe(heading.id);
  }
  expect(main.textContent).toContain("各ゲームのロビー右上にある「遊び方」");
  expect(main.textContent).toContain("人数や設定項目はゲームによって異なります");
  expect(main.querySelector("#cpu")!.textContent).toContain("下へスクロールして");
  expect(main.querySelector("#friends")!.textContent).toContain("すべてのルームは公開され");
  expect(main.querySelector("#friends")!.textContent).toContain("ホストが「対局開始」を押します");
  expect(main.querySelector("#play")!.textContent).toContain("退室も「ルーム」タブから");
  expect(main.querySelector("#records")!.textContent).toContain("ゲストで遊んだ対局も保存されます");
  expect(main.querySelector("#tournaments")!.textContent).toContain("開催前のエントリーは参加予約");
  expect(main.querySelector("#tournaments")!.textContent).toContain(
    "全員がルームに接続すると自動で対局が始まります",
  );
  expect(main.querySelector("#tournaments")!.textContent).toContain(
    "待機をやめるときは「取り消す」",
  );
  expect(main.querySelector("#tournaments")!.textContent).toContain("「入室する」を押すか、5秒後");
  expect(main.querySelector("#account-settings")!.textContent).toContain(
    "ゲストの対局記録も、アカウントの連携で引き継げます",
  );
  expect(main.querySelector("#account-settings")!.textContent).toContain(
    "Cookieを削除したり有効期限",
  );
  expect(requests).toHaveLength(0);
});

test("画面例に説明と寸法属性があり、PC補足を閉じて先頭以外の画像を遅延読込する", () => {
  const view = render(wrap(null, "/how-to-play")(<HowToPlayPage />));
  const main = view.querySelector("main")!;
  const figures = [...main.querySelectorAll("figure")];
  expect(figures).toHaveLength(11);
  const images = figures.map((figure) => figure.querySelector("img")!);
  expect(new Set(images.map((image) => image.getAttribute("src"))).size).toBe(11);
  expect(new Set(images.map((image) => image.alt)).size).toBe(11);
  for (const [index, figure] of figures.entries()) {
    const image = images[index]!;
    expect(image.alt.trim().length).toBeGreaterThan(0);
    expect(Number(image.getAttribute("width"))).toBeGreaterThan(0);
    expect(Number(image.getAttribute("height"))).toBeGreaterThan(0);
    expect(image.getAttribute("loading")).toBe(index === 0 ? "eager" : "lazy");
    expect(image.getAttribute("decoding")).toBe("async");
    expect(figure.querySelector("figcaption")!.textContent!.trim().length).toBeGreaterThan(0);
  }
  const examples = [...main.querySelectorAll("details")];
  expect(examples).toHaveLength(2);
  expect(examples.map((example) => example.closest("section")!.id)).toEqual([
    "choose-game",
    "play",
  ]);
  for (const example of examples) {
    expect(example.open).toBe(false);
    expect(example.querySelector("summary")!.textContent).toBe("PCの画面例");
    expect(example.querySelector("img")!.alt).toContain("PC");
  }
});

test("ガイド内の操作リンクから既存のホーム・ゲームロビー・アカウント画面へ進める", async () => {
  for (const [label, path] of [
    ["ホームでゲームを選ぶ", "/"],
    ["四人リバーシのロビーへ", "/games/four-reversi"],
    ["マイページへ", "/account"],
    ["四人将棋のロビーへ", "/games/four-shogi"],
    ["アカウントを開く", "/account"],
  ]) {
    const view = render(
      wrap(
        null,
        "/how-to-play",
      )(
        <Routes>
          <Route path="/how-to-play" element={<HowToPlayPage />} />
          <Route path={path} element={<p>移動先の画面</p>} />
        </Routes>,
      ),
    );
    const link = [...view.querySelectorAll<HTMLAnchorElement>("main a")].find(
      (item) => item.textContent === label,
    )!;
    expect(link.getAttribute("href")).toBe(path);
    act(() => link.click());
    await flush();
    expect(view.textContent).toBe("移動先の画面");
  }
  expect(requests).toHaveLength(0);
});
