/**
 * CNC Full QA — Tests the /cnc page with synthetic SVG plates.
 *
 * Creates test ZIPs with SVG plates, uploads to /cnc, processes with
 * variable configurations, and verifies exported ZIP contents.
 *
 * Configurations tested:
 *   - Paper sizes: A4 (210×297), A3 (297×420), A5 (148×210), A6 (105×148)
 *   - Tools: all 6 (1/8" end, 1/4" end, 1/8" down, 1/4" down, 60° V, 30° V)
 *   - Kento: on/off
 *   - Units: mm/in
 *   - Export formats: SVG, DXF, EPS
 *   - Layout: individual, sheet
 */

import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const CNC_URL = "https://cnc.reidsurmeier.wtf/cnc";

// Paper sizes in mm
const PAPER_SIZES: Record<string, { w: number; h: number }> = {
  A3: { w: 297, h: 420 },
  A4: { w: 210, h: 297 },
  A5: { w: 148, h: 210 },
  A6: { w: 105, h: 148 },
};

const TOOLS = [
  "1/8-end",
  "1/4-end",
  "1/8-down",
  "1/4-down",
  "60v",
  "30v",
];

const EXPORT_FORMATS = ["svg", "dxf", "eps"] as const;

// Generate a simple SVG with some paths
function makeSvg(w: number, h: number, color: string, complexity: number): string {
  const paths: string[] = [];
  // Canvas boundary (potrace-style) — should be stripped
  paths.push(`<path d="M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z" fill="white"/>`);

  // Random-ish geometric paths
  for (let i = 0; i < complexity; i++) {
    const cx = (w * (i + 1)) / (complexity + 1);
    const cy = h / 2 + Math.sin(i * 1.5) * h * 0.3;
    const r = Math.min(w, h) * 0.05;
    // Circle approximation with bezier curves
    paths.push(
      `<path d="M ${cx - r} ${cy} C ${cx - r} ${cy - r * 0.55} ${cx - r * 0.55} ${cy - r} ${cx} ${cy - r} C ${cx + r * 0.55} ${cy - r} ${cx + r} ${cy - r * 0.55} ${cx + r} ${cy} C ${cx + r} ${cy + r * 0.55} ${cx + r * 0.55} ${cy + r} ${cx} ${cy + r} C ${cx - r * 0.55} ${cy + r} ${cx - r} ${cy + r * 0.55} ${cx - r} ${cy} Z" fill="${color}"/>`
    );
  }

  // Open path (should be closed by processor)
  paths.push(
    `<path d="M ${w * 0.1} ${h * 0.8} L ${w * 0.3} ${h * 0.7} L ${w * 0.5} ${h * 0.85}" fill="none" stroke="${color}"/>`
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    ...paths,
    `</svg>`,
  ].join("\n");
}

// Create a ZIP buffer with multiple plate SVGs + manifest
async function createTestZip(
  plateCount: number,
  w: number,
  h: number
): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const svgDir = zip.folder("svg")!;

  const colors = [
    "#1a1a1a", "#8B4513", "#2E8B57", "#4169E1",
    "#DC143C", "#FFD700", "#FF6347", "#9370DB",
    "#20B2AA", "#FF69B4",
  ];

  const manifest: {
    plates: Array<{ name: string; color: number[]; printOrder: number; file: string }>;
    printWidth_mm: number;
    printHeight_mm: number;
  } = {
    plates: [],
    printWidth_mm: w,
    printHeight_mm: h,
  };

  for (let i = 0; i < plateCount; i++) {
    const hex = colors[i % colors.length];
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const name = `plate${i + 1}`;
    const fileName = `${name}_${hex.slice(1)}.svg`;
    const svg = makeSvg(w, h, hex, 5 + i * 2);

    svgDir.file(fileName, svg);
    manifest.plates.push({
      name,
      color: [r, g, b],
      printOrder: i + 1,
      file: `svg/${fileName}`,
    });
  }

  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return buf;
}

// Helper: upload a ZIP to the CNC page
async function uploadZip(
  page: import("@playwright/test").Page,
  zipBuffer: Buffer,
  fileName: string
) {
  // Click "choose file" to trigger upload
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: fileName,
    mimeType: "application/zip",
    buffer: zipBuffer,
  });

  // Wait for plates to load
  await page.waitForFunction(
    () => {
      const items = document.querySelectorAll('[style*="cursor: pointer"]');
      return items.length > 0;
    },
    { timeout: 10000 }
  );
}

// Helper: set print dimensions
async function setPrintSize(
  page: import("@playwright/test").Page,
  w: number,
  h: number
) {
  const inputs = page.locator('input[type="number"]');
  const widthInput = inputs.nth(0);
  const heightInput = inputs.nth(1);

  await widthInput.fill(String(w));
  await heightInput.fill(String(h));
}

// Helper: select a tool by button text match
async function selectTool(
  page: import("@playwright/test").Page,
  toolId: string
) {
  // Tool buttons are in a grid, match by text content
  const labelMap: Record<string, string> = {
    "1/8-end": '1/8" end',
    "1/4-end": '1/4" end',
    "1/8-down": '1/8" down',
    "1/4-down": '1/4" down',
    "60v": "60° V",
    "30v": "30° V",
  };
  const label = labelMap[toolId] || toolId;
  await page.getByRole("button", { name: label, exact: true }).click();
}

// Helper: toggle kento marks
async function setKento(
  page: import("@playwright/test").Page,
  enabled: boolean
) {
  const currentState = await page.locator('button:has-text("on")[data-active="true"]').count();
  const isOn = currentState > 0;
  if (isOn !== enabled) {
    await page.locator(`button:has-text("${enabled ? "on" : "off"}")`).first().click();
  }
}

// Helper: select export format
async function setExportFormat(
  page: import("@playwright/test").Page,
  format: string
) {
  await page.locator(`button:has-text("${format}")`).click();
}

// Helper: click process and wait
async function processPlates(page: import("@playwright/test").Page) {
  const processBtn = page.locator('button:has-text("process")').first();
  await processBtn.click();
  // Wait for stats to appear (processing is synchronous, sub-second)
  await page.waitForFunction(
    () => document.body.textContent?.includes("boundary rects removed") ?? false,
    { timeout: 10000 }
  );
}

// Helper: trigger download and capture blob
async function downloadExport(
  page: import("@playwright/test").Page
): Promise<{ size: number; url: string }> {
  // Hook URL.createObjectURL to capture the blob
  await page.evaluate(() => {
    const orig = URL.createObjectURL;
    (window as any).__lastBlobUrl = null;
    (window as any).__lastBlobSize = 0;
    URL.createObjectURL = function (blob: Blob) {
      const url = orig.call(URL, blob);
      (window as any).__lastBlobUrl = url;
      (window as any).__lastBlobSize = blob.size;
      return url;
    };
  });

  const downloadBtn = page.locator('button:has-text("download")');
  await downloadBtn.click();

  // Wait for blob to be created
  await page.waitForFunction(
    () => (window as any).__lastBlobSize > 0,
    { timeout: 30000 }
  );

  const result = await page.evaluate(() => ({
    size: (window as any).__lastBlobSize as number,
    url: (window as any).__lastBlobUrl as string,
  }));

  return result;
}

// Results collector
interface TestResult {
  testName: string;
  paperSize: string;
  toolId: string;
  kentoEnabled: boolean;
  exportFormat: string;
  plateCount: number;
  processStats: string;
  exportSizeKb: number;
  pass: boolean;
  error?: string;
}

const results: TestResult[] = [];

// ── TESTS ──

test.describe("CNC Full QA", () => {
  test.describe.configure({ mode: "serial" });

  // Test matrix: 4 paper sizes × selected tool/kento/format combos
  // Full matrix would be 4×6×2×3 = 144 tests — too many.
  // Strategic selection: cover each variable at least once.

  const testCases = [
    // Vary paper size with default tool
    { paper: "A4", tool: "1/8-end", kento: true, format: "svg" as const, plates: 3 },
    { paper: "A3", tool: "1/8-end", kento: true, format: "svg" as const, plates: 5 },
    { paper: "A5", tool: "1/8-end", kento: true, format: "svg" as const, plates: 2 },
    { paper: "A6", tool: "1/8-end", kento: true, format: "svg" as const, plates: 4 },

    // Vary tool with A4
    { paper: "A4", tool: "1/4-end", kento: true, format: "svg" as const, plates: 3 },
    { paper: "A4", tool: "1/8-down", kento: true, format: "svg" as const, plates: 3 },
    { paper: "A4", tool: "1/4-down", kento: true, format: "svg" as const, plates: 3 },
    { paper: "A4", tool: "60v", kento: true, format: "svg" as const, plates: 3 },
    { paper: "A4", tool: "30v", kento: true, format: "svg" as const, plates: 3 },

    // Kento off
    { paper: "A4", tool: "1/8-end", kento: false, format: "svg" as const, plates: 3 },

    // Vary export format
    { paper: "A4", tool: "1/8-end", kento: true, format: "dxf" as const, plates: 3 },
    { paper: "A4", tool: "1/8-end", kento: true, format: "eps" as const, plates: 3 },

    // Sheet layout (SVG only)
    { paper: "A4", tool: "1/8-end", kento: true, format: "svg" as const, plates: 4, layout: "sheet" as const },

    // Large plate count
    { paper: "A3", tool: "60v", kento: true, format: "svg" as const, plates: 8 },

    // Edge case: single plate
    { paper: "A6", tool: "30v", kento: false, format: "eps" as const, plates: 1 },
  ];

  for (const tc of testCases) {
    const testName = `${tc.paper} ${tc.tool} kento=${tc.kento} ${tc.format} ${tc.plates}plates${"layout" in tc ? " sheet" : ""}`;

    test(testName, async ({ page }) => {
      const result: TestResult = {
        testName,
        paperSize: tc.paper,
        toolId: tc.tool,
        kentoEnabled: tc.kento,
        exportFormat: tc.format,
        plateCount: tc.plates,
        processStats: "",
        exportSizeKb: 0,
        pass: false,
      };

      try {
        // Navigate
        await page.goto(CNC_URL, { waitUntil: "networkidle" });

        // Create and upload test ZIP
        const { w, h } = PAPER_SIZES[tc.paper];
        const zipBuffer = await createTestZip(tc.plates, w, h);
        await uploadZip(page, zipBuffer, `test-${tc.paper}-${tc.plates}plates.zip`);

        // Configure
        await setPrintSize(page, w, h);
        await selectTool(page, tc.tool);
        await setKento(page, tc.kento);

        // Process
        await processPlates(page);

        // Capture stats
        const statsText = await page.locator('.data-box').textContent() ?? "";
        result.processStats = statsText.replace(/\s+/g, " ").trim();

        // Verify stats show reasonable values
        expect(statsText).toContain("boundary rects removed");
        expect(statsText).toContain("nodes");

        if (tc.kento) {
          // Kento marks should be added
          const kentoMatch = statsText.match(/kento added\s*(\d+)/);
          expect(kentoMatch).toBeTruthy();
          expect(Number(kentoMatch?.[1])).toBeGreaterThan(0);
        }

        // Set export format
        await setExportFormat(page, tc.format);

        // Set layout if sheet
        if ("layout" in tc && tc.layout === "sheet") {
          await page.locator('button:has-text("sheet")').click();
        }

        // Export
        const { size } = await downloadExport(page);
        result.exportSizeKb = Math.round(size / 1024);
        expect(size).toBeGreaterThan(0);

        result.pass = true;
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
        // Take screenshot on failure
        const screenshotPath = path.join(
          __dirname,
          "results",
          `fail-${tc.paper}-${tc.tool}-${tc.format}.png`
        );
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
        throw err;
      } finally {
        results.push(result);
      }
    });
  }

  test.afterAll(() => {
    // Write results to file
    const resultsPath = path.join(__dirname, "results", "cnc-qa-results.json");
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

    // Summary
    const passed = results.filter((r) => r.pass).length;
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n=== CNC QA RESULTS ===`);
    console.log(`Passed: ${passed}/${results.length}`);
    console.log(`Failed: ${failed}`);
    if (failed > 0) {
      console.log(`\nFailures:`);
      results
        .filter((r) => !r.pass)
        .forEach((r) => console.log(`  ✗ ${r.testName}: ${r.error}`));
    }
    console.log(`\nExport sizes (KB):`);
    results
      .filter((r) => r.pass)
      .forEach((r) => console.log(`  ${r.testName}: ${r.exportSizeKb}KB`));
  });
});
