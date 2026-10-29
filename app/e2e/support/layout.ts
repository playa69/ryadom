import { expect, type Locator, type Page } from '@playwright/test'

/** The element's box lies inside the window: no edge of the screen cuts any of it off. */
export async function expectInsideViewport(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox()
  const size = page.viewportSize()
  expect(box, 'у элемента нет рамки').not.toBeNull()
  expect(size, 'у страницы нет размера окна').not.toBeNull()
  // A pixel of slack for the rounding of a box that sits exactly on the edge.
  expect(box!.x, 'элемент выходит за левый край').toBeGreaterThanOrEqual(-1)
  expect(box!.y, 'элемент выходит за верхний край').toBeGreaterThanOrEqual(-1)
  expect(box!.x + box!.width, 'элемент выходит за правый край').toBeLessThanOrEqual(size!.width + 1)
  expect(box!.y + box!.height, 'элемент выходит за нижний край').toBeLessThanOrEqual(size!.height + 1)
}
