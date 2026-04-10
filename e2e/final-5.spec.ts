import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const SITE = "https://color.reidsurmeier.wtf";
const IMG_DIR = "/tmp/colorsep-test-images";
const RESULTS = "/tmp/colorsep-final-results.jsonl";

const TESTS = [
  { image: "ts_pixel_rug_2023.png", plates: 3, upscale: "2x" },
  { image: "ts_extra_05.jpg", plates: 4, upscale: "off" },
  { image: "arena_06.jpg", plates: 3, upscale: "2x" },
  { image: "ts_extra_03.jpg", plates: 5, upscale: "off" },
  { image: "arena_03.jpg", plates: 2, upscale: "4x" },
];

function log(r: Record<string, unknown>) {
  fs.appendFileSync(RESULTS, JSON.stringify(r) + "\n");
  const ok = r.success ? "OK" : "FAIL";
  const err = r.error ? ` (${String(r.error).slice(0, 80)})` : "";
  console.log(`  [${ok}] ${r.step} — ${Number(r.duration_s).toFixed(1)}s${err}`);
}

test.describe.serial("Final 5-Image E2E with Download", () => {
  test.beforeAll(() => { if (fs.existsSync(RESULTS)) fs.unlinkSync(RESULTS); });

  for (let i = 0; i < TESTS.length; i++) {
    const cfg = TESTS[i];
    const tid = i + 1;

    test(`T${tid}: ${cfg.image} ${cfg.plates}p ${cfg.upscale}`, async ({ page }) => {
      test.setTimeout(600_000);
      const imgPath = path.join(IMG_DIR, cfg.image);
      const base = { test_id: tid, image: cfg.image, plates: cfg.plates, upscale: cfg.upscale };

      // Capture errors
      page.on("console", (msg) => {
        if (msg.type() === "error") console.log(`[ERR] ${msg.text().slice(0, 150)}`);
      });
      page.on("requestfailed", (req) => {
        if (req.url().includes("/api/")) console.log(`[NET FAIL] ${req.url()} — ${req.failure()?.errorText}`);
      });

      // Load
      let t0 = Date.now();
      await page.goto(SITE, { waitUntil: "networkidle" });
      log({ ...base, step: "load", success: true, duration_s: (Date.now() - t0) / 1000 });

      // Upload + configure
      await page.locator('input[type="file"]').setInputFiles(imgPath);
      await page.waitForTimeout(500);
      await page.locator('input[type="range"]').first().fill(String(cfg.plates));
      const upBtn = page.locator(".upscale-toggle button", { hasText: cfg.upscale });
      if (await upBtn.count() > 0) await upBtn.click();

      // Process
      t0 = Date.now();
      await page.locator("button.process-btn").first().click();
      try {
        await page.waitForFunction(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          const z = btns.find(b => b.textContent?.trim() === "ZIP");
          return z && !(z as HTMLButtonElement).disabled;
        }, { timeout: 540_000 });
        log({ ...base, step: "process", success: true, duration_s: (Date.now() - t0) / 1000 });
      } catch {
        log({ ...base, step: "process", success: false, duration_s: (Date.now() - t0) / 1000, error: "timeout" });
        await page.screenshot({ path: `/tmp/colorsep-screenshots/FAIL_${tid}.png`, fullPage: true });
        return;
      }

      // Download ZIP
      t0 = Date.now();
      const zipBtn = page.locator("button").filter({ hasText: /^ZIP$/ }).first();
      await zipBtn.click();
      console.log(`  → ZIP clicked, waiting for download...`);
      try {
        // Wait for either: download completes (button re-enables with "ZIP") or error
        await page.waitForFunction(() => {
          // Check for CSP/fetch errors in the error display
          const dismiss = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.includes("dismiss"));
          if (dismiss) return "error";
          // Check button state — during download it's disabled, after it's enabled with "ZIP"
          const btns = Array.from(document.querySelectorAll("button"));
          const z = btns.find(b => b.textContent?.trim() === "ZIP");
          // Button is enabled AND no download progress showing
          if (z && !(z as HTMLButtonElement).disabled) {
            const progressEl = document.querySelector(".download-progress");
            if (!progressEl) return "done";
          }
          return false;
        }, { timeout: 300_000 });

        // Check which result
        const dlResult = await page.evaluate(() => {
          const dismiss = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.includes("dismiss"));
          return dismiss ? "error" : "done";
        });

        if (dlResult === "done") {
          log({ ...base, step: "download", success: true, duration_s: (Date.now() - t0) / 1000 });
        } else {
          const errText = await page.evaluate(() => {
            const errEl = document.querySelector("[class*='error']");
            return errEl?.textContent ?? "download error";
          });
          log({ ...base, step: "download", success: false, duration_s: (Date.now() - t0) / 1000, error: errText });
        }
      } catch (e) {
        log({ ...base, step: "download", success: false, duration_s: (Date.now() - t0) / 1000, error: String(e).slice(0, 150) });
      }

      await page.screenshot({ path: `/tmp/colorsep-screenshots/final_${tid}.png`, fullPage: true });
    });
  }
});
