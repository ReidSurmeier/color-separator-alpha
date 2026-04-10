# CNC Post-Processing Page — Design Spec

**Date:** 2026-04-10
**Route:** `color.reidsurmeier.wtf/cnc`
**Purpose:** Take SVG plate output from color-separator and prepare it for CNC machining on ShopBot, preserving maximum detail while ensuring machinability.

## Philosophy

**Preserve everything that's machinable. Only modify what's physically impossible to cut.** This is not a simplifier — it's a machinability enforcer. The potrace SVGs have high-quality bezier curves that should be kept. The tool only intervenes where geometry violates the physical constraints of the selected cutting tool.

## User's Tool Set

| Tool | Type | Diameter | Min Internal Feature | Inside Corner Radius | Use Case |
|------|------|----------|---------------------|---------------------|----------|
| 1/8" end mill (upcut) | Existing | 3.175mm | 3.2mm | 1.59mm | General cutting |
| 1/4" end mill (upcut) | Existing | 6.35mm | 6.4mm | 3.18mm | Rough clearing |
| 1/8" downcut end mill | To buy | 3.175mm | 3.2mm | 1.59mm | Detail work, clean print surface |
| 1/4" downcut end mill | To buy | 6.35mm | 6.4mm | 3.18mm | Clearing, clean print surface |
| 60° V-bit | To buy | Variable (tip ~0.2mm) | 0.3mm at surface | ~0.1mm | Fine lines, detail carving |
| 30° V-bit | To buy | Variable (tip ~0.1mm) | 0.15mm at surface | ~0.05mm | Ultra-fine detail |

V-bit effective cutting width depends on depth: `width = 2 * depth * tan(angle/2)`. At 2mm depth, 60° V-bit cuts 2.3mm wide, 30° V-bit cuts 1.07mm wide.

## Architecture

### Route: `/cnc`

New Next.js page at `src/app/cnc/page.tsx`. Standalone — works with uploaded SVGs/ZIP or plates passed from main page via sessionStorage.

### Entry Points

1. **Direct:** user navigates to `/cnc`, uploads ZIP or SVG files
2. **From main page:** after separation, "Prepare for CNC →" button stores plate SVGs in sessionStorage, navigates to `/cnc` which auto-loads them

### Layout

Left sidebar (same width, same styling as main page — square slider thumbs, monospace headers, same button styling) + right canvas area.

**Sidebar controls (top to bottom):**

```
CNC.TOOLPATH

source
[upload ZIP / SVGs] (or drag & drop)
{filename shown after upload}

tool
[1/8" end] [1/4" end] [1/8" down] [1/4" down] [60° V] [30° V]
{selected tool shows: diameter, min feature, corner radius}

relief depth 2.0 mm
[slider 0.5mm — 5.0mm]

output dimensions
{width} × {height} mm
[mm] [inches] toggle

actions
[process]
[reset]

download
[CNC SVGs] (disabled until processed)

stats (shown after processing)
{features below min size: N (removed)}
{corners radiused: N}
{micro-holes filled: N}
{open paths closed: N}
{self-intersections: N (fixed)}
{total nodes: before → after}

plates
{list of plates with color swatch + node count}
{click plate to view it}
```

**Canvas area:**

```
[before] [after] [overlay]     plate 1 of N  [← prev] [next →]

┌─────────────────────────────────────┐
│                                     │
│          SVG plate preview          │
│     (zoomable, pannable)            │
│                                     │
│  ● red markers: features removed    │
│  ● orange markers: corners radiused │
│  ● blue markers: paths repaired     │
│                                     │
└─────────────────────────────────────┘

● too small (removed)  ● radiused corner  ● repaired path
```

**Three view modes:**
- **Before:** raw potrace SVG — all original detail, problem areas highlighted with colored markers
- **After:** processed CNC-ready SVG — clean geometry
- **Overlay:** both superimposed — original in light grey, processed in black, differences highlighted in red/orange

### Backend: `/api/cnc-process`

New endpoint on existing FastAPI backend. CPU-only (no GPU needed). Does not use the heavy semaphore.

**Request:** `POST /api/cnc-process`
```
Content-Type: multipart/form-data

svg: File (SVG file)
tool_diameter_mm: float (e.g., 3.175 for 1/8")
tool_type: string ("endmill" | "vbit")
vbit_angle: float (optional, degrees — 60 or 30)
relief_depth_mm: float (e.g., 2.0)
output_width_mm: float (optional — scale SVG to physical size)
```

**Response:** `application/json`
```json
{
  "svg_before": "<svg>...</svg>",
  "svg_after": "<svg>...</svg>",
  "stats": {
    "nodes_before": 48231,
    "nodes_after": 47892,
    "features_removed": 12,
    "corners_radiused": 89,
    "micro_holes_filled": 3,
    "open_paths_closed": 1,
    "self_intersections_fixed": 0
  },
  "problems": [
    {"type": "feature_too_small", "x": 234.5, "y": 167.2, "size_mm": 1.2},
    {"type": "corner_radiused", "x": 500.1, "y": 300.4, "original_angle": 42},
    {"type": "micro_hole_filled", "x": 100.0, "y": 200.0, "diameter_mm": 0.8}
  ],
  "dimensions_mm": {"width": 300.0, "height": 400.0}
}
```

**Processing pipeline (Python, using Shapely + svgpathtools):**

1. **Parse SVG** — extract all `<path>` elements, convert to Shapely geometry
2. **Detect problems** — identify features below tool diameter, sharp internal corners, micro-holes, open paths, self-intersections. Record coordinates for each problem.
3. **Fix only what's necessary:**
   - **Features below min size:** use `buffer(-tool_radius).buffer(tool_radius)` erosion — features smaller than tool diameter disappear, everything else preserved
   - **Internal corners:** apply `buffer(-tool_radius).buffer(tool_radius)` — automatically rounds internal corners to tool radius while preserving external corners
   - **Micro-holes:** holes with area < `π * tool_radius²` are filled (tool can't physically enter)
   - **Open paths:** close with straight line segment
   - **Self-intersections:** `make_valid()` in Shapely
4. **Convert back to SVG** — Shapely geometry → SVG path data, preserving original viewBox and dimensions
5. **Set physical dimensions** — add `width="300mm" height="400mm"` attributes for CAM software import
6. **Return both before and after SVGs** + problem list + stats

**Key constraint:** the buffer erosion trick preserves all machinable detail. A 50K-node path that has no sub-tool-diameter features comes through with ~50K nodes. We only reduce nodes where geometry was physically modified. This is NOT a simplifier.

### Dependencies (Python, backend)

```
shapely>=2.0
svgpathtools>=1.6
svgelements>=1.9 (alternative SVG parser if svgpathtools insufficient)
```

These are pure Python, no GPU, lightweight. Add to `backend/requirements.txt`.

### Frontend Components

New files:
- `src/app/cnc/page.tsx` — main CNC page component
- `src/hooks/useCncProcessor.ts` — state management hook (mirrors useColorSeparator pattern)
- `src/components/CncNavPanel.tsx` — sidebar controls
- `src/components/SvgPreview.tsx` — SVG canvas with zoom/pan and problem markers
- `src/lib/cnc-api.ts` — API functions for `/api/cnc-process`

### Data Flow

```
User uploads ZIP/SVGs
  → Frontend extracts plate SVGs from ZIP (JSZip, client-side)
  → User selects tool, adjusts params
  → Clicks "process"
  → Frontend sends each plate SVG to /api/cnc-process
  → Backend returns before/after SVGs + stats + problems
  → Frontend renders preview with problem markers
  → User toggles before/after/overlay
  → User clicks "CNC SVGs" to download
  → Frontend packages processed SVGs into ZIP with dimensions in mm
```

### E2E Test Spec

Playwright through real browser at `color.reidsurmeier.wtf/cnc`:

**Test 1: Small image, 1/8" end mill**
1. Upload ZIP from a previous separation (arena_03.jpg, 2 plates)
2. Select 1/8" end mill
3. Click process
4. Verify: stats show features_removed ≥ 0, corners_radiused ≥ 0
5. Toggle before/after/overlay — verify SVG changes in DOM
6. Download CNC SVGs ZIP
7. Intercept blob, unzip, verify: 2 SVG files, each has `width="...mm"` attribute, each is valid SVG

**Test 2: Large image, 60° V-bit**
1. Upload ZIP from a previous separation (ts_extra_03.jpg, 4 plates, 2x upscale)
2. Select 60° V-bit
3. Process
4. Verify: fewer features removed than 1/8" end mill (V-bit is finer)
5. Download and verify SVG dimensions match expected mm size

**Test 3: Direct SVG upload (no ZIP)**
1. Upload a single SVG file (extracted from a previous ZIP)
2. Process with 1/4" end mill
3. Verify: more features removed (larger tool = more constraints)
4. Download single CNC-ready SVG

**Loop criterion:** all 3 tests pass from the browser. No curl. No backend access. Real user flow.

### Supply List

**CNC Bits (1/4" shank, carbide, for ShopBot):**

| Item | Brand/Model | Source | Price |
|------|-------------|--------|-------|
| 1/8" downcut end mill, 1/2" cut length | Whiteside RD2100 or Amana 46225-K | Amazon / ToolsToday | $18-25 |
| 1/4" downcut end mill, 3/4" cut length | Whiteside RD2100 or Amana 46210-K | Amazon / ToolsToday | $15-22 |
| 60° V-bit, 1/4" shank | Whiteside 1502 or Amana 45611-K | Amazon / ToolsToday | $18-28 |
| 30° V-bit, 1/4" shank | Whiteside 1500 or Amana 45600-K | Amazon / ToolsToday | $22-32 |

**Wood:**

| Item | Source | Price |
|------|--------|-------|
| Shina plywood 12mm, 12"×18" sheets (prototyping) | McClain's Printmaking / Blick Art | $10-15/sheet |
| Cherry board 3/4" thick, S2S, kiln-dried | Local hardwood dealer or Woodcraft | $8-14/board foot |

**Printmaking Supplies:**

| Item | Source | Price |
|------|--------|-------|
| Bamboo baren (8cm) | McClain's Printmaking / Baren Mall | $35-50 |
| Hosho paper (10 sheets, printmaking grade) | McClain's / Blick Art | $15-25 |
| Akua Intaglio ink (black, 8oz) | Blick Art / Dick Blick | $12-18 |
| Sumi ink stick + suzuri (grinding stone) | McClain's / Japan Woodworker | $20-40 |

**Laser Stamp Supplies:**

| Item | Source | Price |
|------|--------|-------|
| Laser stamp rubber sheets 2.3mm, A4 (5 pack) | Trotec / Amazon | $20-35 |
| Adhesive mounting foam 3mm (A4 sheets) | Amazon | $8-12 |

## Not In Scope (v1)

- G-code generation (user imports SVGs into VCarve/ShopBot software)
- 3D relief preview
- Multi-tool toolpath planning (e.g., rough with 1/4" + finish with 1/8")
- Registration mark (kento) generation
- Print color assignment (the SVGs are already separated)
- Feeds and speeds calculator
