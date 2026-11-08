import { colorNames, type AnalysisResponse, type Observation } from "./model";
export function boardCells(
  doc: Document,
  observation: Observation,
): Map<string, HTMLElement> | null {
  const boards = doc.querySelectorAll('[role="group"][aria-label="四人リバーシの盤面"]');
  if (boards.length !== 1 || !observation.game) return null;
  const cells = new Map<string, HTMLElement>();
  for (const element of boards[0].querySelectorAll<HTMLElement>("button[aria-label]")) {
    const match = element
      .getAttribute("aria-label")
      ?.match(/^([A-H])([1-8])：(空き|黒|白|赤|青)(?:、|$)/);
    if (!match) return null;
    const x = match[1].charCodeAt(0) - 65,
      y = Number(match[2]) - 1,
      key = `${x},${y}`;
    if (
      cells.has(key) ||
      match[3] !==
        (observation.game.board[y][x] ? colorNames[observation.game.board[y][x]!] : "空き")
    )
      return null;
    cells.set(key, element);
  }
  return cells.size === 64 ? cells : null;
}
export function paintOverlay(
  root: HTMLElement,
  observation: Observation,
  result: AnalysisResponse,
): boolean {
  root.replaceChildren();
  const cells = boardCells(root.ownerDocument, observation);
  if (!cells) return false;
  for (const [i, candidate] of result.candidates.entries()) {
    const cell = cells.get(`${candidate.position.x},${candidate.position.y}`)!;
    const rect = cell.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      root.replaceChildren();
      return false;
    }
    const mark = root.ownerDocument.createElement("span");
    mark.textContent = ["①", "②", "③"][i];
    Object.assign(mark.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      display: "grid",
      placeItems: "center",
      color: "#fff",
      font: `bold ${Math.max(14, Math.min(rect.width * 0.65, 40))}px sans-serif`,
      textShadow: "0 1px 3px #000",
      background: "#5334aa88",
      borderRadius: "50%",
      pointerEvents: "none",
    });
    root.append(mark);
  }
  return true;
}
