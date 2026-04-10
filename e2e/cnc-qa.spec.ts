import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const SITE = "https://color.reidsurmeier.wtf";
const IMG_DIR = "/tmp/colorsep-test-images";
const RESULTS = "/tmp/cnc-qa-results.jsonl";

// 5 images: process on main page, prepare for CNC, upload ZIP on /cnc, process, download, verify
const IMAGES = [
  { image: "arena_03.jpg", plates: 2, upscale: "off" },
  { image: "ts_pixel_rug_2023.png", plates: 3, upscale: "off" },
  { image: "arena_06.jpg", plates: 4, upscale: "off" },
  { image: "ts_extra_03.jpg", plates: 3, upscale: "off" },
  { image: "arena_08.jpg", plates: 2, upscale: "off" },
];

function log(r: Record<string, unknown>) {
  fs.appendFileSync(RESULTS, JSON.stringify(r) + "\n");
  const ok = r.success ? "OK" : "FAIL";
  const err = r.error ? ` (${String(r.error).slice(0, 100)})` : "";
  console.log(`  [${ok}] ${r.step} — ${Number(r.duration_s).toFixed(1)}s${err}`);
}

test.describe.serial("CNC QA: 5 images end-to-end", () => {
  test.beforeAll(() => { if (fs.existsSync(RESULTS)) fs.unlinkSync(RESULTS); });

  for (let i = 0; i < IMAGES.length; i++) {
    const cfg = IMAGES[i];
    const tid = i + 1;

    test(`T${tid}: ${cfg.image} — full flow`, async ({ page }) => {
      test.setTimeout(600_000);
      const imgPath = path.join(IMG_DIR, cfg.image);
      const base = { test_id: tid, image: cfg.image };

      page.on("console", (msg) => {
        if (msg.type() === "error") console.log(`[ERR] ${msg.text().slice(0, 120)}`);
      });

      // === STEP 1: Process on main page ===
      console.log(`\nT${tid}: Processing ${cfg.image} on main page...`);
      let t0 = Date.now();
      await page.goto(SITE, { waitUntil: "networkidle" });
      await page.locator('input[type="file"]').setInputFiles(imgPath);
      await page.waitForTimeout(500);
      await page.locator('input[type="range"]').first().fill(String(cfg.plates));
      const upBtn = page.locator(".upscale-toggle button", { hasText: cfg.upscale });
      if (await upBtn.count() > 0) await upBtn.click();
      await page.locator("button.process-btn").first().click();

      // Wait for processing to complete
      await page.waitForFunction(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const z = btns.find(b => b.textContent?.trim() === "ZIP");
        return z && !(z as HTMLButtonElement).disabled;
      }, { timeout: 300_000 });
      log({ ...base, step: "main_process", success: true, duration_s: (Date.now() - t0) / 1000 });

      // === STEP 2: Download ZIP from main page ===
      t0 = Date.now();
      // Hook blob capture
      await page.evaluate(() => {
        (window as any).__capturedZip = null;
        const orig = URL.createObjectURL;
        URL.createObjectURL = function(blob: Blob) {
          if (blob.size > 5000) (window as any).__capturedZip = blob;
          return orig.call(URL, blob);
        };
      });
      await page.locator("button").filter({ hasText: /^ZIP$/ }).first().click();
      await page.waitForFunction(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const z = btns.find(b => b.textContent?.trim() === "ZIP");
        if (!z || (z as HTMLButtonElement).disabled) return false;
        const progress = document.querySelector(".download-progress");
        return !progress;
      }, { timeout: 300_000 });

      const zipB64 = await page.evaluate(async () => {
        const blob = (window as any).__capturedZip as Blob | null;
        if (!blob) return null;
        return new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(",")[1]);
          reader.readAsDataURL(blob);
        });
      });

      const mainZipPath = `/tmp/cnc-qa/main_${tid}.zip`;
      fs.mkdirSync("/tmp/cnc-qa", { recursive: true });
      if (zipB64) {
        fs.writeFileSync(mainZipPath, Buffer.from(zipB64, "base64"));
        log({ ...base, step: "main_download", success: true, duration_s: (Date.now() - t0) / 1000, zip_kb: Math.round(fs.statSync(mainZipPath).size / 1024) });
      } else {
        log({ ...base, step: "main_download", success: false, duration_s: (Date.now() - t0) / 1000, error: "No blob captured" });
        return;
      }

      // === STEP 3: Go to /cnc page and upload the ZIP ===
      t0 = Date.now();
      await page.goto(`${SITE}/cnc`, { waitUntil: "networkidle" });
      await page.locator('input[type="file"]').setInputFiles(mainZipPath);
      await page.waitForTimeout(1000);

      // Check if plates loaded — look for plate text in sidebar
      const plateCount = await page.evaluate(() => {
        const body = document.body.innerText;
        const matches = body.match(/plate\d+/g);
        return matches ? matches.length : 0;
      });
      log({ ...base, step: "cnc_upload", success: plateCount > 0, duration_s: (Date.now() - t0) / 1000, plates_loaded: plateCount });

      if (plateCount === 0) {
        console.log(`T${tid}: No plates loaded on CNC page — skipping remaining steps`);
        return;
      }

      // === STEP 4: Set print size and process ===
      t0 = Date.now();
      await page.locator("button.process-btn").first().click();
      await page.waitForTimeout(3000); // Client-side processing should be fast
      log({ ...base, step: "cnc_process", success: true, duration_s: (Date.now() - t0) / 1000 });

      // === STEP 5: Download CNC SVGs ===
      t0 = Date.now();
      // Hook blob capture for CNC download
      await page.evaluate(() => {
        (window as any).__capturedCncZip = null;
        const orig = URL.createObjectURL;
        URL.createObjectURL = function(blob: Blob) {
          if (blob.size > 1000) (window as any).__capturedCncZip = blob;
          return orig.call(URL, blob);
        };
      });

      const dlBtn = page.locator("button").filter({ hasText: /^download$/ }).first();
      if (await dlBtn.count() > 0 && !(await dlBtn.isDisabled())) {
        await dlBtn.click();
        await page.waitForTimeout(3000);

        const cncZipB64 = await page.evaluate(async () => {
          const blob = (window as any).__capturedCncZip as Blob | null;
          if (!blob) return null;
          return new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string).split(",")[1]);
            reader.readAsDataURL(blob);
          });
        });

        if (cncZipB64) {
          const cncZipPath = `/tmp/cnc-qa/cnc_${tid}.zip`;
          fs.writeFileSync(cncZipPath, Buffer.from(cncZipB64, "base64"));
          const cncDir = `/tmp/cnc-qa/cnc_${tid}_contents`;
          execSync(`rm -rf ${cncDir} && mkdir -p ${cncDir} && cd ${cncDir} && unzip -o ${cncZipPath}`);

          const files = execSync(`find ${cncDir} -type f`).toString().trim().split("\n").filter(Boolean);
          const svgs = files.filter(f => f.endsWith(".svg"));
          const dxfs = files.filter(f => f.endsWith(".dxf"));
          const epss = files.filter(f => f.endsWith(".eps"));
          const manifests = files.filter(f => f.endsWith("manifest.json"));

          console.log(`T${tid}: CNC ZIP contents (${files.length} files):`);
          for (const f of files) {
            const sz = fs.statSync(f).size;
            console.log(`  ${path.relative(cncDir, f)} — ${Math.round(sz / 1024)}KB`);
          }

          // Check SVGs have mm dimensions
          let hasMmDims = false;
          for (const svg of svgs) {
            const content = fs.readFileSync(svg, "utf-8");
            if (content.includes("mm")) hasMmDims = true;
          }

          log({
            ...base,
            step: "cnc_download",
            success: true,
            duration_s: (Date.now() - t0) / 1000,
            total_files: files.length,
            svgs: svgs.length,
            dxfs: dxfs.length,
            epss: epss.length,
            has_manifest: manifests.length > 0,
            has_mm_dims: hasMmDims,
          });
        } else {
          log({ ...base, step: "cnc_download", success: false, duration_s: (Date.now() - t0) / 1000, error: "No CNC blob captured" });
        }
      } else {
        log({ ...base, step: "cnc_download", success: false, duration_s: (Date.now() - t0) / 1000, error: "Download button not found or disabled" });
      }

      await page.screenshot({ path: `/tmp/cnc-qa/screenshot_${tid}.png`, fullPage: true });
    });
  }
});
