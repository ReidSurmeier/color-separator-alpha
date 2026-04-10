# CNC Companion Tool — Implementation Plan v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Build `/cnc` page that bridges color-separator output and VCarve Pro — SVG cleanup, physical dimensions, kento marks, composite preview, plate management, support islands, test cut extraction.

**Architecture:** 100% client-side. Maker.js + clipper2-ts. No backend changes.

**Tech Stack:** Next.js 16, Maker.js, clipper2-ts, JSZip, TypeScript

**Spec:** `docs/superpowers/specs/2026-04-10-cnc-companion-v2.md`

---

## Task Order

```
Task 1: deps + types + route shell
Task 2: SVG processing engine (cleanup + dimensions + kento)
Task 3: export engine (SVG/EPS/DXF with mm)
Task 4: sidebar + plate dashboard
Task 5: composite preview + per-plate view
Task 6: state hook (wires everything)
Task 7: assemble page
Task 8: support islands + test cut
Task 9: main page deep link
Task 10: deploy + E2E tests (loop until pass)
```

---

### Task 1: Dependencies + Types + Route Shell

**Files:**
- Modify: `package.json`
- Create: `src/lib/cnc-types.ts`
- Create: `src/app/cnc/page.tsx`

- [ ] **Step 1: Install deps**
```bash
npm install makerjs clipper2-ts
```

- [ ] **Step 2: Create `src/lib/cnc-types.ts`**

All types for the CNC page. Tool presets, plate model, kento config, processing result.

Key types:
- `Tool` — id, label, diameter_mm, type (endmill/vbit)
- `TOOLS` — array of 6 tool presets (1/8" end, 1/4" end, 1/8" down, 1/4" down, 60° V, 30° V)
- `CncPlate` — name, color, svgRaw, svgCleaned, dimensions_mm, nodeCount, printOrder, material, cutStatus
- `KentoConfig` — offset_mm, depth_mm, size_mm, style ("traditional" | "pin")
- `PrintSize` — width_mm, height_mm, margin_mm
- `SupportIsland` — x, y, width_mm, height_mm
- `ProjectState` — plates[], printSize, kentoConfig, selectedTool, unit ("mm" | "in")

- [ ] **Step 3: Create minimal route shell**

`src/app/cnc/page.tsx` — "use client", renders "CNC.TOOLPATH" title, back link to `/`.

- [ ] **Step 4: Verify**
```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**
```bash
git add package.json package-lock.json src/lib/cnc-types.ts src/app/cnc/page.tsx
git commit -m "feat(cnc): route shell + types + deps"
```

---

### Task 2: SVG Processing Engine

**Files:**
- Create: `src/lib/cnc-engine.ts`

Core SVG cleanup logic. Pure functions, no UI.

- [ ] **Step 1: Create `src/lib/cnc-engine.ts`**

Functions:
- `parseSvg(svgString)` — extract path data, viewBox, dimensions
- `stripCanvasBoundary(paths)` — detect and remove potrace boundary rectangles (same logic as `svg_generator.py:_is_canvas_rect` — check all endpoints on canvas edges)
- `countNodes(svgString)` — count path commands
- `setPhysicalDimensions(svg, widthMm, heightMm)` — set `width="Xmm" height="Ymm"` + correct viewBox
- `generateKentoMarks(widthMm, heightMm, config)` — return SVG path data for kagi (L-corner at bottom-left) + hikitsuke (line at bottom-right). Standard mokuhanga positions.
- `insertKentoIntoSvg(svg, kentoPathData)` — add kento paths to existing SVG
- `sortPlatesByLuminance(plates)` — sort light-to-dark based on plate RGB color (convert to LAB, sort by L*)
- `convertUnits(value, from, to)` — mm ↔ inches ↔ px (at 96dpi for SVG)
- `analyzePlateForSupport(svg, minUnsupportedAreaMm)` — find large carved regions that need paper support islands

Reference `backend/svg_generator.py:78-90` for the canvas boundary detection pattern — port the `_is_canvas_rect` logic to TypeScript.

- [ ] **Step 2: Verify compiles**
```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**
```bash
git add src/lib/cnc-engine.ts
git commit -m "feat(cnc): SVG processing engine — cleanup, kento, dimensions, support detection"
```

---

### Task 3: Export Engine (SVG/EPS/DXF)

**Files:**
- Create: `src/lib/cnc-export.ts`

Export cleaned plates in multiple formats with physical dimensions.

- [ ] **Step 1: Create `src/lib/cnc-export.ts`**

Functions:
- `exportCleanedSvg(plate, printSize, kentoConfig)` — SVG with mm dimensions, kento marks, boundary rect stripped. Explicit `width="300mm" height="400mm"` attributes.
- `exportDxf(plate, printSize, kentoConfig)` — use Maker.js `exporter.toDXF()` with mm units. VCarve imports DXF more reliably than SVG for dimensions.
- `exportEps(plate, printSize, kentoConfig)` — EPS format (Vectric's recommended). Convert SVG paths to PostScript path commands. Include BoundingBox in mm.
- `exportProjectZip(plates, printSize, kentoConfig, format)` — JSZip: one file per plate in chosen format + manifest.json with plate metadata (color, print order, dimensions, material).

EPS export is the key differentiator — VCarve handles EPS better than SVG. The EPS generator converts SVG bezier paths to PostScript `moveto`/`curveto`/`closepath` commands with correct scaling.

- [ ] **Step 2: Verify compiles**
```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**
```bash
git add src/lib/cnc-export.ts
git commit -m "feat(cnc): export engine — SVG/DXF/EPS with mm dimensions + kento"
```

---

### Task 4: CNC Sidebar (CncNavPanel)

**Files:**
- Create: `src/components/CncNavPanel.tsx`

Same styling as main site NavPanel. Square slider thumbs, AUTHENTICSans font.

- [ ] **Step 1: Create `src/components/CncNavPanel.tsx`**

Sections (top to bottom):
- **source** — upload ZIP/SVGs button, drag-drop area, filename display
- **print size** — width + height inputs (number, mm or inches), mm/in toggle, margin slider
- **kento** — on/off toggle, offset slider, size slider. Preview updates live.
- **tool** (for time estimate) — 6 preset buttons matching main page upscale toggle pattern
- **actions** — process, reset
- **export** — format selector (SVG/DXF/EPS), download button
- **plates** — draggable list: color swatch, name, print order number, cut status checkbox. Drag to reorder.
- **stats** — total plates, print size in mm and inches, estimated machine time, nodes cleaned

Reference `src/components/NavPanel.tsx:163-194` for toggle button pattern. Reference `src/components/NavPanel.tsx:206-213` for slider pattern. Match exactly — square thumbs, same spacing.

- [ ] **Step 2: Verify compiles**
```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**
```bash
git add src/components/CncNavPanel.tsx
git commit -m "feat(cnc): sidebar — print size, kento, tool, plates, export"
```

---

### Task 5: Composite Preview + Per-Plate View

**Files:**
- Create: `src/components/PlatePreview.tsx`

Two view modes in the canvas area.

- [ ] **Step 1: Create `src/components/PlatePreview.tsx`**

**Composite view** (default):
- All plates overlaid with assigned colors in print order
- Each plate's SVG rendered as a colored layer (use CSS `mix-blend-mode: multiply` for realistic ink simulation)
- Plate toggle checkboxes to show/hide individual plates
- Kento marks shown at edges
- Physical dimensions displayed (e.g., "300mm" labels on edges)
- Margin area shown as dashed border

**Per-plate view** (click a plate in sidebar):
- Single plate SVG at full detail
- Kento marks shown
- Support island suggestions highlighted (orange dots)
- Dimension labels
- Before/after toggle if SVG was cleaned (boundary rect removed etc.)

**Shared:**
- Zoom/pan (scroll to zoom, drag to pan)
- mm/inches dimension labels update with unit toggle

- [ ] **Step 2: Verify compiles**
```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**
```bash
git add src/components/PlatePreview.tsx
git commit -m "feat(cnc): composite preview + per-plate view with kento + dimensions"
```

---

### Task 6: State Hook (useCncProcessor)

**Files:**
- Create: `src/hooks/useCncProcessor.ts`

Wires engine to UI. Manages all state.

- [ ] **Step 1: Create `src/hooks/useCncProcessor.ts`**

State:
- `plates: CncPlate[]` — loaded from ZIP or sessionStorage
- `printSize: PrintSize` — width_mm, height_mm, margin_mm
- `unit: "mm" | "in"` — display unit
- `kentoConfig: KentoConfig`
- `selectedTool: Tool`
- `viewMode: "composite" | "plate"`
- `selectedPlateIndex: number`
- `isProcessing: boolean`
- `exportFormat: "svg" | "dxf" | "eps"`

Handlers:
- `handleFileUpload` — accept ZIP (extract SVGs via JSZip) or individual SVG files. Parse plate colors from manifest.json or SVG fill attributes. Auto-sort by luminance.
- `handleProcess` — run `stripCanvasBoundary`, `setPhysicalDimensions`, `generateKentoMarks` on each plate
- `handleExport` — call export engine, package into ZIP, trigger browser download
- `handleReorder` — drag-drop plate reorder
- `handlePrintSizeChange` — update dimensions, reprocess
- `handleUnitToggle` — switch mm ↔ inches
- SessionStorage loading — check for `cnc-plates` key on mount (from main page handoff)

- [ ] **Step 2: Verify compiles**
```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**
```bash
git add src/hooks/useCncProcessor.ts
git commit -m "feat(cnc): state hook — upload, process, export, reorder, units"
```

---

### Task 7: Assemble CNC Page

**Files:**
- Modify: `src/app/cnc/page.tsx`
- Create: `src/app/cnc/cnc.css`

Wire all components.

- [ ] **Step 1: Create `src/app/cnc/cnc.css`**

Match main site: same sidebar width, AUTHENTICSans font, square slider thumbs, same button padding. Add:
- Plate list drag handle styling
- Composite preview layer styling
- Dimension label overlays
- Kento mark preview styling
- Support island highlight (orange)

- [ ] **Step 2: Update `page.tsx`**

Wire CncNavPanel + PlatePreview + useCncProcessor. Same layout as main page. Back link to `/`. Hamburger for mobile.

- [ ] **Step 3: Build and verify**
```bash
npm run build
```

- [ ] **Step 4: Commit**
```bash
git add src/app/cnc/page.tsx src/app/cnc/cnc.css
git commit -m "feat(cnc): page assembled — sidebar + preview + processing"
```

---

### Task 8: Support Islands + Test Cut

**Files:**
- Modify: `src/lib/cnc-engine.ts`

Add support island detection and test cut extraction.

- [ ] **Step 1: Add support island detection**

In `cnc-engine.ts`, add:
- `detectUnsupportedAreas(svgPaths, printSizeMm)` — find contiguous carved (non-printing) areas larger than a threshold (e.g., 30mm × 30mm). These areas have no raised wood to support paper during printing.
- `suggestSupportIslands(unsupportedAreas)` — generate small raised dots/bars (2mm × 5mm) spaced evenly in large carved areas. These don't print (they're below ink level) but support the paper.
- `insertSupportIslands(svg, islands)` — add island geometry to the plate SVG

- [ ] **Step 2: Add test cut extraction**

- `extractTestRegion(plates, testSizeMm)` — for each plate, find the region with highest geometric complexity (most nodes per mm²). Extract a `testSizeMm × testSizeMm` patch.
- `generateTestCutFile(testRegions, printSize)` — arrange all test patches in a grid, add labels, export as single SVG/DXF.

- [ ] **Step 3: Verify compiles + commit**
```bash
npx tsc --noEmit
git add src/lib/cnc-engine.ts
git commit -m "feat(cnc): support island detection + test cut extraction"
```

---

### Task 9: Main Page Deep Link

**Files:**
- Modify: `src/components/NavPanel.tsx`
- Modify: `src/hooks/useColorSeparator.ts`

- [ ] **Step 1: Add `handlePrepareCnc` to useColorSeparator.ts**

Stores plate SVGs + colors + manifest in sessionStorage `cnc-plates`, navigates to `/cnc`.

- [ ] **Step 2: Add "prepare for CNC →" button in NavPanel.tsx**

After merge plates section:
```
<h3>cnc</h3>
<button onClick={onPrepareCnc} disabled={!compositeUrl}>prepare for CNC →</button>
```

- [ ] **Step 3: Commit**
```bash
git add src/components/NavPanel.tsx src/hooks/useColorSeparator.ts
git commit -m "feat(cnc): deep link from main page"
```

---

### Task 10: Deploy + E2E Tests (Loop)

**Files:**
- Create: `e2e/cnc.spec.ts`

- [ ] **Step 1: Deploy frontend to Windows Docker**
```bash
scp -r src/ reidsurmeier2@100.67.23.102:"C:/colorsep/src/"
scp package.json package-lock.json reidsurmeier2@100.67.23.102:"C:/colorsep/"
ssh reidsurmeier2@100.67.23.102 "cd C:\colorsep && docker compose -f docker-compose.local.yml build --no-cache frontend && docker compose -f docker-compose.local.yml up -d"
```

- [ ] **Step 2: Verify /cnc route live**
```bash
curl -sf https://color.reidsurmeier.wtf/cnc | grep "CNC.TOOLPATH"
```

- [ ] **Step 3: Create E2E test**

All through real browser at `color.reidsurmeier.wtf/cnc`:

**Test 1: Upload + dimensions + kento + export**
1. Upload 2-plate ZIP from previous test
2. Set print size 200×300mm
3. Enable kento marks
4. Click process
5. Verify dimensions shown on preview ("200mm" label visible)
6. Download cleaned SVG ZIP
7. Intercept blob, unzip, verify: SVGs have `width="200mm"`, kento paths present, canvas boundary rect removed

**Test 2: Composite preview + reorder**
1. Upload 4-plate ZIP
2. Verify composite preview shows 4 colored layers
3. Verify plates sorted light-to-dark
4. Check mm/in toggle changes displayed dimensions

**Test 3: Deep link from main page**
1. Go to main page, upload image, process
2. Click "prepare for CNC →"
3. Verify /cnc page loads with plates already present

- [ ] **Step 4: Run tests, loop until pass**
```bash
npx playwright test e2e/cnc.spec.ts --config playwright-e2e.config.ts
```

- [ ] **Step 5: Commit + push**
```bash
git add e2e/cnc.spec.ts
git commit -m "test(cnc): E2E — upload, dimensions, kento, composite, deep link"
git push origin master
```
