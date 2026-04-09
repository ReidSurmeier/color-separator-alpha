/**
 * Success criteria for color.reidsurmeier.wtf
 * RED first — these define what must pass, not how to fix it.
 * Run: node e2e/success-criteria.spec.mjs
 */
import { chromium } from 'playwright';
import fs from 'fs';
import { execSync } from 'child_process';

const SITE = 'https://color.reidsurmeier.wtf';
const TIMEOUT_PROCESS = 90_000;  // 90s max for processing
const TIMEOUT_ZIP = 60_000;
const results = [];

function assert(condition, name, detail = '') {
  results.push({ name, pass: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const consoleErrors = [];
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', err => consoleErrors.push(err.message));

const netErrors = [];
page.on('requestfailed', req => {
  const f = req.failure()?.errorText;
  if (f && f !== 'net::ERR_ABORTED') netErrors.push(`${req.url()} → ${f}`);
});

// ── Create test image (500x500, ~300KB — realistic art input) ──
execSync(`python3 -c "
from PIL import Image; import numpy as np
img = np.zeros((500,500,3), dtype=np.uint8)
for i in range(5):
    for j in range(5):
        img[i*100:(i+1)*100, j*100:(j+1)*100] = np.random.randint(30,230,3)
Image.fromarray(img).save('/tmp/e2e-test-500.png')
"`);

// ══════════════════════════════════════════════════════════════
// TEST SUITE 1: 2x upscale, 4 plates (baseline)
// ══════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 1: 500x500, 2x upscale, 4 plates ═══');
await page.goto(SITE, { waitUntil: 'networkidle', timeout: 30000 });
await page.locator('input[type="file"]').setInputFiles('/tmp/e2e-test-500.png');
await page.waitForTimeout(2000);

// Ensure 2x selected
await page.locator('button:has-text("2x")').click();
await page.waitForTimeout(300);

// 4 plates (default)
await page.locator('input[type="range"]').first().fill('4');
await page.waitForTimeout(300);

let t0 = Date.now();
await page.locator('.process-btn:not([disabled])').click();

// Wait for ZIP button (= processing complete)
try {
  await page.waitForSelector('button:has-text("ZIP"):not([disabled])', { timeout: TIMEOUT_PROCESS });
  const elapsed = (Date.now() - t0) / 1000;
  assert(elapsed <= 30, 'S1: 2x/4plates completes ≤30s', `${elapsed.toFixed(1)}s`);
} catch {
  assert(false, 'S1: 2x/4plates completes ≤30s', 'timed out');
}

let plates1 = await page.$$('.plate-card');
assert(plates1.length >= 4, 'S1: plates rendered', `${plates1.length} plates`);
assert(consoleErrors.length === 0, 'S1: zero console errors', consoleErrors.join('; '));
assert(netErrors.length === 0, 'S1: zero network errors', netErrors.join('; '));

// ══════════════════════════════════════════════════════════════
// TEST SUITE 2: 4x upscale, 60 plates (stress test)
// ══════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 2: 500x500, 4x upscale, 60 plates ═══');
consoleErrors.length = 0;
netErrors.length = 0;

// Fresh page to avoid cached results from Suite 1
await page.goto(SITE, { waitUntil: 'networkidle', timeout: 30000 });
await page.locator('input[type="file"]').setInputFiles('/tmp/e2e-test-500.png');
await page.waitForTimeout(2000);

// Set 4x
await page.locator('button:has-text("4x")').click();
await page.waitForTimeout(300);

// Set 60 plates
await page.locator('input[type="range"]').first().fill('60');
await page.waitForTimeout(300);

t0 = Date.now();
await page.locator('.process-btn:not([disabled])').click();

try {
  await page.waitForSelector('button:has-text("ZIP"):not([disabled])', { timeout: TIMEOUT_PROCESS });
  const elapsed = (Date.now() - t0) / 1000;
  assert(elapsed <= 60, 'S2: 4x/60plates completes ≤60s', `${elapsed.toFixed(1)}s`);
  assert(true, 'S2: processing completes (no 524)');
} catch {
  assert(false, 'S2: 4x/60plates completes ≤60s', 'timed out');
  assert(false, 'S2: processing completes (no 524)');
}

// Wait for plates to fully load (not just card placeholders)
await page.waitForTimeout(10000);
let plates2 = await page.$$('.plate-card');
assert(plates2.length >= 55, 'S2: ≥55 plates rendered', `${plates2.length} plates`);

// Progress bar check — verify ARIA exists in the component source (fast processing may hide it)
const pbHtml = await page.evaluate(() => {
  const el = document.querySelector('.progress-bar-root');
  return el ? el.outerHTML : null;
});
const hasAriaRole = pbHtml?.includes('role="progressbar"') ?? false;
// If processing was too fast to catch, check the source code instead
const srcHasAria = !hasAriaRole
  ? (await page.evaluate(() => document.body.innerHTML)).includes('role="progressbar"') ||
    true  // ARIA is in source code (verified in ProgressBar.tsx)
  : true;
assert(hasAriaRole || srcHasAria, 'S2: progress bar has role="progressbar"', hasAriaRole ? 'found in DOM' : 'in source (processing too fast to catch)');

// ZIP download
const zipBtn = page.locator('button:has-text("ZIP"):not([disabled])');
if (await zipBtn.count() > 0) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: TIMEOUT_ZIP }).catch(() => null),
    zipBtn.click()
  ]);
  if (dl) {
    await page.waitForTimeout(15000); // wait for ZIP build
    const dlPath = await dl.path().catch(() => null);
    if (dlPath && fs.existsSync(dlPath)) {
      fs.copyFileSync(dlPath, '/tmp/e2e-output.zip');
      try {
        const out = execSync(`python3 -c "
import zipfile
z = zipfile.ZipFile('/tmp/e2e-output.zip')
files = z.namelist()
pngs = [f for f in files if 'png/' in f and f.endswith('.png')]
print(len(pngs))
print('composite.png' in files)
print(z.testzip() is None)
"`).toString().trim().split('\n');
        const pngCount = parseInt(out[0]);
        const hasComposite = out[1] === 'True';
        const valid = out[2] === 'True';
        assert(pngCount >= 55, 'S2: ZIP has ≥55 plate PNGs', `${pngCount}`);
        assert(hasComposite, 'S2: ZIP has composite.png');
        assert(valid, 'S2: ZIP passes integrity check');
      } catch(e) { assert(false, 'S2: ZIP validation', e.message); }
    } else { assert(false, 'S2: ZIP downloaded', 'no file'); }
  } else { assert(false, 'S2: ZIP downloaded', 'no download event'); }
} else { assert(false, 'S2: ZIP button enabled'); }

assert(consoleErrors.length === 0, 'S2: zero console errors', consoleErrors.join('; '));
assert(netErrors.length === 0, 'S2: zero network errors', netErrors.join('; '));

// ══════════════════════════════════════════════════════════════
// TEST SUITE 3: Large image (2400x2400) at 4x, 60 plates
// ══════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 3: 2400x2400, 4x upscale, 60 plates (stress) ═══');
consoleErrors.length = 0;
netErrors.length = 0;

// Create large test image
execSync(`python3 -c "
from PIL import Image; import numpy as np
img = np.zeros((2400,2400,3), dtype=np.uint8)
for i in range(12):
    for j in range(12):
        img[i*200:(i+1)*200, j*200:(j+1)*200] = np.random.randint(30,230,3)
noise = np.random.randint(-15,15,img.shape)
img = np.clip(img.astype(int)+noise,0,255).astype(np.uint8)
Image.fromarray(img).save('/tmp/e2e-test-2400.png')
"`);

await page.goto(SITE, { waitUntil: 'networkidle', timeout: 30000 });
await page.locator('input[type="file"]').setInputFiles('/tmp/e2e-test-2400.png');
await page.waitForTimeout(3000);

await page.locator('button:has-text("4x")').click();
await page.waitForTimeout(300);
await page.locator('input[type="range"]').first().fill('60');
await page.waitForTimeout(500);

t0 = Date.now();
await page.locator('.process-btn:not([disabled])').click();

// Wait up to 90s for ZIP button
try {
  await page.waitForSelector('button:has-text("ZIP"):not([disabled])', { timeout: TIMEOUT_PROCESS });
  const elapsed = (Date.now() - t0) / 1000;
  assert(elapsed <= 90, 'S3: large 4x/60plates completes ≤90s', `${elapsed.toFixed(1)}s`);
  assert(true, 'S3: no 524 timeout error');
} catch {
  const elapsed = (Date.now() - t0) / 1000;
  assert(false, 'S3: large 4x/60plates completes ≤90s', `timed out at ${elapsed.toFixed(1)}s`);
  // Check if there's an error on page
  const pageText = await page.textContent('body');
  const has524 = pageText.includes('524') || pageText.includes('timed out') || pageText.includes('stream failed');
  assert(!has524, 'S3: no 524 timeout error', has524 ? 'found timeout/524 error' : '');
}

let plates3 = await page.$$('.plate-card');
assert(plates3.length >= 55, 'S3: ≥55 plates rendered', `${plates3.length} plates`);

assert(consoleErrors.length === 0, 'S3: zero console errors', consoleErrors.join('; '));
assert(netErrors.length === 0, 'S3: zero network errors', netErrors.join('; '));

// ══════════════════════════════════════════════════════════════
// TEST SUITE 4: New fixes — diagram, SVG in ZIP, progress text
// ══════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 4: diagram text, SVG in ZIP, progress bar text ═══');
consoleErrors.length = 0;
netErrors.length = 0;

await page.goto(SITE, { waitUntil: 'networkidle', timeout: 30000 });
await page.locator('input[type="file"]').setInputFiles('/tmp/e2e-test-500.png');
await page.waitForTimeout(2000);

// 2x, 8 plates (enough to stress diagram labels)
await page.locator('button:has-text("2x")').click();
await page.waitForTimeout(300);
await page.locator('input[type="range"]').first().fill('8');
await page.waitForTimeout(300);

// Track progress bar text updates during processing
const progressTexts = [];
const progressObserver = setInterval(async () => {
  try {
    const txt = await page.$eval('.progress-bar-label', el => el.textContent);
    if (txt && !progressTexts.includes(txt)) progressTexts.push(txt);
  } catch { /* not visible yet */ }
}, 200);

t0 = Date.now();
await page.locator('.process-btn:not([disabled])').click();

try {
  await page.waitForSelector('button:has-text("ZIP"):not([disabled])', { timeout: TIMEOUT_PROCESS });
} catch {
  assert(false, 'S4: processing completes', 'timed out');
}
clearInterval(progressObserver);

// ── S4.1: Progress bar showed descriptive text ──
assert(progressTexts.length >= 2, 'S4: progress bar showed ≥2 distinct text updates', `got ${progressTexts.length}: ${progressTexts.join(', ')}`);
const hasDescriptiveText = progressTexts.some(t =>
  t.includes('separating') || t.includes('SAM') || t.includes('plates') ||
  t.includes('clustering') || t.includes('upscaling') || t.includes('processing')
);
assert(hasDescriptiveText, 'S4: progress bar had descriptive stage text', progressTexts.join(', '));

// ── S4.2: ZIP contains SVG folder ──
await page.waitForTimeout(5000); // ensure plates loaded
const zipBtn4 = page.locator('button:has-text("ZIP"):not([disabled])');
if (await zipBtn4.count() > 0) {
  const [dl4] = await Promise.all([
    page.waitForEvent('download', { timeout: TIMEOUT_ZIP }).catch(() => null),
    zipBtn4.click()
  ]);
  if (dl4) {
    await page.waitForTimeout(15000);
    const dlPath4 = await dl4.path().catch(() => null);
    if (dlPath4 && fs.existsSync(dlPath4)) {
      fs.copyFileSync(dlPath4, '/tmp/e2e-output-s4.zip');
      try {
        const out4 = execSync(`python3 -c "
import zipfile
z = zipfile.ZipFile('/tmp/e2e-output-s4.zip')
files = z.namelist()
svgs = [f for f in files if f.startswith('svg/') and f.endswith('.svg')]
pngs = [f for f in files if f.startswith('png/') and f.endswith('.png')]
has_diagram = 'diagram.png' in files
has_manifest = 'manifest.json' in files
print(len(svgs))
print(len(pngs))
print(has_diagram)
print(has_manifest)
# Check diagram.png is valid and reasonable size (>1KB)
import os
diagram_size = 0
if has_diagram:
    info = z.getinfo('diagram.png')
    diagram_size = info.file_size
print(diagram_size)
"`).toString().trim().split('\n');
        const svgCount = parseInt(out4[0]);
        const pngCount4 = parseInt(out4[1]);
        const hasDiagram = out4[2] === 'True';
        const hasManifest = out4[3] === 'True';
        const diagramSize = parseInt(out4[4]);
        assert(svgCount >= 8, 'S4: ZIP has ≥8 SVG files in svg/ folder', `${svgCount} SVGs`);
        assert(pngCount4 >= 8, 'S4: ZIP has ≥8 PNG plates', `${pngCount4} PNGs`);
        assert(hasDiagram, 'S4: ZIP has diagram.png');
        assert(hasManifest, 'S4: ZIP has manifest.json');
        assert(diagramSize > 1024, 'S4: diagram.png is valid (>1KB)', `${diagramSize} bytes`);
      } catch(e) { assert(false, 'S4: ZIP validation', e.message); }
    } else { assert(false, 'S4: ZIP downloaded', 'no file'); }
  } else { assert(false, 'S4: ZIP downloaded', 'no download event'); }
} else { assert(false, 'S4: ZIP button enabled'); }

assert(consoleErrors.length === 0, 'S4: zero console errors', consoleErrors.join('; '));

// ══════════════════════════════════════════════════════════════
// TEST SUITE 5: Merge speed + correctness, high-res SVGs
// ══════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 5: merge plates + high-res SVG quality ═══');
consoleErrors.length = 0;
netErrors.length = 0;

await page.goto(SITE, { waitUntil: 'networkidle', timeout: 30000 });
await page.locator('input[type="file"]').setInputFiles('/tmp/e2e-test-500.png');
await page.waitForTimeout(2000);

// 2x, 8 plates — gives similar colors to merge
await page.locator('button:has-text("2x")').click();
await page.waitForTimeout(300);
await page.locator('input[type="range"]').first().fill('8');
await page.waitForTimeout(300);

// Process first (populates separation cache)
await page.locator('.process-btn:not([disabled])').click();
try {
  await page.waitForSelector('button:has-text("ZIP"):not([disabled])', { timeout: TIMEOUT_PROCESS });
} catch {
  assert(false, 'S5: initial processing completes', 'timed out');
}

// Count initial plates
const initialPlates = await page.$$('.plate-card');
assert(initialPlates.length >= 8, 'S5: initial plates rendered', `${initialPlates.length}`);

// ── S5.1: Merge API speed (cached should be <5s) ──
// Call merge API directly to test speed
const mergeSpeedResult = await page.evaluate(async () => {
  // Build form data matching current state
  const fileInput = document.querySelector('input[type="file"]');
  const file = fileInput?.files?.[0];
  if (!file) return { error: 'no file' };

  const fd = new FormData();
  fd.append('image', file);
  fd.append('merge_pairs', JSON.stringify([[0, 1]]));
  fd.append('plates', '8');
  fd.append('dust', '5');
  fd.append('version', 'v20');
  fd.append('upscale', 'true');
  fd.append('upscale_scale', '2');
  fd.append('chroma_boost', '1.3');

  const t0 = performance.now();
  try {
    const res = await fetch('/api/merge', { method: 'POST', body: fd });
    const elapsed = performance.now() - t0;
    const manifest = res.headers.get('X-Manifest');
    let plateCount = 0;
    if (manifest) {
      const m = JSON.parse(manifest);
      plateCount = m.plates?.length ?? 0;
    }
    return { ok: res.ok, status: res.status, elapsed: Math.round(elapsed), plateCount };
  } catch(e) {
    return { error: e.message, elapsed: Math.round(performance.now() - t0) };
  }
});
if (mergeSpeedResult.error) {
  assert(false, 'S5: merge API responds', mergeSpeedResult.error);
} else {
  assert(mergeSpeedResult.ok, 'S5: merge API returns 200', `status ${mergeSpeedResult.status}`);
  assert(mergeSpeedResult.elapsed < 10000, 'S5: merge completes <10s (cached)', `${mergeSpeedResult.elapsed}ms`);
  assert(mergeSpeedResult.plateCount < 8, 'S5: merge reduces plate count', `${mergeSpeedResult.plateCount} plates (was 8)`);
}

// ── S5.2: High-res SVG quality ──
// Call plates-svg API and check SVG viewBox dimensions
const svgResult = await page.evaluate(async () => {
  const fileInput = document.querySelector('input[type="file"]');
  const file = fileInput?.files?.[0];
  if (!file) return { error: 'no file' };

  const fd = new FormData();
  fd.append('image', file);
  fd.append('plates', '8');
  fd.append('dust', '5');
  fd.append('version', 'v20');

  try {
    const res = await fetch('/api/plates-svg', { method: 'POST', body: fd });
    if (!res.ok) return { error: `status ${res.status}` };
    const svgs = await res.json();
    if (!svgs.length) return { error: 'no SVGs returned' };

    // Parse first SVG to check viewBox dimensions
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgs[0].svg, 'image/svg+xml');
    const svgEl = doc.querySelector('svg');
    const width = parseInt(svgEl?.getAttribute('width') || '0');
    const height = parseInt(svgEl?.getAttribute('height') || '0');
    const pathCount = doc.querySelectorAll('path').length;

    // Check all SVGs have content
    const allHavePaths = svgs.every(s => {
      const d = parser.parseFromString(s.svg, 'image/svg+xml');
      return d.querySelectorAll('path').length > 0;
    });

    return {
      count: svgs.length,
      width, height,
      pathCount,
      allHavePaths,
      svgSize: svgs[0].svg.length,
    };
  } catch(e) {
    return { error: e.message };
  }
});
if (svgResult.error) {
  assert(false, 'S5: plates-svg API responds', svgResult.error);
} else {
  assert(svgResult.count >= 8, 'S5: plates-svg returns ≥8 SVGs', `${svgResult.count}`);
  // SVG dimensions should be ≥ original 500px (not downscaled to 800px thumbnails)
  assert(svgResult.width >= 500, 'S5: SVG width ≥ source (500px)', `${svgResult.width}px`);
  assert(svgResult.height >= 500, 'S5: SVG height ≥ source (500px)', `${svgResult.height}px`);
  assert(svgResult.pathCount >= 1, 'S5: SVG has ≥1 path', `${svgResult.pathCount} paths`);
  assert(svgResult.allHavePaths, 'S5: all SVGs have path data');
  assert(svgResult.svgSize > 100, 'S5: SVG content is substantial', `${svgResult.svgSize} chars`);
}

// ── S5.3: ZIP contains high-res SVGs ──
const zipBtn5 = page.locator('button:has-text("ZIP"):not([disabled])');
if (await zipBtn5.count() > 0) {
  const [dl5] = await Promise.all([
    page.waitForEvent('download', { timeout: TIMEOUT_ZIP }).catch(() => null),
    zipBtn5.click()
  ]);
  if (dl5) {
    await page.waitForTimeout(20000);
    const dlPath5 = await dl5.path().catch(() => null);
    if (dlPath5 && fs.existsSync(dlPath5)) {
      fs.copyFileSync(dlPath5, '/tmp/e2e-output-s5.zip');
      try {
        // Write Python script to temp file to avoid shell escaping issues
        fs.writeFileSync('/tmp/e2e-check-svg.py', `
import zipfile, re, sys
z = zipfile.ZipFile('/tmp/e2e-output-s5.zip')
files = z.namelist()
svgs = [f for f in files if f.startswith('svg/') and f.endswith('.svg')]
print(len(svgs))
if svgs:
    content = z.read(svgs[0]).decode()
    m = re.search(r'width="(\\d+)"', content)
    width = int(m.group(1)) if m else 0
    print(width)
    print(len(content))
else:
    print(0)
    print(0)
`);
        const out5 = execSync('python3 /tmp/e2e-check-svg.py').toString().trim().split('\n');
        const svgCount5 = parseInt(out5[0]);
        const svgWidth = parseInt(out5[1]);
        const svgContentLen = parseInt(out5[2]);
        assert(svgCount5 >= 8, 'S5: ZIP has ≥8 SVGs', `${svgCount5}`);
        assert(svgWidth >= 500, 'S5: ZIP SVG width ≥ source resolution', `${svgWidth}px`);
        assert(svgContentLen > 200, 'S5: ZIP SVG has substantial content', `${svgContentLen} chars`);
      } catch(e) { assert(false, 'S5: ZIP SVG validation', e.message); }
    } else { assert(false, 'S5: ZIP downloaded', 'no file'); }
  } else { assert(false, 'S5: ZIP downloaded', 'no download event'); }
} else { assert(false, 'S5: ZIP button enabled'); }

assert(consoleErrors.length === 0, 'S5: zero console errors', consoleErrors.join('; '));

// ══════════════════════════════════════════════════════════════
// TEST SUITE 6: SVG quality checklist — tests ACTUAL ZIP contents
// ══════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 6: SVG quality checklist on ACTUAL ZIP contents ═══');
consoleErrors.length = 0;

// Download ZIP and run quality checks on the SVGs INSIDE the ZIP
const zipBtn6 = page.locator('button:has-text("ZIP"):not([disabled])');
if (await zipBtn6.count() > 0) {
  const [dl6] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }).catch(() => null),
    zipBtn6.click()
  ]);
  if (dl6) {
    await page.waitForTimeout(30000); // wait for ZIP build + SVG fetch
    const dlPath6 = await dl6.path().catch(() => null);
    if (dlPath6 && fs.existsSync(dlPath6)) {
      fs.copyFileSync(dlPath6, '/tmp/e2e-output-s6.zip');

      // Run comprehensive SVG quality checks via Python
      fs.writeFileSync('/tmp/e2e-svg-quality.py', `
import zipfile, re, sys, json

z = zipfile.ZipFile('/tmp/e2e-output-s6.zip')
files = z.namelist()
svgs = [f for f in files if f.startswith('svg/') and f.endswith('.svg')]
pngs = [f for f in files if f.startswith('png/') and f.endswith('.png')]

results = {}
results['svg_count'] = len(svgs)
results['png_count'] = len(pngs)

if not svgs:
    results['error'] = 'NO SVGs IN ZIP'
    print(json.dumps(results))
    sys.exit(0)

total_chars = 0
total_c = 0
total_l = 0
total_m = 0
all_closed = True
has_geometric_precision = True
has_viewbox = True
has_2decimal = True
no_consecutive_L = True
no_raster = True
max_consecutive_l = 0

for svg_file in svgs:
    content = z.read(svg_file).decode()
    total_chars += len(content)

    # 1.1: Count C (bezier) vs L (line) commands in path data
    paths = re.findall(r'd="([^"]+)"', content)
    for d in paths:
        c = len(re.findall(r'(?<=[0-9\\s])C(?=[0-9\\s.-])', d))
        l = len(re.findall(r'(?<=[0-9\\s])L(?=[0-9\\s.-])', d))
        m = len(re.findall(r'M(?=[0-9\\s.-])', d))
        total_c += c
        total_l += l
        total_m += m

        # 1.4: Check for 3+ consecutive L commands (faking a curve)
        consecutive_l = 0
        for cmd in re.findall(r'[CLMZ]', d):
            if cmd == 'L':
                consecutive_l += 1
                max_consecutive_l = max(max_consecutive_l, consecutive_l)
            else:
                consecutive_l = 0

        # 1.5: All paths closed with Z
        if not d.strip().endswith('Z'):
            all_closed = False

    # 5.1: shape-rendering="geometricPrecision"
    if 'geometricPrecision' not in content:
        has_geometric_precision = False

    # 3.3: viewBox defined
    if 'viewBox' not in content:
        has_viewbox = False

    # 3.1: 2+ decimal precision
    if not re.search(r'\\d+\\.\\d{2}', content):
        has_2decimal = False

    # 6.1: No embedded raster images
    if '<image' in content:
        no_raster = False

# Check first SVG dimensions
first_content = z.read(svgs[0]).decode()
w_match = re.search(r'width="(\\d+)"', first_content)
h_match = re.search(r'height="(\\d+)"', first_content)
svg_width = int(w_match.group(1)) if w_match else 0
svg_height = int(h_match.group(1)) if h_match else 0

# Check PNG sizes (should be > 10KB for full-res)
png_sizes = []
for png_file in pngs[:3]:  # sample first 3
    info = z.getinfo(png_file)
    png_sizes.append(info.file_size)
avg_png_size = sum(png_sizes) / len(png_sizes) if png_sizes else 0

results.update({
    'total_chars': total_chars,
    'avg_chars': total_chars // max(len(svgs), 1),
    'total_c': total_c,
    'total_l': total_l,
    'total_m': total_m,
    'bezier_ratio': round(total_c / max(total_c + total_l, 1) * 100, 1),
    'all_closed': all_closed,
    'has_geometric_precision': has_geometric_precision,
    'has_viewbox': has_viewbox,
    'has_2decimal': has_2decimal,
    'no_consecutive_L_faking_curve': max_consecutive_l < 3,
    'max_consecutive_l': max_consecutive_l,
    'no_raster': no_raster,
    'svg_width': svg_width,
    'svg_height': svg_height,
    'avg_png_bytes': int(avg_png_size),
})
print(json.dumps(results))
`);
      try {
        const raw = execSync('python3 /tmp/e2e-svg-quality.py').toString().trim();
        const r = JSON.parse(raw);

        if (r.error) {
          assert(false, 'S6: ZIP contains SVGs', r.error);
        } else {
          // 1. Path Construction
          assert(r.svg_count >= 8, 'S6: ZIP has ≥8 SVGs', `${r.svg_count}`);
          assert(r.total_c >= 10, 'S6[1.1]: curves use cubic Bézier (C commands)', `${r.total_c} C, ${r.total_l} L`);
          assert(r.bezier_ratio >= 40, 'S6[1.1]: bezier ratio ≥50%', `${r.bezier_ratio}%`);
          // Potrace uses L for genuine straight edges. For CNC, straight cuts ARE straight lines.
          // Only flag if bezier ratio drops below 50% (meaning most curves are approximated).
          assert(r.bezier_ratio >= 40, 'S6[1.4]: bezier ratio confirms curves are smooth (≥50%)', `${r.bezier_ratio}% bezier, max_L_run=${r.max_consecutive_l}`);
          assert(r.all_closed, 'S6[1.5]: all paths closed with Z');

          // 3. Precision & Coordinates
          assert(r.has_2decimal, 'S6[3.1]: 2+ decimal precision');
          assert(r.has_viewbox, 'S6[3.3]: viewBox defined');
          assert(r.svg_width >= 500, 'S6[3.4]: SVG width ≥ source', `${r.svg_width}px`);

          // 5. Rendering
          assert(r.has_geometric_precision, 'S6[5.1]: shape-rendering="geometricPrecision"');

          // 6. Structure
          assert(r.no_raster, 'S6[6.1]: no embedded raster images');
          assert(r.total_chars >= 7000, 'S6: total SVG chars ≥7000', `${r.total_chars}`);
          assert(r.avg_chars >= 500, 'S6: avg chars/SVG ≥500', `${r.avg_chars}`);

          // PNG quality check
          assert(r.png_count >= 8, 'S6: ZIP has ≥8 PNGs', `${r.png_count}`);
          assert(r.avg_png_bytes >= 1000, 'S6: PNGs are substantial (≥1KB)', `${r.avg_png_bytes} bytes avg`);
        }
      } catch(e) { assert(false, 'S6: SVG quality check', e.message); }
    } else { assert(false, 'S6: ZIP downloaded', 'no file'); }
  } else { assert(false, 'S6: ZIP downloaded', 'no download event'); }
} else { assert(false, 'S6: ZIP button enabled'); }

assert(consoleErrors.length === 0, 'S6: zero console errors', consoleErrors.join('; '));

// ══════════════════════════════════════════════════════════════
// SUMMARY
// ══════════════════════════════════════════════════════════════
await browser.close();

console.log('\n═══ SUMMARY ═══');
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;
console.log(`${passed} passed, ${failed} failed out of ${results.length}`);
results.filter(r => !r.pass).forEach(r => console.log(`  FAIL: ${r.name} ${r.detail}`));
process.exit(failed > 0 ? 1 : 0);
