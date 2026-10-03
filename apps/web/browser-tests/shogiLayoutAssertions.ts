import { expect, type Page } from "@playwright/test";

export async function expectShogiLayoutFits(page: Page) {
  const layout = page.getByTestId("shogi-board-layout");
  await expect(layout).toBeVisible();
  await expect
    .poll(() =>
      layout.evaluate((element) => {
        const panel = element.parentElement!;
        const bounds = panel.getBoundingClientRect();
        const cards = [...element.querySelectorAll('[data-testid="player-card"]')];
        const hands = [...element.querySelectorAll('[data-testid="shogi-hand"]')].filter(
          (hand) => hand.getBoundingClientRect().width > 0,
        );
        const board = element.querySelector('[data-testid="shogi-board"]')!.getBoundingClientRect();
        const cardBoxes = cards.map((card) => card.getBoundingClientRect());
        const boxes = [...cardBoxes, ...hands.map((hand) => hand.getBoundingClientRect()), board];
        return {
          cards: cards.length,
          hands: hands.length,
          equalCardWidths: cardBoxes.every((box) => Math.abs(box.width - cardBoxes[0]!.width) <= 1),
          fixedCardHeights: cardBoxes.every((box) => box.height === (innerWidth <= 767 ? 48 : 60)),
          namesFit: cards.every((card) => {
            const slot = card.querySelector('[data-testid="player-name"]')!;
            const text = slot.firstElementChild!.getBoundingClientRect();
            const box = slot.getBoundingClientRect();
            return text.left >= box.left - 1 && text.right <= box.right + 1;
          }),
          boardRatio: Math.abs(board.width / board.height - 458 / 500) < 0.002,
          noHorizontalScroll: panel.scrollWidth <= panel.clientWidth + 1,
          withinPanelWidth: boxes.every(
            (box) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1,
          ),
          noOverlap: boxes.every((box, index) =>
            boxes
              .slice(index + 1)
              .every(
                (other) =>
                  box.right <= other.left + 1 ||
                  other.right <= box.left + 1 ||
                  box.bottom <= other.top + 1 ||
                  other.bottom <= box.top + 1,
              ),
          ),
        };
      }),
    )
    .toEqual({
      cards: 4,
      hands: 4,
      equalCardWidths: true,
      fixedCardHeights: true,
      namesFit: true,
      boardRatio: true,
      noHorizontalScroll: true,
      withinPanelWidth: true,
      noOverlap: true,
    });
}

export const shogiCardViewports = [
  { width: 767, height: 757 },
  { width: 768, height: 757 },
  { width: 768, height: 520 },
  { width: 1024, height: 600 },
  { width: 1279, height: 757 },
  { width: 1280, height: 757 },
  { width: 1440, height: 520 },
];
