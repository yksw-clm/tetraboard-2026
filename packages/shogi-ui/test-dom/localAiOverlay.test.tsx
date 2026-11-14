import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FourShogiBoardLayout } from "../src/FourShogiBoardLayout";
import { boardCells, paintOverlay } from "../../../apps/local-ai-widget/src/overlay";
import { sides, type ContinuousResponse } from "../../../apps/local-ai-widget/src/model";
import {
  shogiObservation,
  continuousRequestFor,
  progressFor,
} from "../../../apps/local-ai-widget/test/fixtures";
const mounted: { root: Root; container: HTMLElement }[] = [];
afterEach(() => {
  for (const view of mounted.splice(0)) {
    act(() => view.root.unmount());
    view.container.remove();
  }
});
for (const viewerSide of sides) {
  test(`${viewerSide}: 実際の盤面の81マスを照合し、回転後の移動元から矢印を描ける`, () => {
    const observation = shogiObservation();
    if (!observation.game) throw Error("fixture");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() =>
      root.render(
        <FourShogiBoardLayout
          game={observation.game!}
          viewerSide={viewerSide}
          revision={0}
          canPlay={false}
          legalActions={observation.legalActions}
          playerCards={{}}
          onAction={() => {}}
        />,
      ),
    );
    const buttons = container.querySelectorAll<HTMLElement>(
      '[aria-label="四人将棋の盤面"] button[data-square]',
    );
    expect(buttons).toHaveLength(81);
    expect(container.querySelector('[data-square="E8"]')!.getAttribute("aria-label")).toContain(
      "南の飛車",
    );
    expect(boardCells(document, observation)?.size).toBe(81);
    buttons.forEach((button, index) => {
      button.getBoundingClientRect = () =>
        ({
          left: (index % 9) * 40,
          top: Math.floor(index / 9) * 40,
          width: 40,
          height: 40,
        }) as DOMRect;
    });
    const result: Extract<ContinuousResponse, { game: "four-shogi" }> = {
      ...progressFor(continuousRequestFor()),
      game: "four-shogi",
      candidates: [
        {
          action: { type: "movePiece", from: { x: 4, y: 6 }, to: { x: 4, y: 5 }, promote: false },
          score: 1,
        },
      ],
      diagnostics: { completed_depth: 1 },
    };
    const overlay = document.createElement("div");
    expect(paintOverlay(overlay, observation, result)).toBe(true);
    expect(overlay.querySelectorAll("path[data-candidate]")).toHaveLength(1);
    expect(overlay.querySelector("span")!.textContent).toBe("①");
  });
}
