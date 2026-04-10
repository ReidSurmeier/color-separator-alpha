/**
 * Color-separator E2E — 5 images through the REAL frontend at color.reidsurmeier.wtf.
 * Emulates user: upload, set plates, toggle upscale 2x/4x, process, download ZIP, merge.
 */
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const SITE_URL = "https://color.reidsurmeier.wtf";
const IMAGE_DIR = "/tmp/colorsep-test-images";
const RESULTS_FILE = "/tmp/colorsep-e2e-results.jsonl";

const TEST_CONFIGS: { image: string; plates: number; upscale: "off" | "2x" | "4x" }[] = [
  { image: "arena_06.jpg", plates: 4, upscale: "2x" },          // 2000x2500, 662KB painting
  { image: "arena_15.png", plates: 6, upscale: "4x" },          // 2560x2560, 3.7MB large digital
  { image: "ts_pixel_rug_2023.png", plates: 3, upscale: "off" }, // 2560x2560, 590KB pixel art
  { image: "ts_extra_05.jpg", plates: 8, upscale: "2x" },       // 3000x2084, 1.4MB Travess large
  { image: "arena_03.jpg", plates: 2, upscale: "4x" },          // 800x800, 30KB small image
];

interface TestResult {
  test_id: number;
  image: string;
  image_size_kb: number;
  plates: number;
  upscale: string;
  step: string;
  success: boolean;
  duration_s: number;
  error?: string;
  details?: Record<string, unknown>;
}

function logResult(result: TestResult) {
  fs.appendFileSync(RESULTS_FILE, JSON.stringify(result) + "\n");
  const status = result.success ? "OK" : "FAIL";
  console.log(
    `  [${status}] ${result.step} — ${result.duration_s.toFixed(1)}s${result.error ? ` (${result.error.slice(0, 120)})` : ""}`
  );
}

test.describe.serial("Color Separator 5-Image E2E", () => {
  test.beforeAll(() => {
    if (fs.existsSync(RESULTS_FILE)) fs.unlinkSync(RESULTS_FILE);
    fs.mkdirSync("/tmp/colorsep-zips", { recursive: true });
    fs.mkdirSync("/tmp/colorsep-screenshots", { recursive: true });
  });

  for (let i = 0; i < TEST_CONFIGS.length; i++) {
    const config = TEST_CONFIGS[i];
    const testId = i + 1;

    test(`Image ${testId}/5: ${config.image} — ${config.plates} plates, upscale ${config.upscale}`, async ({
      page,
    }) => {
      test.setTimeout(600_000);

      const imagePath = path.join(IMAGE_DIR, config.image);
      const imageSize = fs.statSync(imagePath).size / 1024;

      console.log(`\n${"=".repeat(60)}`);
      console.log(
        `Test ${testId}/5: ${config.image} (${imageSize.toFixed(0)}KB) — ${config.plates} plates, upscale ${config.upscale}`
      );
      console.log("=".repeat(60));

      const base = {
        test_id: testId,
        image: config.image,
        image_size_kb: Math.round(imageSize),
        plates: config.plates,
        upscale: config.upscale,
      };

      // --- 1. Navigate ---
      let t0 = Date.now();
      await page.goto(SITE_URL, { waitUntil: "networkidle", timeout: 30_000 });
      logResult({ ...base, step: "page_load", success: true, duration_s: (Date.now() - t0) / 1000 });

      // --- 2. Upload ---
      t0 = Date.now();
      await page.locator('input[type="file"]').setInputFiles(imagePath);
      await page.waitForFunction(
        () => {
          const btn = document.querySelector(".source-btn");
          return btn && btn.textContent && !btn.textContent.includes("choose file");
        },
        { timeout: 10_000 }
      );
      logResult({ ...base, step: "upload", success: true, duration_s: (Date.now() - t0) / 1000 });

      // --- 3. Set plates ---
      t0 = Date.now();
      const slider = page.locator('input[type="range"]').first();
      await slider.fill(String(config.plates));
      logResult({ ...base, step: "set_plates", success: true, duration_s: (Date.now() - t0) / 1000 });

      // --- 4. Set upscale ---
      t0 = Date.now();
      const upscaleSection = page.locator(".upscale-toggle");
      if ((await upscaleSection.count()) > 0) {
        await upscaleSection.locator("button", { hasText: config.upscale }).click();
      }
      logResult({ ...base, step: "set_upscale", success: true, duration_s: (Date.now() - t0) / 1000 });

      // --- 5. Process ---
      t0 = Date.now();
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });

      await page.locator("button.process-btn").first().click();

      // Wait for ZIP button to become enabled (= processing complete)
      const processSuccess = await page
        .waitForFunction(
          () => {
            const btns = Array.from(document.querySelectorAll("button"));
            const zipBtn = btns.find((b) => b.textContent?.trim() === "ZIP");
            if (zipBtn && !(zipBtn as HTMLButtonElement).disabled) return "done";
            // Check for error
            const errBtns = btns.find((b) => b.textContent?.includes("dismiss"));
            if (errBtns) return "error";
            return false;
          },
          { timeout: 540_000 }
        )
        .then((handle) => handle.jsonValue())
        .catch(() => "timeout");

      const processDuration = (Date.now() - t0) / 1000;

      if (processSuccess === "done") {
        logResult({
          ...base,
          step: "process",
          success: true,
          duration_s: processDuration,
          details: { console_errors: consoleErrors.length > 0 ? consoleErrors.slice(0, 3) : undefined },
        });
      } else {
        const errorText = await page.evaluate(() => {
          const el = document.querySelector(".error-toast, .error-banner, [class*='error']");
          return el?.textContent ?? "Unknown error";
        });
        logResult({
          ...base,
          step: "process",
          success: false,
          duration_s: processDuration,
          error: processSuccess === "timeout" ? "Timed out after 540s" : errorText,
        });
        await page.screenshot({ path: `/tmp/colorsep-screenshots/FAIL_test_${testId}.png`, fullPage: true });
        return;
      }

      // --- 6. Download ZIP ---
      // Frontend uses programmatic blob download. Click ZIP, wait for progress then completion.
      t0 = Date.now();
      try {
        // Click the download/ZIP button
        const h3Download = page.locator("h3").filter({ hasText: /^download$/ });
        const zipBtn = h3Download.locator("~ button").first();
        await zipBtn.click();

        // Wait for the button to become disabled (download started)
        await page.waitForTimeout(500);

        // Then wait for it to become enabled again with text "ZIP" (download completed)
        await page.waitForFunction(
          () => {
            const h3s = Array.from(document.querySelectorAll("h3"));
            const dlH3 = h3s.find(h => h.textContent?.trim() === "download");
            if (!dlH3) return false;
            const btn = dlH3.nextElementSibling as HTMLButtonElement | null;
            if (!btn || btn.tagName !== "BUTTON") return false;
            return btn.textContent?.trim() === "ZIP" && !btn.disabled;
          },
          { timeout: 300_000 }
        );

        logResult({
          ...base,
          step: "download_zip",
          success: true,
          duration_s: (Date.now() - t0) / 1000,
        });
      } catch (e) {
        logResult({
          ...base,
          step: "download_zip",
          success: false,
          duration_s: (Date.now() - t0) / 1000,
          error: String(e).slice(0, 200),
        });
      }

      // --- 7. Merge (if plates >= 3) ---
      if (config.plates >= 3) {
        t0 = Date.now();
        try {
          const selectBtn = page.locator("button").filter({ hasText: "select plates" }).first();
          if ((await selectBtn.count()) > 0 && !(await selectBtn.isDisabled())) {
            await selectBtn.click();
            await page.waitForTimeout(500);

            // Click first two plate thumbnails
            const plateCards = page.locator("[class*='plate']").filter({ has: page.locator("img, canvas") });
            const plateCount = await plateCards.count();
            if (plateCount >= 2) {
              await plateCards.nth(0).click();
              await page.waitForTimeout(300);
              await plateCards.nth(1).click();
              await page.waitForTimeout(300);

              const mergeBtn = page.locator("button.process-btn").filter({ hasText: "merge" }).first();
              if ((await mergeBtn.count()) > 0 && !(await mergeBtn.isDisabled())) {
                await mergeBtn.click();
                await page.waitForFunction(
                  () => !Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("merging")),
                  { timeout: 120_000 }
                );
                logResult({ ...base, step: "merge", success: true, duration_s: (Date.now() - t0) / 1000 });
              } else {
                logResult({ ...base, step: "merge", success: false, duration_s: (Date.now() - t0) / 1000, error: "Merge button disabled" });
              }
            } else {
              logResult({ ...base, step: "merge", success: false, duration_s: (Date.now() - t0) / 1000, error: `Only ${plateCount} plate elements` });
            }
          } else {
            logResult({ ...base, step: "merge", success: false, duration_s: (Date.now() - t0) / 1000, error: "Select plates btn not found" });
          }
        } catch (e) {
          logResult({ ...base, step: "merge", success: false, duration_s: (Date.now() - t0) / 1000, error: String(e).slice(0, 200) });
        }
      }

      // Screenshot
      await page.screenshot({ path: `/tmp/colorsep-screenshots/test_${String(testId).padStart(2, "0")}.png`, fullPage: true });
    });
  }
});
