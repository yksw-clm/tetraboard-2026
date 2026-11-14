import {
  colorNames,
  sideNames,
  pieceNames,
  type ContinuousResponse,
  type Observation,
} from "./model";
const numbers = ["①", "②", "③"];
const arrowColors = ["#52e1ff", "#ffc65c", "#ef94ff"];
// 盤面の読み上げ名は、棋譜の略称「飛」と区別します。
const boardPieceNames = { ...pieceNames, rook: "飛車" };
export function boardCells(
  doc: Document,
  observation: Observation,
): Map<string, HTMLElement> | null {
  const shogi = observation.gameId === "four-shogi",
    size = shogi ? 9 : 8;
  const boards = doc.querySelectorAll(
    `[role="group"][aria-label="${shogi ? "四人将棋" : "四人リバーシ"}の盤面"]`,
  );
  if (boards.length !== 1 || !observation.game) return null;
  const cells = new Map<string, HTMLElement>();
  for (const element of boards[0].querySelectorAll<HTMLElement>("button[aria-label]")) {
    const match = element.getAttribute("aria-label")?.match(/^([A-I])([1-9])：([^、]+)(?:、|$)/);
    if (!match) return null;
    const x = match[1].charCodeAt(0) - 65,
      y = Number(match[2]) - 1,
      key = `${x},${y}`;
    if (x >= size || y >= size || cells.has(key)) return null;
    let label: string;
    if (observation.gameId === "four-shogi" && observation.game) {
      const p = observation.game.board[y][x],
        dead = p && observation.game.eliminations.some((e) => e.side === p.side);
      label = p
        ? `${sideNames[p.side]}の${p.kind === "king" && dead ? "裏王" : p.promoted ? { rook: "龍", silver: "成銀", pawn: "と金", gold: "金", king: "王" }[p.kind] : boardPieceNames[p.kind]}`
        : "空き";
      if (element.dataset.square !== `${match[1]}${match[2]}` || element.dataset.pendingMove)
        return null;
    } else if (observation.gameId === "four-reversi" && observation.game) {
      const cell = observation.game.board[y][x];
      label = cell ? colorNames[cell] : "空き";
    } else return null;
    if (match[3] !== label) return null;
    cells.set(key, element);
  }
  return cells.size === size * size ? cells : null;
}
export function paintOverlay(
  root: HTMLElement,
  observation: Observation,
  result: ContinuousResponse,
): boolean {
  root.replaceChildren();
  const cells = boardCells(root.ownerDocument, observation);
  if (!cells || observation.gameId !== result.game) return false;
  const rects = new Map<string, DOMRect>();
  for (const [key, cell] of cells) {
    const rect = cell.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    rects.set(key, rect);
  }
  const fragment = root.ownerDocument.createDocumentFragment();
  const groups = new Map<string, number[]>();
  if (result.game === "four-shogi") {
    const svg = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
    Object.assign(svg.style, {
      position: "fixed",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      overflow: "visible",
    });
    for (const [i, candidate] of result.candidates.entries()) {
      const to = candidate.action.to,
        key = `${to.x},${to.y}`;
      groups.set(key, [...(groups.get(key) ?? []), i]);
      if (candidate.action.type === "dropPiece") continue;
      const from = candidate.action.from,
        a = rects.get(`${from.x},${from.y}`),
        b = rects.get(key);
      if (!a || !b) return false;
      const ax = a.left + a.width / 2,
        ay = a.top + a.height / 2,
        bx = b.left + b.width / 2,
        by = b.top + b.height / 2;
      const dx = bx - ax,
        dy = by - ay,
        length = Math.hypot(dx, dy);
      if (!length) return false;
      const offset = (i - 1) * Math.min(4, a.width * 0.08),
        ox = (-dy / length) * offset,
        oy = (dx / length) * offset;
      const marker = root.ownerDocument.createElementNS(svg.namespaceURI, "marker");
      marker.setAttribute("id", `tetraboard-local-arrow-${i}`);
      for (const [name, value] of Object.entries({
        viewBox: "0 0 10 10",
        refX: "9",
        refY: "5",
        markerWidth: "4",
        markerHeight: "4",
        orient: "auto-start-reverse",
      }))
        marker.setAttribute(name, value);
      const head = root.ownerDocument.createElementNS(svg.namespaceURI, "path");
      head.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
      head.setAttribute("fill", arrowColors[i]);
      marker.append(head);
      const line = root.ownerDocument.createElementNS(svg.namespaceURI, "path");
      const endInset = Math.min(b.width * 0.22, length * 0.2);
      line.setAttribute(
        "d",
        `M ${ax + ox} ${ay + oy} L ${bx + ox - (dx / length) * endInset} ${by + oy - (dy / length) * endInset}`,
      );
      line.setAttribute("stroke", arrowColors[i]);
      line.setAttribute("stroke-width", String(Math.max(2, Math.min(a.width * 0.09, 5))));
      line.setAttribute("fill", "none");
      line.setAttribute("marker-end", `url(#tetraboard-local-arrow-${i})`);
      line.setAttribute("data-candidate", String(i + 1));
      svg.append(marker, line);
    }
    fragment.append(svg);
  } else {
    for (const [i, c] of result.candidates.entries())
      groups.set(`${c.position.x},${c.position.y}`, [i]);
  }
  for (const [key, indexes] of groups) {
    const rect = rects.get(key);
    if (!rect) return false;
    const mark = root.ownerDocument.createElement("span");
    mark.textContent = indexes.map((i) => numbers[i]).join("");
    Object.assign(mark.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      display: "grid",
      placeItems: "center",
      color: "#fff",
      font: `bold ${Math.max(12, Math.min(rect.width * (indexes.length > 1 ? 0.32 : 0.55), 32))}px sans-serif`,
      textShadow: "0 1px 3px #000",
      background: "#5334aa88",
      borderRadius: "50%",
      pointerEvents: "none",
    });
    fragment.append(mark);
  }
  root.append(fragment);
  return true;
}
