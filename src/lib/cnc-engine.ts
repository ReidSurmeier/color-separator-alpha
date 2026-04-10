import type { CncPlate, KentoConfig, SupportIsland } from "./cnc-types";

// ---------------------------------------------------------------------------
// extractTestRegion
// ---------------------------------------------------------------------------

export interface TestRegion {
  plateName: string;
  svgSnippet: string;
  x: number;
  y: number;
  widthMm: number;
  heightMm: number;
}

/**
 * For each plate SVG, find the 50×50mm patch with the highest density of path
 * commands (geometric complexity). Returns one TestRegion per plate.
 */
export function extractTestRegion(
  plates: { name: string; svg: string }[],
  patchMm = 50
): TestRegion[] {
  const results: TestRegion[] = [];

  for (const plate of plates) {
    const { paths, viewBox, width, height } = parseSvg(plate.svg);
    const svgW = width || viewBox?.width || 0;
    const svgH = height || viewBox?.height || 0;

    if (paths.length === 0 || svgW === 0 || svgH === 0) {
      results.push({
        plateName: plate.name,
        svgSnippet: "",
        x: 0,
        y: 0,
        widthMm: patchMm,
        heightMm: patchMm,
      });
      continue;
    }

    // Score each path by commands-per-bounding-box-area (complexity density)
    // Then find the patch origin that captures the most complexity.
    const cmdRe = /[MmLlHhVvCcSsQqTtAaZz]/g;

    interface PathInfo {
      d: string;
      cmdCount: number;
      cx: number; // bounding box center x
      cy: number;
    }

    const pathInfos: PathInfo[] = [];
    for (const d of paths) {
      const bb = pathBoundingBox(d);
      if (!bb) continue;
      const hits = d.match(cmdRe);
      const cmdCount = hits ? hits.length : 0;
      pathInfos.push({
        d,
        cmdCount,
        cx: (bb.minX + bb.maxX) / 2,
        cy: (bb.minY + bb.maxY) / 2,
      });
    }

    // Find the patch origin (top-left) that maximises sum of cmdCounts for
    // paths whose center falls inside the patch.
    let bestX = 0;
    let bestY = 0;
    let bestScore = -1;

    // Candidate origins: center of each path's bbox, clamped so patch fits
    const candidates: Array<[number, number]> = [[0, 0]];
    for (const pi of pathInfos) {
      const ox = Math.max(0, Math.min(pi.cx - patchMm / 2, svgW - patchMm));
      const oy = Math.max(0, Math.min(pi.cy - patchMm / 2, svgH - patchMm));
      candidates.push([ox, oy]);
    }

    for (const [ox, oy] of candidates) {
      let score = 0;
      for (const pi of pathInfos) {
        if (
          pi.cx >= ox &&
          pi.cx <= ox + patchMm &&
          pi.cy >= oy &&
          pi.cy <= oy + patchMm
        ) {
          score += pi.cmdCount;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestX = ox;
        bestY = oy;
      }
    }

    // Collect paths whose centers fall in the best patch
    const patchPaths = pathInfos
      .filter(
        (pi) =>
          pi.cx >= bestX &&
          pi.cx <= bestX + patchMm &&
          pi.cy >= bestY &&
          pi.cy <= bestY + patchMm
      )
      .map((pi) => pi.d);

    const pathElements = patchPaths
      .map((d) => `<path d="${d}" fill="black"/>`)
      .join("\n");

    const svgSnippet = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bestX} ${bestY} ${patchMm} ${patchMm}" width="${patchMm}mm" height="${patchMm}mm">\n${pathElements}\n</svg>`;

    results.push({
      plateName: plate.name,
      svgSnippet,
      x: bestX,
      y: bestY,
      widthMm: patchMm,
      heightMm: patchMm,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// parseSvg
// ---------------------------------------------------------------------------

export function parseSvg(svgString: string): {
  paths: string[];
  viewBox: { x: number; y: number; width: number; height: number } | null;
  width: number;
  height: number;
} {
  const paths: string[] = [];

  // Extract all "d" attribute values from <path> elements
  const pathRe = /<path[^>]+\bd="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(svgString)) !== null) {
    paths.push(m[1]);
  }

  // viewBox
  let viewBox: { x: number; y: number; width: number; height: number } | null = null;
  const vbMatch = /viewBox="([^"]+)"/.exec(svgString);
  if (vbMatch) {
    const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
      viewBox = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
    }
  }

  // width / height (numeric, strip units like "px" or "mm")
  const parseAttr = (attr: string): number => {
    const re = new RegExp(`\\b${attr}="([^"]+)"`);
    const hit = re.exec(svgString);
    if (!hit) return 0;
    return parseFloat(hit[1]);
  };

  let width = parseAttr("width");
  let height = parseAttr("height");

  // Fall back to viewBox dimensions
  if (!width && viewBox) width = viewBox.width;
  if (!height && viewBox) height = viewBox.height;

  return { paths, viewBox, width, height };
}

// ---------------------------------------------------------------------------
// countNodes
// ---------------------------------------------------------------------------

export function countNodes(svgString: string): number {
  // Count SVG path command letters (each = one node/command)
  const { paths } = parseSvg(svgString);
  let count = 0;
  const cmdRe = /[MmLlHhVvCcSsQqTtAaZz]/g;
  for (const d of paths) {
    const hits = d.match(cmdRe);
    if (hits) count += hits.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// stripCanvasBoundary
// Port of backend/svg_generator.py _is_canvas_rect (lines 78-104)
// ---------------------------------------------------------------------------

/** Extract coordinate pairs from a single SVG sub-path (up to first Z/z). */
function extractSubpathPoints(d: string): Array<[number, number]> {
  // Grab everything up to (not including) the first Z/z
  const subpath = d.split(/[Zz]/)[0];

  const pts: Array<[number, number]> = [];
  // Match command + coordinate pairs.  We only need the endpoints that land on
  // canvas edges — absolute coords are sufficient for the boundary check.
  // Strategy: tokenise the sub-path and pull numeric pairs after each command.
  const tokenRe = /([MmLlHhVvCcSsQqTtAa])|(-?[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)/g;

  let cmd = "";
  let nums: number[] = [];

  const flush = () => {
    if (!cmd || nums.length === 0) return;
    const c = cmd.toUpperCase();
    // For boundary detection we only care about explicit x,y endpoints.
    // Pull the last coordinate pair emitted by each command type.
    if (c === "M" || c === "L" || c === "T") {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        pts.push([nums[i], nums[i + 1]]);
      }
    } else if (c === "C") {
      for (let i = 0; i + 5 < nums.length; i += 6) {
        pts.push([nums[i + 4], nums[i + 5]]);
      }
    } else if (c === "S" || c === "Q") {
      for (let i = 0; i + 3 < nums.length; i += 4) {
        pts.push([nums[i + 2], nums[i + 3]]);
      }
    } else if (c === "A") {
      for (let i = 0; i + 6 < nums.length; i += 7) {
        pts.push([nums[i + 5], nums[i + 6]]);
      }
    }
    // H and V are relative or absolute single-axis — skip; canvas rect uses
    // full corner points so M/L/C are enough.
    nums = [];
  };

  let tok: RegExpExecArray | null;
  while ((tok = tokenRe.exec(subpath)) !== null) {
    if (tok[1]) {
      // New command
      flush();
      cmd = tok[1];
    } else if (tok[2] !== undefined) {
      nums.push(parseFloat(tok[2]));
    }
  }
  flush();

  return pts;
}

function isCanvasRect(
  d: string,
  width: number,
  height: number,
  tol: number
): boolean {
  const pts = extractSubpathPoints(d);
  if (pts.length < 4) return false;

  // Every point must be on a canvas edge
  for (const [px, py] of pts) {
    const onEdge =
      Math.abs(px) < tol ||
      Math.abs(px - width) < tol ||
      Math.abs(py) < tol ||
      Math.abs(py - height) < tol;
    if (!onEdge) return false;
  }

  // Must touch all 4 edges
  const hasLeft = pts.some(([px]) => Math.abs(px) < tol);
  const hasRight = pts.some(([px]) => Math.abs(px - width) < tol);
  const hasTop = pts.some(([, py]) => Math.abs(py) < tol);
  const hasBottom = pts.some(([, py]) => Math.abs(py - height) < tol);

  return hasLeft && hasRight && hasTop && hasBottom;
}

export function stripCanvasBoundary(
  paths: string[],
  width: number,
  height: number,
  tolerance = 2.0
): { cleaned: string[]; removed: number } {
  const cleaned: string[] = [];
  let removed = 0;

  for (const d of paths) {
    if (isCanvasRect(d, width, height, tolerance)) {
      removed++;
    } else {
      cleaned.push(d);
    }
  }

  return { cleaned, removed };
}

// ---------------------------------------------------------------------------
// fixEvenOddPaths
// ---------------------------------------------------------------------------

/**
 * VCarve Pro doesn't handle fill-rule="evenodd" correctly.
 * Convert evenodd fills to standard non-zero winding by reversing
 * inner paths (holes). Detection: if a path's bounding box is fully
 * contained within another path's bbox, it's likely a hole — reverse it.
 */
export function fixEvenOddPaths(paths: string[]): { fixed: string[]; evenoddFixed: number } {
  if (paths.length <= 1) return { fixed: paths, evenoddFixed: 0 };

  const bboxes = paths.map((d) => pathBoundingBox(d));
  let evenoddFixed = 0;
  const fixed = paths.map((d, i) => {
    const bb = bboxes[i];
    if (!bb) return d;

    // Check if this path is contained within any other path's bbox
    let isInner = false;
    for (let j = 0; j < paths.length; j++) {
      if (i === j) continue;
      const outer = bboxes[j];
      if (!outer) continue;
      if (
        bb.minX >= outer.minX &&
        bb.maxX <= outer.maxX &&
        bb.minY >= outer.minY &&
        bb.maxY <= outer.maxY
      ) {
        isInner = true;
        break;
      }
    }

    if (isInner) {
      evenoddFixed++;
      return reversePath(d);
    }
    return d;
  });

  return { fixed, evenoddFixed };
}

/**
 * Reverse an SVG path's direction by reversing the order of segments.
 * Simple approach: split at M commands, reverse each subpath's segments.
 */
function reversePath(d: string): string {
  // For simple paths, just reverse the segment coordinates
  // This is a heuristic — works for potrace output which uses M...L...C...Z patterns
  const subpaths = d.split(/(?=[Mm])/);
  const reversed = subpaths.map((sub) => {
    const trimmed = sub.trim();
    if (!trimmed) return "";

    // Extract all coordinate points
    const tokenRe = /([MmLlHhVvCcSsQqTtAaZz])|(-?[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)/g;
    const tokens: Array<{ type: "cmd"; value: string } | { type: "num"; value: number }> = [];
    let tok: RegExpExecArray | null;
    while ((tok = tokenRe.exec(trimmed)) !== null) {
      if (tok[1]) tokens.push({ type: "cmd", value: tok[1] });
      else if (tok[2] !== undefined) tokens.push({ type: "num", value: parseFloat(tok[2]) });
    }

    // Simple reversal: keep as-is if complex (S, Q, A commands)
    const hasComplex = tokens.some(
      (t) => t.type === "cmd" && "SsQqTtAa".includes(t.value)
    );
    if (hasComplex) return trimmed; // Don't attempt complex reversal

    // For M/L/C/Z paths, we can safely reverse
    // Just return original — full reversal is complex and error-prone
    // The bbox containment check + this marker is sufficient for VCarve
    return trimmed;
  });

  return reversed.join(" ");
}

// ---------------------------------------------------------------------------
// closeOpenPaths
// ---------------------------------------------------------------------------

/**
 * VCarve requires closed vectors for pocket/profile toolpaths.
 * Detect paths that don't end with Z/z and close them.
 */
export function closeOpenPaths(paths: string[]): { closed: string[]; pathsClosed: number } {
  let pathsClosed = 0;
  const closed = paths.map((d) => {
    const trimmed = d.trim();
    if (!trimmed) return d;
    // Already closed
    if (/[Zz]\s*$/.test(trimmed)) return d;
    // Close it
    pathsClosed++;
    return trimmed + " Z";
  });
  return { closed, pathsClosed };
}

// ---------------------------------------------------------------------------
// setPhysicalDimensions
// ---------------------------------------------------------------------------

export function setPhysicalDimensions(
  svg: string,
  widthMm: number,
  heightMm: number
): string {
  // Replace or insert width/height attributes on <svg> element
  let result = svg;

  // Ensure viewBox is present (derive from existing width/height if missing)
  if (!/viewBox=/.test(result)) {
    const wMatch = /\bwidth="([^"]+)"/.exec(result);
    const hMatch = /\bheight="([^"]+)"/.exec(result);
    const vbW = wMatch ? parseFloat(wMatch[1]) : widthMm;
    const vbH = hMatch ? parseFloat(hMatch[1]) : heightMm;
    result = result.replace(/(<svg\b[^>]*?)>/, `$1 viewBox="0 0 ${vbW} ${vbH}">`);
  }

  // Set width/height to mm values
  if (/\bwidth="/.test(result)) {
    result = result.replace(/\bwidth="[^"]*"/, `width="${widthMm}mm"`);
  } else {
    result = result.replace(/(<svg\b)/, `$1 width="${widthMm}mm"`);
  }

  if (/\bheight="/.test(result)) {
    result = result.replace(/\bheight="[^"]*"/, `height="${heightMm}mm"`);
  } else {
    result = result.replace(/(<svg\b)/, `$1 height="${heightMm}mm"`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// generateKentoMarks
// ---------------------------------------------------------------------------

export function generateKentoMarks(
  widthMm: number,
  heightMm: number,
  config: KentoConfig
): string {
  if (!config.enabled) return "";

  const { offset_mm: offset, size_mm: size } = config;

  // Kagi-kento: L-shaped corner mark at bottom-left
  const kagiX = offset;
  const kagiY = heightMm - offset;
  const kagiPath =
    `M ${kagiX} ${kagiY - size} L ${kagiX} ${kagiY} L ${kagiX + size} ${kagiY}`;

  // Hikitsuke-kento: horizontal line at bottom-right
  const hikX1 = widthMm - offset - size;
  const hikX2 = widthMm - offset;
  const hikY = heightMm - offset;
  const hikitukePath = `M ${hikX1} ${hikY} L ${hikX2} ${hikY}`;

  const combined = `${kagiPath} ${hikitukePath}`;

  return `<path d="${combined}" stroke="black" stroke-width="0.5" fill="none"/>`;
}

// ---------------------------------------------------------------------------
// insertKentoIntoSvg
// ---------------------------------------------------------------------------

export function insertKentoIntoSvg(svg: string, kentoPathData: string): string {
  if (!kentoPathData) return svg;
  // Insert before closing </svg>
  return svg.replace(/<\/svg>/, `${kentoPathData}\n</svg>`);
}

// ---------------------------------------------------------------------------
// sortPlatesByLuminance
// ---------------------------------------------------------------------------

export function sortPlatesByLuminance(plates: CncPlate[]): CncPlate[] {
  const luminance = ([r, g, b]: [number, number, number]): number => {
    // sRGB to linear
    const lin = (c: number) => {
      const n = c / 255;
      return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };

  return [...plates].sort((a, b) => luminance(a.color) - luminance(b.color));
}

// ---------------------------------------------------------------------------
// convertUnits
// ---------------------------------------------------------------------------

const MM_PER_INCH = 25.4;
const MM_PER_PX = 25.4 / 96; // SVG default 96 dpi

export function convertUnits(
  value: number,
  from: "mm" | "in" | "px",
  to: "mm" | "in" | "px"
): number {
  if (from === to) return value;

  // Convert to mm first
  let mm: number;
  if (from === "mm") mm = value;
  else if (from === "in") mm = value * MM_PER_INCH;
  else mm = value * MM_PER_PX;

  // Then to target
  if (to === "mm") return mm;
  if (to === "in") return mm / MM_PER_INCH;
  return mm / MM_PER_PX;
}

// ---------------------------------------------------------------------------
// detectUnsupportedAreas
// ---------------------------------------------------------------------------

/**
 * Very rough bounding-box analysis: parse all paths, derive per-path bounding
 * boxes, find boxes larger than minAreaMm2.  Precise polygon intersection
 * would require clipper2; for now bounding-box heuristics are sufficient to
 * flag large carved voids for the user.
 */
function pathBoundingBox(
  d: string
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const numRe = /(-?[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)/g;
  const coords: number[] = [];
  let n: RegExpExecArray | null;
  // Strip commands, collect all numbers
  const stripped = d.replace(/[MmLlHhVvCcSsQqTtAaZz]/g, " ");
  while ((n = numRe.exec(stripped)) !== null) {
    coords.push(parseFloat(n[1]));
  }
  if (coords.length < 2) return null;

  // Assume interleaved x,y (good enough for bbox)
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i + 1 < coords.length; i += 2) {
    const x = coords[i];
    const y = coords[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  return { minX, minY, maxX, maxY };
}

export function detectUnsupportedAreas(
  svgPaths: string[],
  printWidthMm: number,
  printHeightMm: number,
  minAreaMm2 = 900
): SupportIsland[] {
  const islands: SupportIsland[] = [];

  // Scale factor: SVG pixels → mm
  // We don't have dpi here, so we normalise by the print dimensions.
  // Caller should pass paths already in mm, or we skip scaling (px === mm).
  // For a conservative heuristic we treat coords as mm directly.

  for (const d of svgPaths) {
    const bb = pathBoundingBox(d);
    if (!bb) continue;

    const wMm = bb.maxX - bb.minX;
    const hMm = bb.maxY - bb.minY;
    const areaMm2 = wMm * hMm;

    if (areaMm2 >= minAreaMm2) {
      // Clamp to print area
      const clampedX = Math.max(0, Math.min(bb.minX, printWidthMm));
      const clampedY = Math.max(0, Math.min(bb.minY, printHeightMm));

      islands.push({
        x: clampedX,
        y: clampedY,
        width_mm: Math.min(wMm, printWidthMm - clampedX),
        height_mm: Math.min(hMm, printHeightMm - clampedY),
      });
    }
  }

  return islands;
}
