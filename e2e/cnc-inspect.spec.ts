/**
 * CNC Output Inspector — Downloads exports and inspects actual content.
 * Checks what the processing actually changes vs input.
 */

import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const CNC_URL = "https://cnc.reidsurmeier.wtf/cnc";

function makeSvg(w: number, h: number, color: string): string {
  const paths: string[] = [];
  // Canvas boundary rect (potrace style — should be stripped)
  paths.push(`<path d="M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z" fill="white"/>`);
  // Actual content paths
  for (let i = 0; i < 5; i++) {
    const cx = (w * (i + 1)) / 6;
    const cy = h / 2;
    const r = w * 0.05;
    paths.push(
      `<path d="M ${cx - r} ${cy} C ${cx - r} ${cy - r * 0.55} ${cx - r * 0.55} ${cy - r} ${cx} ${cy - r} C ${cx + r * 0.55} ${cy - r} ${cx + r} ${cy - r * 0.55} ${cx + r} ${cy} C ${cx + r} ${cy + r * 0.55} ${cx + r * 0.55} ${cy + r} ${cx} ${cy + r} C ${cx - r * 0.55} ${cy + r} ${cx - r} ${cy + r * 0.55} ${cx - r} ${cy} Z" fill="${color}"/>`
    );
  }
  // Open path (should be closed)
  paths.push(`<path d="M ${w * 0.1} ${h * 0.8} L ${w * 0.3} ${h * 0.7} L ${w * 0.5} ${h * 0.85}" fill="none" stroke="${color}"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${paths.join("\n")}\n</svg>`;
}

async function createTestZip(plates: number, w: number, h: number): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const svgDir = zip.folder("svg")!;
  const colors = ["#1a1a1a", "#8B4513", "#2E8B57", "#4169E1"];
  const manifest: any = { plates: [], printWidth_mm: w, printHeight_mm: h };

  for (let i = 0; i < plates; i++) {
    const hex = colors[i % colors.length];
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const name = `plate${i + 1}`;
    const fileName = `${name}_${hex.slice(1)}.svg`;
    svgDir.file(fileName, makeSvg(w, h, hex));
    manifest.plates.push({ name, color: [r, g, b], printOrder: i + 1, file: `svg/${fileName}` });
  }
  zip.file("manifest.json", JSON.stringify(manifest));
  return zip.generateAsync({ type: "nodebuffer" });
}

async function uploadAndProcess(page: any, zipBuffer: Buffer, fileName: string) {
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({ name: fileName, mimeType: "application/zip", buffer: zipBuffer });
  await page.waitForFunction(() => {
    const items = document.querySelectorAll('[style*="cursor: pointer"]');
    return items.length > 0;
  }, { timeout: 10000 });
}

async function clickProcess(page: any) {
  await page.locator('button.process-btn, button:has-text("process")').first().click();
  await page.waitForFunction(
    () => document.body.textContent?.includes("boundary rects removed") ?? false,
    { timeout: 10000 }
  );
}

async function downloadAndExtractZip(page: any): Promise<Record<string, string>> {
  // Intercept blob
  await page.evaluate(() => {
    const orig = URL.createObjectURL;
    (window as any).__capturedBlob = null;
    URL.createObjectURL = function (blob: Blob) {
      (window as any).__capturedBlob = blob;
      return orig.call(URL, blob);
    };
  });

  await page.locator('button:has-text("download")').click();
  await page.waitForFunction(() => (window as any).__capturedBlob !== null, { timeout: 30000 });

  // Read blob as base64
  const b64 = await page.evaluate(async () => {
    const blob = (window as any).__capturedBlob as Blob;
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  });

  // Parse ZIP
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(Buffer.from(b64, "base64"));
  const files: Record<string, string> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) {
      files[name] = await entry.async("text");
    }
  }
  return files;
}

test.describe("CNC Output Inspector", () => {
  test.describe.configure({ mode: "serial" });

  test("inspect what processing actually changes", async ({ page }) => {
    await page.goto(CNC_URL, { waitUntil: "networkidle" });

    const zipBuffer = await createTestZip(3, 210, 297);
    await uploadAndProcess(page, zipBuffer, "test-inspect.zip");

    // Get stats BEFORE processing
    const rawInput = makeSvg(210, 297, "#1a1a1a");
    const inputPathCount = (rawInput.match(/<path/g) || []).length;
    const inputHasZ = /Z\s*"/.test(rawInput);
    const inputHasMmDims = /width="210mm"/.test(rawInput);

    console.log("\n=== INPUT SVG ANALYSIS ===");
    console.log(`  Path elements: ${inputPathCount}`);
    console.log(`  Has mm dimensions: ${inputHasMmDims}`);
    console.log(`  Width attr: ${rawInput.match(/width="([^"]+)"/)?.[1]}`);
    console.log(`  Open paths (no Z): ${(rawInput.match(/<path[^>]*d="[^"]*"[^>]*\/>/g) || []).filter(p => !p.includes(" Z")).length}`);

    // Process
    await clickProcess(page);

    // Get stats
    const statsText = await page.locator('.data-box').textContent() ?? "";
    console.log("\n=== PROCESSING STATS ===");
    console.log(`  ${statsText.replace(/\s+/g, " ").trim()}`);

    // Export SVG
    const svgFiles = await downloadAndExtractZip(page);
    const fileNames = Object.keys(svgFiles);
    console.log("\n=== EXPORTED ZIP CONTENTS ===");
    console.log(`  Files: ${fileNames.join(", ")}`);

    // Inspect first plate SVG
    const plateSvg = Object.entries(svgFiles).find(([k]) => k.endsWith(".svg") && k !== "manifest.json");
    if (plateSvg) {
      const [name, content] = plateSvg;
      console.log(`\n=== PLATE SVG: ${name} (${content.length} bytes) ===`);

      // Check mm dimensions
      const widthMatch = content.match(/width="([^"]+)"/);
      const heightMatch = content.match(/height="([^"]+)"/);
      console.log(`  width attr: ${widthMatch?.[1]}`);
      console.log(`  height attr: ${heightMatch?.[1]}`);
      const hasMm = widthMatch?.[1]?.includes("mm") ?? false;
      console.log(`  Has mm units: ${hasMm}`);

      // Check viewBox
      const vb = content.match(/viewBox="([^"]+)"/);
      console.log(`  viewBox: ${vb?.[1]}`);

      // Check registration marks
      const hasKagi = content.includes("kento-kagi") || content.includes("kagi");
      const hasCrosshair = content.includes("reg-cross") || content.includes("crosshair");
      const hasPinRound = content.includes("pin-round");
      const hasPinDiamond = content.includes("pin-diamond");
      const hasColorStrip = content.includes("color-strip") || /<rect[^>]*fill="#/i.test(content);
      console.log(`  Kagi kento: ${hasKagi}`);
      console.log(`  Crosshairs: ${hasCrosshair}`);
      console.log(`  Pin round: ${hasPinRound}`);
      console.log(`  Pin diamond: ${hasPinDiamond}`);
      console.log(`  Color strip: ${hasColorStrip}`);

      // Count paths
      const outputPaths = (content.match(/<path/g) || []).length;
      const outputCircles = (content.match(/<circle/g) || []).length;
      const outputRects = (content.match(/<rect/g) || []).length;
      console.log(`  <path> elements: ${outputPaths}`);
      console.log(`  <circle> elements: ${outputCircles}`);
      console.log(`  <rect> elements: ${outputRects}`);

      // Check for canvas boundary rect (should be stripped)
      const hasCanvasBoundary = /d="M 0 0 L 210 0 L 210 297 L 0 297 Z"/.test(content);
      console.log(`  Canvas boundary rect present: ${hasCanvasBoundary}`);

      // Check open paths closed
      const allPaths = content.match(/d="([^"]+)"/g) || [];
      const openPaths = allPaths.filter(p => !p.includes("Z") && !p.includes("z"));
      console.log(`  Open paths remaining: ${openPaths.length}`);

      // Print first 500 chars of SVG for manual inspection
      console.log(`\n=== SVG CONTENT (first 800 chars) ===`);
      console.log(content.slice(0, 800));

      // Assertions
      expect(hasMm).toBe(true);
      expect(hasCanvasBoundary).toBe(false); // Boundary should be stripped
    }

    // Inspect manifest
    const manifest = svgFiles["manifest.json"];
    if (manifest) {
      const parsed = JSON.parse(manifest);
      console.log(`\n=== MANIFEST ===`);
      console.log(`  Format: ${parsed.format}`);
      console.log(`  Layout: ${parsed.layout}`);
      console.log(`  Print size: ${parsed.printSize?.width_mm}×${parsed.printSize?.height_mm}mm`);
      console.log(`  Plates: ${parsed.plates?.length}`);
      console.log(`  Generated: ${parsed.generatedAt}`);
    }
  });

  test("tool change comparison — verify same output", async ({ page }) => {
    // Test with 1/8" end mill
    await page.goto(CNC_URL, { waitUntil: "networkidle" });
    const zipBuffer = await createTestZip(2, 210, 297);
    await uploadAndProcess(page, zipBuffer, "tool-test.zip");
    await page.getByRole("button", { name: '1/8" end', exact: true }).click();
    await clickProcess(page);
    const files1 = await downloadAndExtractZip(page);
    const plate1_tool1 = Object.entries(files1).find(([k]) => k.endsWith(".svg") && !k.includes("manifest"))?.[1] ?? "";

    // Reset and test with 1/4" end mill
    await page.locator('button:has-text("reset")').click();
    await uploadAndProcess(page, zipBuffer, "tool-test.zip");
    await page.getByRole("button", { name: '1/4" end', exact: true }).click();
    await clickProcess(page);
    const files2 = await downloadAndExtractZip(page);
    const plate1_tool2 = Object.entries(files2).find(([k]) => k.endsWith(".svg") && !k.includes("manifest"))?.[1] ?? "";

    // Reset and test with 60° V-bit
    await page.locator('button:has-text("reset")').click();
    await uploadAndProcess(page, zipBuffer, "tool-test.zip");
    await page.getByRole("button", { name: '60° V', exact: true }).click();
    await clickProcess(page);
    const files3 = await downloadAndExtractZip(page);
    const plate1_tool3 = Object.entries(files3).find(([k]) => k.endsWith(".svg") && !k.includes("manifest"))?.[1] ?? "";

    console.log("\n=== TOOL COMPARISON ===");
    console.log(`  1/8" end SVG size: ${plate1_tool1.length} bytes`);
    console.log(`  1/4" end SVG size: ${plate1_tool2.length} bytes`);
    console.log(`  60° V SVG size: ${plate1_tool3.length} bytes`);
    console.log(`  1/8 vs 1/4 identical: ${plate1_tool1 === plate1_tool2}`);
    console.log(`  1/8 vs 60V identical: ${plate1_tool1 === plate1_tool3}`);

    // Extract path count differences
    const paths1 = (plate1_tool1.match(/<path/g) || []).length;
    const paths2 = (plate1_tool2.match(/<path/g) || []).length;
    const paths3 = (plate1_tool3.match(/<path/g) || []).length;
    console.log(`  1/8" end paths: ${paths1}`);
    console.log(`  1/4" end paths: ${paths2}`);
    console.log(`  60° V paths: ${paths3}`);

    // This DOCUMENTS the current behavior — tool selection doesn't change output
    if (plate1_tool1 === plate1_tool2) {
      console.log("\n  ⚠ CONFIRMED: Tool selection does NOT affect SVG output");
      console.log("  Tool diameter is metadata only — no path compensation applied");
    }
  });

  test("kento on vs off — verify marks present/absent", async ({ page }) => {
    await page.goto(CNC_URL, { waitUntil: "networkidle" });
    const zipBuffer = await createTestZip(2, 210, 297);

    // Kento ON
    await uploadAndProcess(page, zipBuffer, "kento-test.zip");
    await clickProcess(page);
    const filesOn = await downloadAndExtractZip(page);
    const plateOn = Object.entries(filesOn).find(([k]) => k.endsWith(".svg") && !k.includes("manifest"))?.[1] ?? "";

    // Reset, kento OFF
    await page.locator('button:has-text("reset")').click();
    await uploadAndProcess(page, zipBuffer, "kento-test.zip");
    // Toggle kento off
    const offBtn = page.locator('button:has-text("off")').first();
    await offBtn.click();
    await clickProcess(page);
    const filesOff = await downloadAndExtractZip(page);
    const plateOff = Object.entries(filesOff).find(([k]) => k.endsWith(".svg") && !k.includes("manifest"))?.[1] ?? "";

    console.log("\n=== KENTO ON vs OFF ===");
    console.log(`  Kento ON size: ${plateOn.length} bytes`);
    console.log(`  Kento OFF size: ${plateOff.length} bytes`);
    console.log(`  Size difference: ${plateOn.length - plateOff.length} bytes`);
    console.log(`  ON has kagi path: ${plateOn.includes("kento-kagi")}`);
    console.log(`  OFF has kagi path: ${plateOff.includes("kento-kagi")}`);
    console.log(`  ON has crosshairs: ${plateOn.includes("reg-cross")}`);
    console.log(`  OFF has crosshairs: ${plateOff.includes("reg-cross")}`);
    console.log(`  ON has pin markers: ${plateOn.includes("pin-round")}`);
    console.log(`  OFF has pin markers: ${plateOff.includes("pin-round")}`);

    // Kento ON should be bigger
    expect(plateOn.length).toBeGreaterThan(plateOff.length);
  });

  test("EPS export — verify PostScript structure", async ({ page }) => {
    await page.goto(CNC_URL, { waitUntil: "networkidle" });
    const zipBuffer = await createTestZip(2, 210, 297);
    await uploadAndProcess(page, zipBuffer, "eps-test.zip");
    await clickProcess(page);
    await page.getByRole("button", { name: "eps", exact: true }).click();
    const files = await downloadAndExtractZip(page);
    const epsFile = Object.entries(files).find(([k]) => k.endsWith(".eps"));

    if (epsFile) {
      const [name, content] = epsFile;
      console.log(`\n=== EPS: ${name} (${content.length} bytes) ===`);
      console.log(`  Has PS header: ${content.startsWith("%!PS-Adobe")}`);
      console.log(`  Has BoundingBox: ${content.includes("%%BoundingBox")}`);
      console.log(`  Has moveto: ${content.includes("moveto")}`);
      console.log(`  Has curveto: ${content.includes("curveto")}`);
      console.log(`  Has closepath: ${content.includes("closepath")}`);
      console.log(`  Has color strip: ${content.includes("Color test strip")}`);
      console.log(`  Has EOF: ${content.includes("%%EOF")}`);
      console.log(`\n  First 400 chars:\n${content.slice(0, 400)}`);

      expect(content).toContain("%!PS-Adobe");
      expect(content).toContain("%%BoundingBox");
      expect(content).toContain("moveto");
      expect(content).toContain("%%EOF");
    }
  });

  test("DXF export — verify structure", async ({ page }) => {
    await page.goto(CNC_URL, { waitUntil: "networkidle" });
    const zipBuffer = await createTestZip(2, 210, 297);
    await uploadAndProcess(page, zipBuffer, "dxf-test.zip");
    await clickProcess(page);
    await page.getByRole("button", { name: "dxf", exact: true }).click();
    const files = await downloadAndExtractZip(page);
    const dxfFile = Object.entries(files).find(([k]) => k.endsWith(".dxf"));

    if (dxfFile) {
      const [name, content] = dxfFile;
      console.log(`\n=== DXF: ${name} (${content.length} bytes) ===`);
      console.log(`  Has HEADER section: ${content.includes("HEADER")}`);
      console.log(`  Has ENTITIES section: ${content.includes("ENTITIES")}`);
      console.log(`  Has LINE entities: ${content.includes("LINE")}`);
      console.log(`  Has EOF: ${content.includes("EOF")}`);
      console.log(`  Has kento (LINE segments): ${content.includes("kento") || content.includes("LINE")}`);
      console.log(`\n  First 400 chars:\n${content.slice(0, 400)}`);

      expect(content).toContain("ENTITIES");
      expect(content).toContain("EOF");
    }
  });
});
