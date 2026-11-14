/**
 * Renders every title card in cards/cards.html to a 1920x1080 PNG.
 *
 *   cd video && node render-cards.mjs            # -> work/cards/<id>.png
 *   cd video && node render-cards.mjs --only tech
 *
 * Cards whose id starts with `lt-` are lower thirds and render with a
 * transparent background so they can be composited over footage.
 */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: "work/cards" },
    only: { type: "string" },
    width: { type: "string", default: "1920" },
    height: { type: "string", default: "1080" },
    scale: { type: "string", default: "1" },
  },
});

const width = Number(args.width);
const height = Number(args.height);
const outDir = resolve(args.out);
mkdirSync(outDir, { recursive: true });

const pageUrl = pathToFileURL(resolve("cards/cards.html")).href;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: Number(args.scale),
  colorScheme: "dark",
});
const probe = await context.newPage();
await probe.goto(pageUrl, { waitUntil: "load" });
const allIds = await probe.evaluate(() => window.__cardIds ?? []);
await probe.close();

if (!allIds.length) {
  console.error("no cards found in cards/cards.html — did the markup change?");
  process.exit(1);
}

const ids = args.only ? allIds.filter((id) => id === args.only) : allIds;
if (!ids.length) {
  console.error(`card "${args.only}" not found. available: ${allIds.join(", ")}`);
  process.exit(1);
}

const failed = [];
for (const id of ids) {
  const page = await context.newPage();
  const transparent = id.startsWith("lt-");
  try {
    await page.goto(`${pageUrl}?card=${encodeURIComponent(id)}`, { waitUntil: "load" });
    // Wait for webfonts, or the screenshot catches a fallback face.
    await page.waitForFunction(() => window.__cardReady === true, { timeout: 15_000 });
    await page.waitForTimeout(150);
    const out = resolve(outDir, `${id}.png`);
    await page.screenshot({ path: out, omitBackground: transparent });
    console.log(`  ${id.padEnd(16)} -> ${out}${transparent ? "  (transparent)" : ""}`);
  } catch (err) {
    failed.push(`${id}: ${err.message.split("\n")[0]}`);
    console.log(`  ${id.padEnd(16)} FAILED`);
  } finally {
    await page.close();
  }
}

await context.close();
await browser.close();

console.log(`\n${ids.length - failed.length}/${ids.length} cards rendered to ${outDir}`);
if (failed.length) {
  console.log("failures:");
  for (const f of failed) console.log(`  - ${f}`);
  process.exitCode = 1;
}
