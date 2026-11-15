/**
 * Records the guided tour as a 1080p video, for the demo edit.
 *
 *   cd video && node record.mjs --campaign li-conductor --out work/tour-li.webm
 *
 * Assumes a dev or preview server is already serving the app (default
 * http://localhost:3000). The tour drives itself via `?tour=1`, so this script
 * only has to open the page, wait for the tour to signal completion, and keep
 * the frame still — no synthetic clicking, which is what makes the takes
 * repeatable.
 *
 * The app signals tour progress on `window.__athanorTour`:
 *     { state: "running" | "done", step: number, steps: number, caption: string }
 * If that hook is absent the script falls back to a fixed duration so a take
 * is still usable.
 */

import { chromium } from "playwright";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    campaign: { type: "string", default: "li-conductor" },
    out: { type: "string", default: "work/tour.webm" },
    url: { type: "string", default: "http://localhost:3000" },
    width: { type: "string", default: "1920" },
    height: { type: "string", default: "1080" },
    "max-seconds": { type: "string", default: "300" },
    "fallback-seconds": { type: "string", default: "90" },
    speed: { type: "string", default: "1" },
    "lead-in": { type: "string", default: "1.5" },
    "lead-out": { type: "string", default: "2.5" },
    "hero-seconds": { type: "string", default: "14" },
    "hold-seconds": { type: "string", default: "25" },
    timing: { type: "string" },
  },
});

const width = Number(args.width);
const height = Number(args.height);
const maxMs = Number(args["max-seconds"]) * 1000;
const outPath = resolve(args.out);
const outDir = dirname(outPath);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const target = new URL(args.url);
// Land on the hero (the results-first card) rather than jumping straight
// into the tour: it is the strongest opening visual, and the narration's
// first thirty seconds have nothing else to sit over.
target.searchParams.set("campaign", args.campaign);
if (args.speed !== "1") target.searchParams.set("speed", args.speed);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`recording ${target.href}`);
console.log(`  ${width}x${height} -> ${outPath}`);

const browser = await chromium.launch({
  args: [
    // Keep WebGL on a real GPU-backed path; the software rasterizer makes the
    // 3D scenes stutter, which is obvious in a video.
    "--use-gl=angle",
    "--use-angle=metal",
    "--enable-gpu-rasterization",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 1,
  colorScheme: "dark",
  reducedMotion: "no-preference",
  recordVideo: { dir: outDir, size: { width, height } },
});

const page = await context.newPage();

const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console: ${m.text()}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => {
  const f = r.failure();
  problems.push(`requestfailed: ${r.url()} ${f ? f.errorText : ""}`);
});

await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60_000 });

// Let fonts settle and the first 3D frame land before anything is captured.
await page.waitForTimeout(Number(args["lead-in"]) * 1000);

// Dwell on the landing card, then start the guided tour the way a viewer
// would — by pressing the button, so the transition is captured on camera.
const heroMs = Number(args["hero-seconds"]) * 1000;
if (heroMs > 0) {
  console.log(`  holding on the landing card for ${args["hero-seconds"]}s`);
  await page.waitForTimeout(heroMs);
}
// Hold each tour beat for exactly as long as the narration spends on it, so
// the footage lands on the voice at native speed instead of being stretched.
if (args.timing) {
  const t = JSON.parse(readFileSync(resolve(args.timing), "utf8"));
  const dwell = t.dwell ?? {};
  await page.evaluate((d) => { window.__athanorDwell = d; }, dwell);
  const secs = Object.values(dwell).reduce((a, b) => a + b, 0) / 1000;
  console.log(`  dwell from ${args.timing}: ${Object.keys(dwell).length} beats, ${secs.toFixed(0)}s of narration`);
  if (t.total) console.log(`  narration runs ${t.total.toFixed(0)}s`);
}

const watch = page.getByRole("button", { name: /watch it think/i }).first();
if (await watch.count()) {
  await watch.click();
  console.log("  clicked 'Watch it think' — tour starting");
} else {
  problems.push("'Watch it think' not found; falling back to ?tour=1");
  await page.goto(`${target.href}&tour=1`, { waitUntil: "domcontentloaded" });
}
await page.waitForTimeout(800);

// The recorded campaign spans its real wall-clock time, so replaying it at 1x
// would run far longer than any narration. Drive the UI's own speed control.
const speedLabel = args.speed === "1" ? null : `${args.speed}X`;
if (speedLabel) {
  const btn = page.getByRole("button", { name: new RegExp(`^${speedLabel}$`, "i") }).first();
  if (await btn.count()) {
    await btn.click();
    console.log(`  replay speed set to ${speedLabel}`);
  } else {
    problems.push(`speed control ${speedLabel} not found; recording at 1x`);
  }
}

const hasHook = await page.evaluate(() => typeof window.__athanorTour === "object");
const captions = [];
const started = Date.now();

if (hasHook) {
  let lastStep = -1;
  while (Date.now() - started < maxMs) {
    const state = await page.evaluate(() => window.__athanorTour);
    if (state && state.step !== lastStep) {
      lastStep = state.step;
      const line = `  [${((Date.now() - started) / 1000).toFixed(1)}s] step ${state.step}/${state.steps}: ${state.caption ?? ""}`;
      console.log(line);
      captions.push({ t: (Date.now() - started) / 1000, step: state.step, caption: state.caption ?? "" });
    }
    if (state && state.state === "done") {
      console.log("  tour reported done");
      break;
    }
    await sleep(250);
  }
  if (Date.now() - started >= maxMs) {
    problems.push(`tour did not finish within ${args["max-seconds"]}s`);
  }
} else {
  problems.push("window.__athanorTour missing — recorded a fixed-duration take instead");
  console.log(`  no tour hook; recording ${args["fallback-seconds"]}s`);
  await sleep(Number(args["fallback-seconds"]) * 1000);
}

// Hold on the finished campaign. The narration runs ~3 min while the tour
// is ~2.3 min, and a frozen last frame under live voice looks like a crash.
const holdMs = Number(args["hold-seconds"]) * 1000;
if (holdMs > 0) {
  console.log(`  holding on the final state for ${args["hold-seconds"]}s`);
  await page.waitForTimeout(holdMs);
}
await page.waitForTimeout(Number(args["lead-out"]) * 1000);

const video = page.video();
await context.close();
await browser.close();

if (video) {
  const produced = await video.path();
  console.log(`\nwrote ${produced}`);
  console.log(`(rename/convert to ${outPath} in the edit step)`);
}

if (captions.length) {
  console.log("\ncaption timeline:");
  for (const c of captions) console.log(`  ${c.t.toFixed(1)}s  ${c.caption}`);
}

if (problems.length) {
  console.log("\nPROBLEMS — fix these before using the take:");
  for (const p of [...new Set(problems)]) console.log(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log("\nclean take: no console errors, no failed requests");
}
