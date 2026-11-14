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
import { mkdirSync, existsSync } from "node:fs";
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
  },
});

const width = Number(args.width);
const height = Number(args.height);
const maxMs = Number(args["max-seconds"]) * 1000;
const outPath = resolve(args.out);
const outDir = dirname(outPath);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const target = new URL(args.url);
target.searchParams.set("tour", "1");
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

await page.goto(target.href, { waitUntil: "networkidle", timeout: 60_000 });

// Let fonts settle and the first 3D frame land before anything is captured.
await page.waitForTimeout(Number(args["lead-in"]) * 1000);

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
