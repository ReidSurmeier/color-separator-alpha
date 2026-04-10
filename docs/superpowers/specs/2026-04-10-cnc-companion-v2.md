# CNC Companion Tool — Revised Spec v2

**Date:** 2026-04-10
**Route:** `color.reidsurmeier.wtf/cnc`
**Purpose:** Bridge between color-separator SVG output and VCarve Pro — handle everything VCarve can't do for multi-plate mokuhanga woodblock production.

## Philosophy

Not rebuilding VCarve. Complementing it. Every feature exists because VCarve genuinely can't do it or does it badly for this specific workflow.

## Features (7 + unit conversion)

### 1. SVG Pre-Processing Pipeline
Strip potrace artifacts before VCarve import:
- Remove canvas boundary rectangles (potrace wrapper rect)
- Convert `fill-rule="evenodd"` compound paths to simple closed paths
- Close open paths
- Set explicit physical dimensions (mm/inches) in SVG attributes
- Export as EPS (Vectric's recommended import format) AND cleaned SVG AND DXF
- Fix the 80% SVG scaling bug (explicit viewBox + width/height in mm)

### 2. Physical Dimensions + Unit Conversion
- Set print size: width × height in mm or inches (toggle)
- Scale all plates to match physical print size
- Plate margins for kento registration area (add Xmm border)
- Show real-world dimensions on preview: "this plate is 300mm × 400mm"
- Convert between mm ↔ inches ↔ px throughout the UI
- VCarve import dimensions match exactly — no more guessing scale

### 3. Kento Registration Marks
- Auto-generate L-corner (kagi-kento) and edge line (hikitsuke-kento) at identical positions on every plate
- Configurable: kento offset from print edge, kento depth, kento size
- Preview kento positions on plate
- Kento geometry included in exported SVG/EPS/DXF

### 4. Composite Print Preview
- Overlay all plates with assigned colors
- Print order: auto-sorted light-to-dark (user can drag to reorder)
- Opacity slider per plate
- Toggle individual plates on/off
- "This is what your print will look like" — before cutting any wood

### 5. Plate Set Dashboard
- All plates listed: name, color swatch, print order, node count, dimensions
- Material assignment per plate (cherry, shina, MDF)
- Cut status tracking (not cut / cutting / done)
- Print order recommendation (auto light-to-dark, manual override)
- Estimated machine time per plate and total (using empirical ShopBot scale factors)

### 6. Paper Support Island Detection
- Analyze each plate for large unsupported (carved) areas
- Highlight areas where paper would sag during hand printing
- Suggest support island positions (small raised dots/bars in carved areas)
- User can accept/reject/move suggestions
- Support islands added to exported geometry

### 7. Test Cut Extraction
- Auto-select representative region from each plate (finest detail, tightest curves)
- Generate single test-cut file containing patches from all plates
- Sized to fit on a small scrap piece
- User can adjust test region location and size

## Architecture

### 100% Client-Side
No backend changes. All processing in browser:
- **Maker.js** — SVG/DXF/EPS parsing and export, geometry operations
- **clipper2-ts** — polygon analysis (area calculation for support islands, path validation)
- **JSZip** — ZIP import (from color-separator) and export

### Entry Points
1. **Direct:** upload ZIP or SVGs at `/cnc`
2. **From main page:** "Prepare for CNC →" button, plates passed via sessionStorage

### Layout
Same sidebar + canvas pattern as main page. Square slider thumbs, AUTHENTICSans font.

**Sidebar:** source upload, print size (mm/in), kento settings, tool presets (for time estimate), plate list with drag reorder, export buttons (SVG/EPS/DXF/ZIP)

**Canvas:** composite preview OR individual plate view with kento marks, support islands, dimensions overlaid. Toggle between composite and per-plate view.

### Files
```
src/app/cnc/page.tsx           — page component
src/app/cnc/cnc.css            — styles matching main site
src/hooks/useCncProcessor.ts   — state management
src/components/CncNavPanel.tsx  — sidebar
src/components/PlatePreview.tsx — composite + per-plate canvas
src/lib/cnc-engine.ts          — SVG processing, kento gen, support islands
src/lib/cnc-types.ts           — types
src/lib/cnc-export.ts          — SVG/EPS/DXF export with mm dimensions
```

### npm dependencies
```
makerjs
clipper2-ts
```

## E2E Tests (browser-only, no curl)

**Test 1:** Upload 2-plate ZIP, set size 200×300mm, process, verify kento marks appear, download cleaned SVG ZIP, intercept blob, verify SVGs have `width="200mm"` and kento paths present.

**Test 2:** Upload 4-plate ZIP, verify composite preview shows 4 colored layers, drag to reorder, verify order changes in preview.

**Test 3:** Navigate from main page "Prepare for CNC →", verify plates auto-load with colors.

**Loop until all 3 pass from browser.**

## Not In Scope (v1)
- G-code generation (VCarve does this)
- Tool radius compensation (VCarve does this)
- Toolpath generation (VCarve does this)
- 3D relief preview (VCarve does this)
- Adaptive milling (VCarve doesn't do this either, but out of scope)
- Gradient/bokashi depth maps (future v2)
