import { expect, test } from "bun:test";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { HomeGameList, LobbyGameGrid } from "../src/features/lobby/LobbyGameGrid";
import { act, press, render, rerender, wrap } from "./harness";

const cards = (count: number) =>
  Array.from({ length: count }, (_, index) => (
    <a key={index} href={`/games/example-${index}`}>
      ゲーム{index + 1}
    </a>
  ));

test("6件以下のスマホ一覧はすべて表示し、開閉ボタンを置かない", () => {
  const view = render(<HomeGameList mobile>{cards(6)}</HomeGameList>);
  expect(view.querySelectorAll("a")).toHaveLength(6);
  expect(view.querySelector("button")).toBeNull();
});

for (const count of [7, 9, 12]) {
  test(`${count}ゲームでも初期6件から残り全件を展開し、閉じると6件に戻る`, () => {
    const view = render(<HomeGameList mobile>{cards(count)}</HomeGameList>);
    expect(view.querySelectorAll("a")).toHaveLength(6);
    const button = view.querySelector<HTMLButtonElement>("button")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(button.getAttribute("aria-controls")!)).not.toBeNull();
    press(view, `残り${count - 6}ゲームを表示`);
    expect(view.querySelectorAll("a")).toHaveLength(count);
    expect(view.querySelectorAll("a")[6].getAttribute("href")).toBe("/games/example-6");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    act(() => button.focus());
    press(view, "閉じる");
    expect(view.querySelectorAll("a")).toHaveLength(6);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });
}

test("PCは全件を表示し、スマホへの切り替え後は6件から展開できる", () => {
  const children = cards(12);
  const view = render(<HomeGameList mobile={false}>{children}</HomeGameList>);
  expect(view.querySelectorAll("a")).toHaveLength(12);
  expect(view.querySelector("button")).toBeNull();
  rerender(view, <HomeGameList mobile>{children}</HomeGameList>);
  expect(view.querySelectorAll("a")).toHaveLength(6);
  press(view, "残り6ゲームを表示");
  rerender(view, <HomeGameList mobile={false}>{children}</HomeGameList>);
  expect(view.querySelectorAll("a")).toHaveLength(12);
  expect(view.querySelector("button")).toBeNull();
  rerender(view, <HomeGameList mobile>{children}</HomeGameList>);
  expect(view.querySelectorAll("a")).toHaveLength(12);
  press(view, "閉じる");
  expect(view.querySelectorAll("a")).toHaveLength(6);
});

test("ホームは全登録ゲームのロビーへ移動でき、既存の表示順と名前を保持する", () => {
  const view = render(wrap()(<LobbyGameGrid />));
  const links = [...view.querySelectorAll("a")];
  expect(links.slice(0, 6).map((link) => link.getAttribute("href"))).toEqual([
    "/games/four-shogi",
    "/games/four-reversi",
    "/games/four-gomoku",
    "/games/shogi",
    "/games/reversi",
    "/games/gomoku",
  ]);
  expect(links).toHaveLength(gameIds.length);
  for (const game of gameIds) {
    expect(view.querySelector(`a[href="${gameCatalog[game].lobbyPath}"]`)?.textContent).toContain(
      gameCatalog[game].name,
    );
  }
  expect(view.querySelector("button")).toBeNull();
});
