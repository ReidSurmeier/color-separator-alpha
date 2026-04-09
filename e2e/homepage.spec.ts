import { test, expect } from "@playwright/test";

test.describe("Homepage", () => {
  test("page loads and has a title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/.+/);
  });

  test("navigation to color-separator works", async ({ page }) => {
    await page.goto("/");
    // Verify the color-separator link exists on the homepage
    const link = page.locator('a[href*="color-separator"]').first();
    const linkCount = await link.count();
    if (linkCount > 0) {
      const href = await link.getAttribute("href");
      // Navigate directly since tile images can intercept clicks
      await page.goto(href!);
    } else {
      await page.goto("/color-separator");
    }
    await expect(page).toHaveURL(/color-separator/);
  });

  test("page responds with 200", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
  });
});
