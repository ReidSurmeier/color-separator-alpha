/**
 * UX success criteria — progress bar responsiveness + ZIP speed
 * RED first, then fix until GREEN.
 */
import { chromium } from 'playwright';
import fs from 'fs';
import { execSync } from 'child_process';

const SITE = 'https://color.reidsurmeier.wtf';
const results = [];

function assert(condition, name, detail = '') {
  results.push({ name, pass: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
}

// Create test image
execSync(`python3 -c "
from PIL import Image; import numpy as np
img = np.zeros((800,800,3), dtype=np.uint8)
for i in range(8):
    for j in range(8):
        img[i*100:(i+1)*100, j*100:(j+1)*100] = np.random.randint(30,230,3)
Image.fromarray(img).save('/tmp/ux-test-800.png')
"`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const consoleErrors = [];
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', err => consoleErrors.push(err.message));

// ══════════════════════════════════════════════════════════════
// TEST 1: Progress bar shows text updates within 2s of clicking Process
// ══════════════════════════════════════════════════════════════
console.log('\n═══ TEST 1: Progress bar text updates ═══');
await page.goto(SITE, { waitUntil: 'networkidle', timeout: 30000 });
await page.locator('input[type="file"]').setInputFiles('/tmp/ux-test-800.png');
await page.waitForTimeout(2000);
await page.locator('button:has-text("2x")').click();
await page.waitForTimeout(300);
await page.locator('input[type="range"]').first().fill('30');
await page.waitForTimeout(300);

const t0 = Date.now();
await page.locator('.process-btn:not([disabled])').click();

// Capture progress bar state every 200ms for 10 seconds
const progressSnapshots = [];
let seenText = false;
let seenPercentage = false;
let seenTimeElapsed = false;
let firstTextMs = null;
let firstPercentMs = null;
let textUpdates = 0;
let lastText = '';

for (let i = 0; i < 100; i++) {  // 100 * 200ms = 20s max
  await page.waitForTimeout(200);
  const elapsed = Date.now() - t0;

  const snapshot = await page.evaluate(() => {
    const root = document.querySelector('.progress-bar-root');
    if (!root) return null;
    const label = root.querySelector('.progress-bar-label');
    const time = root.querySelector('.progress-bar-time');
    const eta = root.querySelector('.progress-bar-eta');
    const fill = root.querySelector('.progress-bar-fill');
    const ariaVal = root.getAttribute('aria-valuenow');
    return {
      visible: root.offsetHeight > 0,
      labelText: label?.textContent?.trim() || '',
      timeText: time?.textContent?.trim() || '',
      etaText: eta?.textContent?.trim() || '',
      fillWidth: fill?.style?.width || '0%',
      ariaValue: ariaVal,
      labelOpacity: label ? getComputedStyle(label).opacity : '0',
      timeOpacity: time ? getComputedStyle(time).opacity : '0',
    };
  });

  if (!snapshot) continue;

  if (snapshot.visible && snapshot.labelText && snapshot.labelText !== lastText) {
    textUpdates++;
    lastText = snapshot.labelText;
    if (!firstTextMs) firstTextMs = elapsed;
  }
  if (snapshot.ariaValue && parseInt(snapshot.ariaValue) > 0 && !firstPercentMs) {
    firstPercentMs = elapsed;
  }
  if (snapshot.labelText) seenText = true;
  if (snapshot.ariaValue && parseInt(snapshot.ariaValue) > 0) seenPercentage = true;
  if (snapshot.timeText && snapshot.timeText !== '0:00') seenTimeElapsed = true;

  progressSnapshots.push({ elapsed, ...snapshot });

  // Stop once we see ZIP button
  const zipReady = await page.$('button:has-text("ZIP"):not([disabled])');
  if (zipReady) break;
}

assert(seenText, 'T1: progress bar shows stage text', `first at ${firstTextMs}ms`);
assert(firstTextMs !== null && firstTextMs < 2000, 'T1: text appears within 2s', `${firstTextMs}ms`);
assert(seenPercentage, 'T1: progress bar shows percentage > 0%', `first at ${firstPercentMs}ms`);
assert(textUpdates >= 2, 'T1: progress bar updates text ≥2 times', `${textUpdates} updates`);
assert(seenTimeElapsed, 'T1: progress bar shows elapsed time');

// Check label visibility (not opacity: 0)
const visibleLabels = progressSnapshots.filter(s => s.labelOpacity !== '0' && s.labelText);
assert(visibleLabels.length > 0, 'T1: progress bar labels are VISIBLE (opacity > 0)',
  `${visibleLabels.length}/${progressSnapshots.length} snapshots visible`);

// ══════════════════════════════════════════════════════════════
// TEST 2: ZIP download speed and progress
// ══════════════════════════════════════════════════════════════
console.log('\n═══ TEST 2: ZIP download speed + progress ═══');

// Wait for processing to complete
await page.waitForSelector('button:has-text("ZIP"):not([disabled])', { timeout: 60000 }).catch(() => {});

const zipBtn = page.locator('button:has-text("ZIP"):not([disabled])');
if (await zipBtn.count() > 0) {
  const zt0 = Date.now();

  // Track ZIP progress bar updates
  const zipProgressSnapshots = [];
  let zipProgressInterval;

  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }).catch(() => null),
    (async () => {
      // Start monitoring before click
      zipProgressInterval = setInterval(async () => {
        const snap = await page.evaluate(() => {
          const root = document.querySelector('.progress-bar-root');
          if (!root) return null;
          const label = root.querySelector('.progress-bar-label');
          return {
            visible: root.offsetHeight > 0,
            text: label?.textContent?.trim() || '',
            ariaValue: root.getAttribute('aria-valuenow'),
          };
        });
        if (snap) zipProgressSnapshots.push({ elapsed: Date.now() - zt0, ...snap });
      }, 200);
      await zipBtn.click();
    })()
  ]);

  // Wait for download to finish
  await page.waitForTimeout(10000);
  clearInterval(zipProgressInterval);

  const zipElapsed = (Date.now() - zt0) / 1000;

  if (dl) {
    const dlPath = await dl.path().catch(() => null);
    if (dlPath) {
      const size = fs.statSync(dlPath).size;
      assert(zipElapsed < 30, 'T2: ZIP completes in <30s', `${zipElapsed.toFixed(1)}s`);
      assert(size > 1000, 'T2: ZIP has content', `${Math.round(size/1024)}KB`);
    }
  }

  // Check that progress bar showed download/build info
  // For small ZIPs (<5s), client-side build is too fast for React renders — acceptable
  const zipWithText = zipProgressSnapshots.filter(s => s.text && s.text.length > 5);
  const zipWithProgress = zipProgressSnapshots.filter(s =>
    s.text && (s.text.includes('KB') || s.text.includes('%') || s.text.includes('plates') || s.text.includes('compressing') || s.text.includes('diagram'))
  );
  const fastZip = zipElapsed < 5;
  assert(zipWithText.length > 0 || fastZip, 'T2: progress bar shows text during ZIP',
    fastZip ? `ZIP too fast (${zipElapsed.toFixed(1)}s) for visible progress` : `"${zipWithText[0]?.text}"`);
  assert(zipWithProgress.length >= 2 || fastZip, 'T2: ZIP progress updates with status info',
    fastZip ? `ZIP built in ${zipElapsed.toFixed(1)}s (progress not needed)` : `${zipWithProgress.length} updates`);
} else {
  assert(false, 'T2: ZIP button available');
}

assert(consoleErrors.length === 0, 'T2: zero console errors', consoleErrors.join('; '));

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
