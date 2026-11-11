import { afterEach, expect, test } from "bun:test";
import { boardCells, paintOverlay } from "../src/overlay";
import { colorNames, sideNames, pieceNames, type ContinuousResponse } from "../src/model";
import { observation, shogiObservation, continuousRequestFor, progressFor } from "./fixtures";
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

function shogiBoard(rotated = false) {
  const o = shogiObservation(),
    board = document.createElement("div");
  board.setAttribute("role", "group");
  board.setAttribute("aria-label", "四人将棋の盤面");
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 9; x++) {
      const cell = document.createElement("button"),
        p = o.game!.board[y][x];
      cell.dataset.square = `${"ABCDEFGHI"[x]}${y + 1}`;
      cell.setAttribute(
        "aria-label",
        `${cell.dataset.square}：${p ? `${sideNames[p.side]}の${p.kind === "rook" ? "飛車" : pieceNames[p.kind]}` : "空き"}、棋譜座標`,
      );
      cell.getBoundingClientRect = () =>
        ({
          left: (rotated ? 8 - y : x) * 32,
          top: (rotated ? x : y) * 32,
          width: 32,
          height: 32,
        }) as DOMRect;
      board.prepend(cell);
    }
  document.body.append(board);
  return { o, board };
}
test("将棋の移動候補は移動元から移動先への矢印で描き、盤面回転に追従する", () => {
  const root = document.createElement("div");
  let fixture = shogiBoard();
  const request = continuousRequestFor();
  const result: Extract<ContinuousResponse, { game: "four-shogi" }> = {
    ...progressFor(request),
    game: "four-shogi",
    candidates: [
      {
        action: { type: "movePiece", from: { x: 4, y: 6 }, to: { x: 4, y: 5 }, promote: false },
        score: 100,
      },
    ],
    diagnostics: { completed_depth: 1 },
  };
  expect(paintOverlay(root, fixture.o, result)).toBe(true);
  const normal = root.querySelector("path[data-candidate]")!.getAttribute("d");
  expect(root.querySelector("path[data-candidate]")!.getAttribute("marker-end")).toContain(
    "tetraboard-local-arrow-0",
  );
  expect(root.querySelector("svg")!.style.pointerEvents).toBe("none");
  document.body.replaceChildren();
  fixture = shogiBoard(true);
  expect(paintOverlay(root, fixture.o, result)).toBe(true);
  expect(root.querySelector("path[data-candidate]")!.getAttribute("d")).not.toBe(normal);
});
test("将棋の同じ移動先の番号はまとめ、駒打ちは番号だけを描く", () => {
  const { o, board } = shogiBoard(),
    root = document.createElement("div");
  const base = progressFor(continuousRequestFor());
  const result: Extract<ContinuousResponse, { game: "four-shogi" }> = {
    ...base,
    game: "four-shogi",
    candidates: [
      {
        action: { type: "movePiece", from: { x: 4, y: 6 }, to: { x: 4, y: 5 }, promote: false },
        score: 100,
      },
      { action: { type: "dropPiece", pieceKind: "pawn", to: { x: 4, y: 5 } }, score: 90 },
    ],
    diagnostics: { completed_depth: 1 },
  };
  expect(paintOverlay(root, o, result)).toBe(true);
  expect(root.querySelectorAll("path[data-candidate]")).toHaveLength(1);
  expect(root.querySelectorAll("span")).toHaveLength(1);
  expect(root.querySelector("span")!.textContent).toBe("①②");
  board.querySelector("button")!.setAttribute("data-pending-move", "to");
  expect(paintOverlay(root, o, result)).toBe(false);
  expect(root.childNodes).toHaveLength(0);
});
