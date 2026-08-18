/**
 * Renders every PNG the project ships from the SVG sources beside this file.
 *
 *   node brand/render.mjs
 *
 * The SVGs are the sources of truth; every PNG here is generated. Chromium does
 * the rasterising because it is already a devDependency (playwright) and because
 * it is the same renderer that will draw these in the toolbar and the store, so
 * what we look at is what users get.
 *
 * ponytail: shells out to one browser for all sizes rather than adding
 * sharp/resvg. If PNG output ever needs to happen without playwright installed,
 * swap in `resvg-js` — the call shape is the same.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, '..');

/** [source svg, output path, width, height] — height omitted means square. */
const TARGETS = [
  ['mark-small.svg', 'extension/icons/16.png', 16],
  ['mark-small.svg', 'extension/icons/32.png', 32],
  ['mark.svg', 'extension/icons/48.png', 48],
  ['mark.svg', 'extension/icons/128.png', 128],
  ['mark.svg', 'brand/icon-180.png', 180],   // apple-touch-icon
  ['mark.svg', 'brand/icon-512.png', 512],   // site manifest / general purpose
  ['og.svg', 'brand/og.png', 1200, 630],
  ['store-tile.svg', 'brand/store-tile-440x280.png', 440, 280],
  ['store-marquee.svg', 'brand/store-marquee-1400x560.png', 1400, 560],
];

const browser = await chromium.launch();
let made = 0;
try {
  for (const [src, out, w, h = w] of TARGETS) {
    const svg = fs.readFileSync(path.join(HERE, src), 'utf8');
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    // `background: transparent` plus omitBackground keeps the icon corners round
    // rather than filling the rect the rounded square does not cover.
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:transparent}
       svg{display:block;width:${w}px;height:${h}px}</style>${svg}`,
      { waitUntil: 'load' },
    );
    const dest = path.join(ROOT, out);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await page.screenshot({ path: dest, omitBackground: true });
    await page.close();
    const bytes = fs.statSync(dest).size;
    console.log(`ok   ${out.padEnd(38)} ${w}x${h}  ${bytes} B`);
    made++;
  }
} finally {
  await browser.close();
}

console.log(`\nbrand: ${made} checks passed`);
