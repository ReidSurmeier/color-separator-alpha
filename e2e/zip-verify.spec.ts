import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const SITE = "https://color.reidsurmeier.wtf";
const IMG_DIR = "/tmp/colorsep-test-images";

const TESTS = [
  { image: "arena_03.jpg", plates: 2, upscale: "off" },
  { image: "ts_extra_03.jpg", plates: 4, upscale: "2x" },
];

test.describe.serial("ZIP Content Verification (browser download)", () => {
  for (let i = 0; i < TESTS.length; i++) {
    const cfg = TESTS[i];
    const tid = i + 1;

    test(`T${tid}: ${cfg.image} ${cfg.plates}p ${cfg.upscale}`, async ({ page }) => {
      test.setTimeout(600_000);
      const imgPath = path.join(IMG_DIR, cfg.image);

      page.on("console", (msg) => {
        if (msg.type() === "error") console.log(`[ERR] ${msg.text().slice(0, 150)}`);
      });

      // Load + upload + configure
      await page.goto(SITE, { waitUntil: "networkidle" });
      await page.locator('input[type="file"]').setInputFiles(imgPath);
      await page.waitForTimeout(500);
      await page.locator('input[type="range"]').first().fill(String(cfg.plates));
      const upBtn = page.locator(".upscale-toggle button", { hasText: cfg.upscale });
      if (await upBtn.count() > 0) await upBtn.click();

      // Process
      console.log(`T${tid}: Processing...`);
      await page.locator("button.process-btn").first().click();
      await page.waitForFunction(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const z = btns.find(b => b.textContent?.trim() === "ZIP");
        return z && !(z as HTMLButtonElement).disabled;
      }, { timeout: 540_000 });
      console.log(`T${tid}: Process complete`);

      // Hook URL.createObjectURL BEFORE clicking ZIP to capture the blob
      await page.evaluate(() => {
        (window as any).__capturedZipBlob = null;
        const orig = URL.createObjectURL;
        URL.createObjectURL = function (blob: Blob) {
          // Capture any blob > 5KB (ZIP will be much larger than favicon etc)
          if (blob.size > 5000) {
            (window as any).__capturedZipBlob = blob;
          }
          return orig.call(URL, blob);
        };
      });

      // Click ZIP
      console.log(`T${tid}: Clicking ZIP...`);
      await page.locator("button").filter({ hasText: /^ZIP$/ }).first().click();

      // Wait for download to complete (button re-enables with "ZIP")
      await page.waitForFunction(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const z = btns.find(b => b.textContent?.trim() === "ZIP");
        if (!z || (z as HTMLButtonElement).disabled) return false;
        const progress = document.querySelector(".download-progress");
        return !progress;
      }, { timeout: 300_000 });
      console.log(`T${tid}: Download complete in browser`);

      // Extract the captured blob as base64
      const zipBase64 = await page.evaluate(async () => {
        const blob = (window as any).__capturedZipBlob as Blob | null;
        if (!blob) return null;
        return new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(",")[1]);
          reader.readAsDataURL(blob);
        });
      });

      expect(zipBase64).not.toBeNull();
      console.log(`T${tid}: Captured blob — ${Math.round((zipBase64!.length * 3) / 4 / 1024)}KB`);

      // Write to disk and unzip
      const zipPath = `/tmp/colorsep-zips/browser_${tid}.zip`;
      const unzipDir = `/tmp/colorsep-zips/browser_${tid}_contents`;
      fs.writeFileSync(zipPath, Buffer.from(zipBase64!, "base64"));
      execSync(`rm -rf ${unzipDir} && mkdir -p ${unzipDir} && cd ${unzipDir} && unzip -o ${zipPath}`);

      // List and verify contents
      const allFiles = execSync(`find ${unzipDir} -type f`).toString().trim().split("\n");
      const pngs = allFiles.filter(f => f.endsWith(".png"));
      const svgs = allFiles.filter(f => f.endsWith(".svg"));
      const manifests = allFiles.filter(f => f.endsWith("manifest.json"));

      console.log(`T${tid}: ZIP contents (${allFiles.length} files):`);
      for (const f of allFiles) {
        const size = fs.statSync(f).size;
        console.log(`  ${path.relative(unzipDir, f)} — ${Math.round(size / 1024)}KB`);
      }

      // manifest.json must exist
      expect(manifests.length).toBe(1);
      const manifest = JSON.parse(fs.readFileSync(manifests[0], "utf-8"));
      const plateCount = manifest.plates?.length ?? cfg.plates;
      console.log(`T${tid}: Manifest: ${plateCount} plates, ${manifest.width}x${manifest.height}`);

      // Plate PNGs in png/ subdirectory
      const platePngs = pngs.filter(f => f.includes("/png/"));
      expect(platePngs.length).toBe(plateCount);

      // composite.png must exist
      expect(pngs.some(f => f.endsWith("composite.png"))).toBe(true);

      // N SVGs (one per plate)
      expect(svgs.length).toBe(plateCount);

      // No empty PNGs/SVGs
      for (const f of [...pngs, ...svgs]) {
        expect(fs.statSync(f).size).toBeGreaterThan(50);
      }

      console.log(`T${tid}: PASS — ${platePngs.length} plate PNGs, ${svgs.length} SVGs, ${pngs.length} total PNGs`);
    });
  }
});
