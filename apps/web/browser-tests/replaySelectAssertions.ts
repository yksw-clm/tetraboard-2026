import { expect, type Page } from "@playwright/test";

export async function expectReplaySelectFits(page: Page) {
  const trigger = page.getByRole("button", { name: /棋譜の局面$/ });
  const value = trigger.locator('[data-slot="select-value"]');
  await expect(value).toHaveCSS("white-space", "nowrap");
  await expect(value).toHaveCSS("text-overflow", "ellipsis");
  const dimensions = await value.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
  }));
  expect(dimensions.height).toBeLessThanOrEqual(dimensions.lineHeight + 1);
  const popup = page.locator('[data-slot="select-popover"]');
  const box = await popup.boundingBox();
  if (!box) throw new Error("Replay options missing");
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  const options = page.getByRole("option");
  expect(await options.count()).toBeGreaterThan(0);
  const rows = await options.evaluateAll((elements) =>
    elements.map((element) => {
      const text = element.querySelector("span.truncate")!;
      return { label: text.textContent!, whiteSpace: getComputedStyle(text).whiteSpace };
    }),
  );
  const accessible = await page.getByRole("listbox").ariaSnapshot();
  for (const row of rows) {
    expect(row.whiteSpace).toBe("nowrap");
    expect(accessible).toContain(`option ${JSON.stringify(row.label)}`);
  }
}
