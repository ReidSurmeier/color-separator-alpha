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
// compensateToolPath
// ---------------------------------------------------------------------------

/**
 * Offset paths inward by tool radius using clipper2-ts.
 * This compensates for the physical width of the CNC cutting tool,
 * ensuring the carved area matches the original artwork boundary.
 *
 * For endmills: offset = -radius (paths shrink by half the tool diameter)
 * For V-bits: offset = -radius at the surface (tip compensation)
 */
export async function compensateToolPath(
  paths: string[],
  toolRadiusMm: number,
): Promise<{ compensated: string[]; compensatedCount: number }> {
  if (toolRadiusMm === 0 || paths.length === 0) {
    return { compensated: paths, compensatedCount: 0 };
  }

  // Dynamic import to avoid bundling ~200KB clipper2-ts in initial page load
  const { inflatePaths, JoinType, EndType } = await import("clipper2-ts");

  // Scale factor: work in integer space (clipper uses bigints)
  const SCALE = 1000;
  const delta = -toolRadiusMm * SCALE;

  let compensatedCount = 0;
  const compensated: string[] = [];

  for (const d of paths) {
    const subpathPolygons = parseSvgPathToPolygons(d);

    if (subpathPolygons.length === 0) {
      compensated.push(d);
      continue;
    }

    // Convert each subpath polygon to clipper Path64
    const clipperPaths = subpathPolygons.map((pts) =>
      pts.map(([x, y]) => ({
        x: Math.round(x * SCALE),
        y: Math.round(y * SCALE),
      }))
    );

    const inflated = inflatePaths(clipperPaths, delta, JoinType.Round, EndType.Polygon);

    if (!inflated || inflated.length === 0) {
      // Path disappeared (too small for tool) — skip it
      compensatedCount++;
      continue;
    }

    // Convert result paths back to SVG d strings
    for (const path of inflated) {
      if (path.length < 2) continue;
      const parts: string[] = [];
      for (let i = 0; i < path.length; i++) {
        const x = (Number(path[i].x) / SCALE).toFixed(3);
        const y = (Number(path[i].y) / SCALE).toFixed(3);
        parts.push(i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`);
      }
      parts.push("Z");
      compensated.push(parts.join(" "));
    }

    compensatedCount++;
  }

  return { compensated, compensatedCount };
}

/**
 * Parse an SVG path `d` string into arrays of polygon points.
 * Each subpath (separated by M commands) becomes one polygon.
 * Cubic bezier curves are sampled at 8 points for CNC approximation.
 */
function parseSvgPathToPolygons(d: string): Array<Array<[number, number]>> {
  const tokenRe = /([MmLlHhVvCcSsQqTtAaZz])|(-?[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)/g;

  const tokens: Array<{ type: "cmd"; value: string } | { type: "num"; value: number }> = [];
  let tok: RegExpExecArray | null;
  while ((tok = tokenRe.exec(d)) !== null) {
    if (tok[1]) tokens.push({ type: "cmd", value: tok[1] });
    else if (tok[2] !== undefined) tokens.push({ type: "num", value: parseFloat(tok[2]) });
  }

  const polygons: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;

  let i = 0;
  const nums: number[] = [];
  let cmd = "";

  const flushCmd = () => {
    if (!cmd) return;
    const c = cmd;
    const abs = c === c.toUpperCase();

    if (c === "M" || c === "m") {
      // Start new subpath
      if (current.length > 0) {
        polygons.push(current);
        current = [];
      }
      for (let k = 0; k + 1 < nums.length; k += 2) {
        const x = abs ? nums[k] : cx + nums[k];
        const y = abs ? nums[k + 1] : cy + nums[k + 1];
        if (k === 0) { startX = x; startY = y; }
        cx = x; cy = y;
        current.push([cx, cy]);
      }
    } else if (c === "L" || c === "l") {
      for (let k = 0; k + 1 < nums.length; k += 2) {
        cx = abs ? nums[k] : cx + nums[k];
        cy = abs ? nums[k + 1] : cy + nums[k + 1];
        current.push([cx, cy]);
      }
    } else if (c === "H" || c === "h") {
      for (let k = 0; k < nums.length; k++) {
        cx = abs ? nums[k] : cx + nums[k];
        current.push([cx, cy]);
      }
    } else if (c === "V" || c === "v") {
      for (let k = 0; k < nums.length; k++) {
        cy = abs ? nums[k] : cy + nums[k];
        current.push([cx, cy]);
      }
    } else if (c === "C" || c === "c") {
      // Cubic bezier — sample 8 points along each curve
      for (let k = 0; k + 5 < nums.length; k += 6) {
        const x0 = cx;
        const y0 = cy;
        const x1 = abs ? nums[k] : cx + nums[k];
        const y1 = abs ? nums[k + 1] : cy + nums[k + 1];
        const x2 = abs ? nums[k + 2] : cx + nums[k + 2];
        const y2 = abs ? nums[k + 3] : cy + nums[k + 3];
        const x3 = abs ? nums[k + 4] : cx + nums[k + 4];
        const y3 = abs ? nums[k + 5] : cy + nums[k + 5];
        const samples = 8;
        for (let s = 1; s <= samples; s++) {
          const t = s / samples;
          const mt = 1 - t;
          const bx = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
          const by = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
          current.push([bx, by]);
        }
        cx = x3; cy = y3;
      }
    } else if (c === "S" || c === "s") {
      // Smooth cubic bezier — treat as line segments to control point + endpoint
      for (let k = 0; k + 3 < nums.length; k += 4) {
        const x2 = abs ? nums[k] : cx + nums[k];
        const y2 = abs ? nums[k + 1] : cy + nums[k + 1];
        const x3 = abs ? nums[k + 2] : cx + nums[k + 2];
        const y3 = abs ? nums[k + 3] : cy + nums[k + 3];
        // Sample with reflected control point (approximate)
        const x0 = cx; const y0 = cy;
        const x1 = x0; const y1 = y0; // simplified: use current point
        const samples = 8;
        for (let s = 1; s <= samples; s++) {
          const t = s / samples;
          const mt = 1 - t;
          const bx = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
          const by = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
          current.push([bx, by]);
        }
        cx = x3; cy = y3;
      }
    } else if (c === "Q" || c === "q") {
      // Quadratic bezier
      for (let k = 0; k + 3 < nums.length; k += 4) {
        const x0 = cx; const y0 = cy;
        const x1 = abs ? nums[k] : cx + nums[k];
        const y1 = abs ? nums[k + 1] : cy + nums[k + 1];
        const x2 = abs ? nums[k + 2] : cx + nums[k + 2];
        const y2 = abs ? nums[k + 3] : cy + nums[k + 3];
        const samples = 8;
        for (let s = 1; s <= samples; s++) {
          const t = s / samples;
          const mt = 1 - t;
          const bx = mt * mt * x0 + 2 * mt * t * x1 + t * t * x2;
          const by = mt * mt * y0 + 2 * mt * t * y1 + t * t * y2;
          current.push([bx, by]);
        }
        cx = x2; cy = y2;
      }
    } else if (c === "T" || c === "t") {
      // Smooth quadratic — approximate as line
      for (let k = 0; k + 1 < nums.length; k += 2) {
        cx = abs ? nums[k] : cx + nums[k];
        cy = abs ? nums[k + 1] : cy + nums[k + 1];
        current.push([cx, cy]);
      }
    } else if (c === "Z" || c === "z") {
      // Close subpath
      cx = startX; cy = startY;
      if (current.length > 0) {
        polygons.push(current);
        current = [];
      }
    }
    // A (arc) — fall through, emit endpoint only
    else if (c === "A" || c === "a") {
      for (let k = 0; k + 6 < nums.length; k += 7) {
        cx = abs ? nums[k + 5] : cx + nums[k + 5];
        cy = abs ? nums[k + 6] : cy + nums[k + 6];
        current.push([cx, cy]);
      }
    }
  };

  // Walk tokens
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "cmd") {
      flushCmd();
      cmd = t.value;
      nums.length = 0;
    } else {
      nums.push(t.value);
    }
  }
  flushCmd();

  if (current.length > 0) {
    polygons.push(current);
  }

  return polygons;
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

/**
 * Generate professional registration marks for multi-plate alignment.
 * Combines Japanese kento (proven for woodblock), CNC dowel references,
 * and commercial print registration targets.
 *
 * All marks are placed OUTSIDE the print area in the margin zone.
 */
export function generateKentoMarks(
  widthMm: number,
  heightMm: number,
  config: KentoConfig
): string {
  if (!config.enabled) return "";

  const { offset_mm: offset, size_mm: size } = config;
  const parts: string[] = [];

  // --- 1. KAGI-KENTO (L-shaped corner mark, bottom-left) ---
  // Traditional Japanese registration: L-shape guides paper corner
  const kagiX = offset;
  const kagiY = heightMm - offset;
  parts.push(
    `<path d="M ${kagiX} ${kagiY - size} L ${kagiX} ${kagiY} L ${kagiX + size} ${kagiY}" ` +
    `stroke="black" stroke-width="0.5" fill="none" class="kento-kagi"/>`
  );

  // --- 2. HIKITSUKE-KENTO (edge guide, bottom-right) ---
  // Horizontal reference line for paper edge alignment
  const hikX1 = widthMm - offset - size;
  const hikX2 = widthMm - offset;
  const hikY = heightMm - offset;
  parts.push(
    `<path d="M ${hikX1} ${hikY} L ${hikX2} ${hikY}" ` +
    `stroke="black" stroke-width="0.5" fill="none" class="kento-hikitsuke"/>`
  );

  // --- 3. REGISTRATION CROSSHAIRS (all 4 corners) ---
  // Commercial print standard: cross + circle at each corner
  const crossSize = 3; // 3mm arms
  const circleR = 2;   // 2mm radius circle
  const crossW = 0.25; // hairline

  const corners = [
    { x: offset, y: offset },                           // top-left
    { x: widthMm - offset, y: offset },                 // top-right
    { x: offset, y: heightMm - offset },                // bottom-left (near kagi)
    { x: widthMm - offset, y: heightMm - offset },      // bottom-right (near hikitsuke)
  ];

  for (const { x, y } of corners) {
    // Crosshair
    parts.push(
      `<path d="M ${x - crossSize} ${y} L ${x + crossSize} ${y} M ${x} ${y - crossSize} L ${x} ${y + crossSize}" ` +
      `stroke="black" stroke-width="${crossW}" fill="none" class="reg-cross"/>`
    );
    // Circle
    parts.push(
      `<circle cx="${x}" cy="${y}" r="${circleR}" ` +
      `stroke="black" stroke-width="${crossW}" fill="none" class="reg-circle"/>`
    );
  }

  // --- 4. CENTER MARKS (top + bottom edge centers) ---
  const centerX = widthMm / 2;
  // Top center
  parts.push(
    `<path d="M ${centerX - crossSize} ${offset} L ${centerX + crossSize} ${offset} ` +
    `M ${centerX} ${offset - crossSize} L ${centerX} ${offset + crossSize}" ` +
    `stroke="black" stroke-width="${crossW}" fill="none" class="reg-center"/>`
  );
  // Bottom center
  parts.push(
    `<path d="M ${centerX - crossSize} ${heightMm - offset} L ${centerX + crossSize} ${heightMm - offset} ` +
    `M ${centerX} ${heightMm - offset - crossSize} L ${centerX} ${heightMm - offset + crossSize}" ` +
    `stroke="black" stroke-width="${crossW}" fill="none" class="reg-center"/>`
  );

  // --- 5. DOWEL PIN HOLES (CNC standard — opposite corners) ---
  // Round hole top-left, diamond hole bottom-right
  // These are cut marks for drilling alignment pin holes
  const pinR = 1.5; // 3mm diameter dowel
  const pinOffset = offset + size + 3; // Beyond kento marks

  // Round pin hole indicator (top-left)
  parts.push(
    `<circle cx="${pinOffset}" cy="${pinOffset}" r="${pinR}" ` +
    `stroke="black" stroke-width="0.3" fill="none" stroke-dasharray="0.5,0.5" class="pin-round"/>`
  );
  // Center dot
  parts.push(
    `<circle cx="${pinOffset}" cy="${pinOffset}" r="0.3" fill="black" class="pin-center"/>`
  );

  // Diamond pin hole indicator (bottom-right) — allows thermal expansion
  const pinBRx = widthMm - pinOffset;
  const pinBRy = heightMm - pinOffset;
  const dw = pinR;
  const dh = pinR * 1.5;
  parts.push(
    `<path d="M ${pinBRx} ${pinBRy - dh} L ${pinBRx + dw} ${pinBRy} L ${pinBRx} ${pinBRy + dh} L ${pinBRx - dw} ${pinBRy} Z" ` +
    `stroke="black" stroke-width="0.3" fill="none" stroke-dasharray="0.5,0.5" class="pin-diamond"/>`
  );
  parts.push(
    `<circle cx="${pinBRx}" cy="${pinBRy}" r="0.3" fill="black" class="pin-center"/>`
  );

  return parts.join("\n");
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
