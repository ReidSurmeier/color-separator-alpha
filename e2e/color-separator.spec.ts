import { test, expect } from "@playwright/test";

test.describe("Color Separator page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/color-separator");
  });

  test("page loads successfully", async ({ page }) => {
    await expect(page).toHaveURL(/color-separator/);
    const response = await page.goto("/color-separator");
    expect(response?.status()).toBe(200);
  });

  test("upload area is visible", async ({ page }) => {
    // Look for file input or drop zone
    const fileInput = page.locator('input[type="file"]');
    const dropZone = page.locator('[data-testid="drop-zone"], .drop-zone, [class*="upload"], [class*="drop"]').first();
    const hasFileInput = (await fileInput.count()) > 0;
    const hasDropZone = (await dropZone.count()) > 0;
    expect(hasFileInput || hasDropZone).toBe(true);
  });

  test("version selector is present", async ({ page }) => {
    // Version selector could be a select, radio group, or button group
    const versionSelect = page
      .locator('select, [role="listbox"], [role="radiogroup"], [data-testid*="version"]')
      .first();
    const versionButton = page.locator('button:has-text("v"), button:has-text("V")').first();
    const hasVersionSelect = (await versionSelect.count()) > 0;
    const hasVersionButton = (await versionButton.count()) > 0;
    expect(hasVersionSelect || hasVersionButton).toBe(true);
  });

  test("plate count slider or input exists", async ({ page }) => {
    // Plate count control — could be a range input, number input, or slider component
    const rangeInput = page.locator('input[type="range"]');
    const numberInput = page.locator('input[type="number"]');
    const slider = page.locator('[role="slider"], [data-testid*="plate"], [data-testid*="count"]').first();
    const hasRange = (await rangeInput.count()) > 0;
    const hasNumber = (await numberInput.count()) > 0;
    const hasSlider = (await slider.count()) > 0;
    expect(hasRange || hasNumber || hasSlider).toBe(true);
  });
});
