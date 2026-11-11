import { afterEach, expect, test } from "bun:test";
import { boardCells } from "../src/overlay";
import { colorNames } from "../src/model";
import { observation } from "./fixtures";
afterEach(() => document.body.replaceChildren());
function board(reverse = false) {
  const o = observation(),
    element = document.createElement("div");
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "四人リバーシの盤面");
  const cells = [];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const b = document.createElement("button"),
        cell = o.game!.board[y][x];
      b.setAttribute(
        "aria-label",
        `${"ABCDEFGH"[x]}${y + 1}：${cell ? colorNames[cell] : "空き"}、置けます`,
      );
      cells.push(b);
    }
  element.append(...(reverse ? cells.reverse() : cells));
  document.body.append(element);
  return { o, element };
}
test("DOMの配置順によらず座標ラベルで64マスを対応付ける", () => {
  const { o } = board(true);
  const map = boardCells(document, o)!;
  expect(map.size).toBe(64);
  expect(map.get("0,0")?.getAttribute("aria-label")).toStartWith("A1：");
  expect(map.get("7,7")?.getAttribute("aria-label")).toStartWith("H8：");
});
test("盤面不一致・欠落・重複・複数盤面では番号を描けると判定しない", () => {
  const { o, element } = board();
  const button = element.querySelector("button")!;
  button.setAttribute("aria-label", "A1：黒");
  expect(boardCells(document, o)).toBeNull();
  button.setAttribute("aria-label", "A1：空き");
  element.lastChild?.remove();
  expect(boardCells(document, o)).toBeNull();
  document.body.replaceChildren();
  const second = board();
  second.element.querySelector("button")!.setAttribute("aria-label", "B1：空き");
  expect(boardCells(document, o)).toBeNull();
  document.body.replaceChildren();
  board();
  board();
  expect(boardCells(document, o)).toBeNull();
});
