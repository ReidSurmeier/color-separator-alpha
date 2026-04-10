import type { CncPlate, PrintSize, KentoConfig } from "./cnc-types";
import { generateKentoMarks } from "./cnc-engine";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MM_TO_PT = 2.83465;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function colorToHex([r, g, b]: [number, number, number]): string {
  return (
    "#" +
    [r, g, b]
      .map((c) => c.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

/** Sanitise a string for use as a filename segment. */
function safeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-]/g, "_");
}

/** Escape a string for safe embedding in PostScript string literals (paren-delimited). */
function safePsString(s: string): string {
  return s.replace(/[\\()]/g, "\\$&");
}

/** Escape a string for safe embedding in SVG/XML text content. */
function safeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Extract path `d` attribute strings from raw SVG markup.
 * Uses the same regex approach as cnc-engine.ts parseSvg.
 */
function extractPaths(svgString: string): string[] {
  const paths: string[] = [];
  const re = /<path[^>]+\bd="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svgString)) !== null) {
    paths.push(m[1]);
  }
  return paths;
}

/**
 * Get the source SVG for a plate — prefer svgCleaned, fall back to svgRaw.
 */
function plateSource(plate: CncPlate): string {
  return plate.svgCleaned ?? plate.svgRaw;
}

// ---------------------------------------------------------------------------
// exportCleanedSvg
// ---------------------------------------------------------------------------

/**
 * Export a single plate as cleaned SVG with mm dimensions + kento marks.
 */
export function exportCleanedSvg(
  plate: CncPlate,
  printSize: PrintSize,
  kentoConfig: KentoConfig,
): string {
  const { width_mm, height_mm } = printSize;
  const paths = extractPaths(plateSource(plate));
  const hex = colorToHex(plate.color);

  const pathEls = paths
    .map(
      (d) =>
        `  <path d="${d}" fill="${hex}" stroke="none"/>`,
    )
    .join("\n");

  const kento = kentoConfig.enabled
    ? generateKentoMarks(width_mm, height_mm, kentoConfig)
    : "";

  // Color test strip: 10×3mm swatch at bottom margin + plate label
  const stripX = width_mm / 2 - 5;
  const stripY = height_mm - 3;
  const colorStrip = [
    `  <rect x="${stripX}" y="${stripY}" width="10" height="3" fill="${hex}" stroke="black" stroke-width="0.15"/>`,
    `  <text x="${stripX + 5}" y="${stripY - 0.5}" font-family="monospace" font-size="1.5" text-anchor="middle" fill="black">${safeXml(plate.name)} ${hex}</text>`,
  ].join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     width="${width_mm}mm" height="${height_mm}mm"`,
    `     viewBox="0 0 ${width_mm} ${height_mm}">`,
    `  <title>${safeXml(plate.name)}</title>`,
    pathEls,
    kento ? `  ${kento}` : "",
    colorStrip,
    `</svg>`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// ---------------------------------------------------------------------------
// EPS helpers
// ---------------------------------------------------------------------------

/** Convert a single SVG path `d` string to PostScript commands.
 *  PostScript Y-axis is bottom-up; SVG is top-down.
 *  We flip: ps_y = heightPt - svg_y * scale
 */
function svgPathToPostScript(
  d: string,
  scaleX: number,
  scaleY: number,
  heightPt: number,
): string {
  const lines: string[] = [];

  // Tokenise: capture command letters and numbers separately
  const tokenRe =
    /([MmLlHhVvCcSsQqTtAaZz])|(-?[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)/g;

  const nums: number[] = [];
  let cmd = "";
  // Track current pen position for relative commands
  let cx = 0;
  let cy = 0;
  // Track start of current sub-path for Z
  let startX = 0;
  let startY = 0;

  const toPs = (svgX: number, svgY: number): [number, number] => [
    svgX * scaleX,
    heightPt - svgY * scaleY,
  ];

  const flush = () => {
    if (!cmd) return;
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;

    switch (upper) {
      case "M": {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const ax = rel ? cx + nums[i] : nums[i];
          const ay = rel ? cy + nums[i + 1] : nums[i + 1];
          const [px, py] = toPs(ax, ay);
          if (i === 0) {
            lines.push(`${px.toFixed(4)} ${py.toFixed(4)} moveto`);
            startX = ax;
            startY = ay;
          } else {
            // Implicit lineto after first move
            lines.push(`${px.toFixed(4)} ${py.toFixed(4)} lineto`);
          }
          cx = ax;
          cy = ay;
        }
        break;
      }
      case "L": {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const ax = rel ? cx + nums[i] : nums[i];
          const ay = rel ? cy + nums[i + 1] : nums[i + 1];
          const [px, py] = toPs(ax, ay);
          lines.push(`${px.toFixed(4)} ${py.toFixed(4)} lineto`);
          cx = ax;
          cy = ay;
        }
        break;
      }
      case "H": {
        for (let i = 0; i < nums.length; i++) {
          const ax = rel ? cx + nums[i] : nums[i];
          const [px, py] = toPs(ax, cy);
          lines.push(`${px.toFixed(4)} ${py.toFixed(4)} lineto`);
          cx = ax;
        }
        break;
      }
      case "V": {
        for (let i = 0; i < nums.length; i++) {
          const ay = rel ? cy + nums[i] : nums[i];
          const [px, py] = toPs(cx, ay);
          lines.push(`${px.toFixed(4)} ${py.toFixed(4)} lineto`);
          cy = ay;
        }
        break;
      }
      case "C": {
        for (let i = 0; i + 5 < nums.length; i += 6) {
          const x1 = rel ? cx + nums[i] : nums[i];
          const y1 = rel ? cy + nums[i + 1] : nums[i + 1];
          const x2 = rel ? cx + nums[i + 2] : nums[i + 2];
          const y2 = rel ? cy + nums[i + 3] : nums[i + 3];
          const x = rel ? cx + nums[i + 4] : nums[i + 4];
          const y = rel ? cy + nums[i + 5] : nums[i + 5];
          const [px1, py1] = toPs(x1, y1);
          const [px2, py2] = toPs(x2, y2);
          const [px, py] = toPs(x, y);
          lines.push(
            `${px1.toFixed(4)} ${py1.toFixed(4)} ${px2.toFixed(4)} ${py2.toFixed(4)} ${px.toFixed(4)} ${py.toFixed(4)} curveto`,
          );
          cx = x;
          cy = y;
        }
        break;
      }
      case "S": {
        // Smooth curveto — first control point is reflection of previous C's second cp.
        // We don't track that, so treat as C with first cp = current position.
        for (let i = 0; i + 3 < nums.length; i += 4) {
          const x2 = rel ? cx + nums[i] : nums[i];
          const y2 = rel ? cy + nums[i + 1] : nums[i + 1];
          const x = rel ? cx + nums[i + 2] : nums[i + 2];
          const y = rel ? cy + nums[i + 3] : nums[i + 3];
          const [px1, py1] = toPs(cx, cy);
          const [px2, py2] = toPs(x2, y2);
          const [px, py] = toPs(x, y);
          lines.push(
            `${px1.toFixed(4)} ${py1.toFixed(4)} ${px2.toFixed(4)} ${py2.toFixed(4)} ${px.toFixed(4)} ${py.toFixed(4)} curveto`,
          );
          cx = x;
          cy = y;
        }
        break;
      }
      case "Q": {
        // Quadratic — convert to cubic by elevating degree
        for (let i = 0; i + 3 < nums.length; i += 4) {
          const qx1 = rel ? cx + nums[i] : nums[i];
          const qy1 = rel ? cy + nums[i + 1] : nums[i + 1];
          const x = rel ? cx + nums[i + 2] : nums[i + 2];
          const y = rel ? cy + nums[i + 3] : nums[i + 3];
          const cx1 = cx + (2 / 3) * (qx1 - cx);
          const cy1 = cy + (2 / 3) * (qy1 - cy);
          const cx2 = x + (2 / 3) * (qx1 - x);
          const cy2 = y + (2 / 3) * (qy1 - y);
          const [px1, py1] = toPs(cx1, cy1);
          const [px2, py2] = toPs(cx2, cy2);
          const [px, py] = toPs(x, y);
          lines.push(
            `${px1.toFixed(4)} ${py1.toFixed(4)} ${px2.toFixed(4)} ${py2.toFixed(4)} ${px.toFixed(4)} ${py.toFixed(4)} curveto`,
          );
          cx = x;
          cy = y;
        }
        break;
      }
      case "Z": {
        lines.push("closepath");
        cx = startX;
        cy = startY;
        break;
      }
      default:
        break;
    }
    nums.length = 0;
  };

  let tok: RegExpExecArray | null;
  while ((tok = tokenRe.exec(d)) !== null) {
    if (tok[1]) {
      flush();
      cmd = tok[1];
      if (cmd.toUpperCase() === "Z") {
        flush();
        cmd = "";
      }
    } else if (tok[2] !== undefined) {
      nums.push(parseFloat(tok[2]));
    }
  }
  flush();

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// exportEps
// ---------------------------------------------------------------------------

/**
 * Export a single plate as EPS (PostScript).
 * Converts SVG bezier paths to PostScript moveto/curveto/closepath.
 */
export function exportEps(
  plate: CncPlate,
  printSize: PrintSize,
  kentoConfig: KentoConfig,
): string {
  const { width_mm, height_mm } = printSize;
  const widthPt = width_mm * MM_TO_PT;
  const heightPt = height_mm * MM_TO_PT;

  // SVG viewBox coords are treated as mm directly (same units as printSize)
  const scaleX = MM_TO_PT;
  const scaleY = MM_TO_PT;

  const paths = extractPaths(plateSource(plate));

  // Kento paths (if enabled) parsed from the kento SVG markup
  const kentoSvg = kentoConfig.enabled
    ? generateKentoMarks(width_mm, height_mm, kentoConfig)
    : "";
  const kentoPaths = kentoSvg ? extractPaths(kentoSvg) : [];

  const [r, g, b] = plate.color.map((c) => (c / 255).toFixed(4));

  const pathCommands = paths
    .map((d) => {
      const ps = svgPathToPostScript(d, scaleX, scaleY, heightPt);
      if (!ps) return "";
      return `newpath\n${ps}\nfill`;
    })
    .filter(Boolean)
    .join("\n\n");

  const kentoCommands = kentoPaths
    .map((d) => {
      const ps = svgPathToPostScript(d, scaleX, scaleY, heightPt);
      if (!ps) return "";
      return `newpath\n${ps}\nstroke`;
    })
    .filter(Boolean)
    .join("\n\n");

  const lines: string[] = [
    `%!PS-Adobe-3.0 EPSF-3.0`,
    `%%BoundingBox: 0 0 ${Math.ceil(widthPt)} ${Math.ceil(heightPt)}`,
    `%%HiResBoundingBox: 0.0 0.0 ${widthPt.toFixed(4)} ${heightPt.toFixed(4)}`,
    `%%Title: ${safeFilename(plate.name)}`,
    `%%Creator: color-separator-alpha`,
    `%%EndComments`,
    `%%BeginProlog`,
    `%%EndProlog`,
    `%%Page: 1 1`,
    `% Plate color: ${colorToHex(plate.color)}`,
    `${r} ${g} ${b} setrgbcolor`,
    pathCommands,
  ];

  if (kentoCommands) {
    lines.push(`% Kento registration marks`);
    lines.push(`0 0 0 setrgbcolor`);
    lines.push(`0.5 setlinewidth`);
    lines.push(kentoCommands);
  }

  // Color test strip: filled rectangle at bottom center
  const stripX = (widthPt / 2) - (10 * MM_TO_PT / 2); // 10mm wide
  const stripY = 3 * MM_TO_PT; // 3mm from bottom (PS coords: Y-up)
  const stripW = 10 * MM_TO_PT;
  const stripH = 3 * MM_TO_PT;
  lines.push(`% Color test strip`);
  lines.push(`${r} ${g} ${b} setrgbcolor`);
  lines.push(`newpath`);
  lines.push(`${stripX.toFixed(4)} ${stripY.toFixed(4)} moveto`);
  lines.push(`${(stripX + stripW).toFixed(4)} ${stripY.toFixed(4)} lineto`);
  lines.push(`${(stripX + stripW).toFixed(4)} ${(stripY + stripH).toFixed(4)} lineto`);
  lines.push(`${stripX.toFixed(4)} ${(stripY + stripH).toFixed(4)} lineto`);
  lines.push(`closepath fill`);
  // Label
  lines.push(`0 0 0 setrgbcolor`);
  lines.push(`/Courier 4 selectfont`);
  lines.push(`${(stripX).toFixed(4)} ${(stripY + stripH + 1 * MM_TO_PT).toFixed(4)} moveto`);
  lines.push(`(${safePsString(plate.name)} ${colorToHex(plate.color)}) show`);

  lines.push(`%%EOF`);

  return lines.filter((l) => l !== "").join("\n");
}

// ---------------------------------------------------------------------------
// exportDxf  (Maker.js)
// ---------------------------------------------------------------------------

/**
 * Export a single plate as DXF using makerjs.
 * VCarve imports DXF more reliably than SVG for physical dimensions.
 */
// Minimal structural types for the makerjs API surface we use.
// The package declares its namespace as MakerJs but tsconfig doesn't resolve it
// as an ambient namespace, so we define the subset we need inline.
interface MakerJsPoint extends Array<number> {
  0: number;
  1: number;
}

interface MakerJsPathLine {
  type: "line";
  origin: MakerJsPoint;
  end: MakerJsPoint;
}

interface MakerJsModel {
  models?: Record<string, MakerJsModel>;
  paths?: Record<string, MakerJsPathLine>;
}

interface MakerJsLib {
  importer: { fromSVGPathData: (d: string) => MakerJsModel };
  exporter: {
    toDXF: (model: MakerJsModel, options: { units: string }) => string;
  };
  paths: {
    Line: new (
      origin: [number, number],
      end: [number, number],
    ) => MakerJsPathLine;
  };
  unitType: { Millimeter: string };
}

export async function exportDxf(
  plate: CncPlate,
  printSize: PrintSize,
  kentoConfig: KentoConfig,
): Promise<string> {
  // makerjs ships as CJS; dynamic import avoids SSR issues
  const makerjs = (await import("makerjs")) as unknown as MakerJsLib;

  const { width_mm, height_mm } = printSize;
  const paths = extractPaths(plateSource(plate));

  const model: MakerJsModel = {
    models: {},
    paths: {},
  };

  // Convert SVG paths to Maker.js path chains.
  paths.forEach((d, i) => {
    const imported = makerjs.importer.fromSVGPathData(d);
    if (model.models) {
      model.models[`path_${i}`] = imported;
    }
  });

  // Kento marks
  if (kentoConfig.enabled) {
    const { offset_mm: offset, size_mm: size } = kentoConfig;

    // Kagi (L-shape, bottom-left)
    const kagiX = offset;
    const kagiY = height_mm - offset;
    if (model.paths) {
      model.paths["kento_kagi_v"] = new makerjs.paths.Line(
        [kagiX, kagiY - size],
        [kagiX, kagiY],
      );
      model.paths["kento_kagi_h"] = new makerjs.paths.Line(
        [kagiX, kagiY],
        [kagiX + size, kagiY],
      );
      // Hikitsuke (horizontal, bottom-right)
      const hikX1 = width_mm - offset - size;
      const hikX2 = width_mm - offset;
      const hikY = height_mm - offset;
      model.paths["kento_hik"] = new makerjs.paths.Line(
        [hikX1, hikY],
        [hikX2, hikY],
      );
    }
  }

  const dxf = makerjs.exporter.toDXF(model, {
    units: makerjs.unitType.Millimeter,
  });

  return dxf;
}

// ---------------------------------------------------------------------------
// layoutAllPlatesOnSheet
// ---------------------------------------------------------------------------

/**
 * Calculate an approximately square grid layout for N plates.
 * Returns [cols, rows].
 */
function gridDimensions(n: number): [number, number] {
  if (n <= 0) return [1, 1];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return [cols, rows];
}

/**
 * Arrange all plates on a single sheet SVG with a grid layout.
 * Kento marks on outer boundary only.
 */
export function layoutAllPlatesOnSheet(
  plates: CncPlate[],
  printSize: PrintSize,
  spacingMm: number,
  kentoConfig: KentoConfig,
): { svg: string; sheetWidthMm: number; sheetHeightMm: number } {
  if (plates.length === 0) {
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="0mm" height="0mm"/>`,
      sheetWidthMm: 0,
      sheetHeightMm: 0,
    };
  }

  const { width_mm: pw, height_mm: ph, margin_mm: margin } = printSize;
  const [cols, rows] = gridDimensions(plates.length);

  // Label height above each plate (approx 6mm for the text)
  const labelHeightMm = 6;

  const cellW = pw;
  const cellH = ph + labelHeightMm;

  const sheetWidthMm =
    margin * 2 + cols * cellW + (cols - 1) * spacingMm;
  const sheetHeightMm =
    margin * 2 + rows * cellH + (rows - 1) * spacingMm;

  const svgParts: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     width="${sheetWidthMm.toFixed(3)}mm" height="${sheetHeightMm.toFixed(3)}mm"`,
    `     viewBox="0 0 ${sheetWidthMm.toFixed(3)} ${sheetHeightMm.toFixed(3)}">`,
    `  <title>All plates — sheet layout</title>`,
  ];

  plates.forEach((plate, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);

    const offsetX = margin + col * (cellW + spacingMm);
    const offsetY = margin + row * (cellH + spacingMm);
    const plateTop = offsetY + labelHeightMm;

    const hex = colorToHex(plate.color);

    // Plate label
    svgParts.push(
      `  <text x="${(offsetX + cellW / 2).toFixed(3)}" y="${(offsetY + 4).toFixed(3)}"`,
      `        font-family="monospace" font-size="4" text-anchor="middle" fill="#333">`,
      `    ${safeXml(plate.name)} ${hex}`,
      `  </text>`,
    );

    // Plate border (hairline)
    svgParts.push(
      `  <rect x="${offsetX.toFixed(3)}" y="${plateTop.toFixed(3)}"`,
      `        width="${pw.toFixed(3)}" height="${ph.toFixed(3)}"`,
      `        fill="none" stroke="#ccc" stroke-width="0.3"/>`,
    );

    // Plate paths, translated into position
    const paths = extractPaths(plateSource(plate));
    if (paths.length > 0) {
      svgParts.push(
        `  <g transform="translate(${offsetX.toFixed(3)},${plateTop.toFixed(3)})">`,
      );
      paths.forEach((d) => {
        svgParts.push(
          `    <path d="${d}" fill="${hex}" stroke="none"/>`,
        );
      });
      svgParts.push(`  </g>`);
    }
  });

  // Kento marks on the outer sheet boundary
  if (kentoConfig.enabled) {
    const kentoSvg = generateKentoMarks(
      sheetWidthMm,
      sheetHeightMm,
      kentoConfig,
    );
    if (kentoSvg) {
      svgParts.push(`  ${kentoSvg}`);
    }
  }

  // Color mixing reference strip — all plate colors in print order
  const stripTop = sheetHeightMm - margin + 2; // Below last plate row, in bottom margin
  const swatchW = Math.min(15, (sheetWidthMm - margin * 2) / plates.length);
  const swatchH = 4;

  svgParts.push(`  <!-- Color mixing reference -->`);
  const sortedPlates = [...plates].sort((a, b) => a.printOrder - b.printOrder);
  sortedPlates.forEach((plate, i) => {
    const sx = margin + i * swatchW;
    const hex = colorToHex(plate.color);
    svgParts.push(
      `  <rect x="${sx.toFixed(3)}" y="${stripTop.toFixed(3)}" width="${(swatchW - 0.5).toFixed(3)}" height="${swatchH.toFixed(3)}" fill="${hex}" stroke="black" stroke-width="0.15"/>`,
    );
    svgParts.push(
      `  <text x="${(sx + swatchW / 2).toFixed(3)}" y="${(stripTop - 0.5).toFixed(3)}" font-family="monospace" font-size="2" text-anchor="middle" fill="#333">#${plate.printOrder}</text>`,
    );
  });

  svgParts.push(`</svg>`);

  return {
    svg: svgParts.join("\n"),
    sheetWidthMm,
    sheetHeightMm,
  };
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

function buildManifest(
  plates: CncPlate[],
  printSize: PrintSize,
  format: "svg" | "dxf" | "eps",
  layout: "individual" | "sheet",
  sheetDims?: { sheetWidthMm: number; sheetHeightMm: number },
): string {
  return JSON.stringify(
    {
      format,
      layout,
      printSize,
      plates: plates.map((p) => ({
        name: p.name,
        color: colorToHex(p.color),
        printOrder: p.printOrder,
        material: p.material,
        dimensions_mm: p.dimensions_mm,
      })),
      ...(sheetDims ?? {}),
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// exportProjectZip
// ---------------------------------------------------------------------------

/**
 * Package plates into a ZIP blob.
 * layout "individual" — one file per plate.
 * layout "sheet"      — single sheet SVG (only SVG supported for sheet).
 */
export async function exportProjectZip(
  plates: CncPlate[],
  printSize: PrintSize,
  kentoConfig: KentoConfig,
  format: "svg" | "dxf" | "eps",
  layout: "individual" | "sheet",
  spacingMm = 10,
): Promise<Blob> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  if (layout === "sheet") {
    // Sheet layout is SVG only (DXF/EPS sheet layout not implemented)
    const { svg, sheetWidthMm, sheetHeightMm } = layoutAllPlatesOnSheet(
      plates,
      printSize,
      spacingMm,
      kentoConfig,
    );
    zip.file("all-plates-sheet.svg", svg);
    zip.file(
      "manifest.json",
      buildManifest(plates, printSize, "svg", "sheet", {
        sheetWidthMm,
        sheetHeightMm,
      }),
    );
  } else {
    // Individual files per plate
    for (const plate of plates) {
      const safeName = safeFilename(plate.name);
      const hex = colorToHex(plate.color).replace("#", "");
      const basename = `plate${plate.printOrder}_${safeName}_${hex}`;

      if (format === "svg") {
        const content = exportCleanedSvg(plate, printSize, kentoConfig);
        zip.file(`${basename}.svg`, content);
      } else if (format === "eps") {
        const content = exportEps(plate, printSize, kentoConfig);
        zip.file(`${basename}.eps`, content);
      } else if (format === "dxf") {
        const content = await exportDxf(plate, printSize, kentoConfig);
        zip.file(`${basename}.dxf`, content);
      }
    }
    zip.file(
      "manifest.json",
      buildManifest(plates, printSize, format, "individual"),
    );
  }

  return zip.generateAsync({ type: "blob" });
}
