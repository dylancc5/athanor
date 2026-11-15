/**
 * Renders each caption cue to a transparent 1920x1080 PNG.
 *
 *   node render-captions.mjs                 work/captions.srt -> work/caps/*.png
 *
 * Why not ffmpeg: this ffmpeg build ships without libass and without
 * drawtext, so neither `subtitles` nor `drawtext` exists. Rendering in the
 * browser is not a workaround so much as an upgrade — the captions come out
 * in the product's own typeface, matching the title cards exactly, with real
 * kerning and a readable scrim behind them.
 *
 * `edit.mjs` overlays each PNG for its cue's time span.
 */

import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    srt: { type: "string", default: "work/captions.srt" },
    out: { type: "string", default: "work/caps" },
    width: { type: "string", default: "1920" },
    height: { type: "string", default: "1080" },
    "font-size": { type: "string", default: "34" },
    "margin-bottom": { type: "string", default: "72" },
    position: { type: "string", default: "top" },
    "max-width": { type: "string", default: "1180" },
  },
});

const W = Number(args.width), H = Number(args.height);
const outDir = resolve(args.out);

function parseSrt(text) {
  const cues = [];
  for (const block of text.replace(/\r/g, "").trim().split(/\n\n+/)) {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length < 2) continue;
    const timing = lines.find((l) => l.includes("-->"));
    if (!timing) continue;
    const [a, b] = timing.split("-->").map((t) => t.trim());
    const secs = (t) => {
      const m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
      if (!m) return 0;
      return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
    };
    const textLines = lines.slice(lines.indexOf(timing) + 1);
    if (!textLines.length) continue;
    cues.push({ start: secs(a), end: secs(b), text: textLines.join(" ").trim() });
  }
  return cues;
}

const srtPath = resolve(args.srt);
if (!existsSync(srtPath)) {
  console.error(`no captions at ${srtPath} — run align.mjs first`);
  process.exit(1);
}
const cues = parseSrt(readFileSync(srtPath, "utf8"));
if (!cues.length) {
  console.error("no cues parsed");
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const page_html = (text) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${W}px;height:${H}px;background:transparent;overflow:hidden}
  .wrap{position:absolute;left:50%;transform:translateX(-50%);${args.position === "top" ? `top:${args["margin-bottom"]}px` : `bottom:${args["margin-bottom"]}px`};
    max-width:${args["max-width"]}px;text-align:center}
  .cap{display:inline-block;
    font-family:Inter,system-ui,sans-serif;font-size:${args["font-size"]}px;font-weight:500;
    line-height:1.38;color:#fafafa;letter-spacing:-0.004em;
    background:rgba(6,7,10,.72);
    padding:.42em .78em;border-radius:10px;
    box-shadow:0 2px 24px rgba(0,0,0,.45);
    text-shadow:0 1px 3px rgba(0,0,0,.85);
    backdrop-filter:blur(2px)}
</style></head><body><div class="wrap"><span class="cap"></span></div>
<script>
  document.querySelector(".cap").textContent = ${JSON.stringify(text)};
  document.fonts.ready.then(()=>{window.__ready=true});
</script></body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();

const manifest = [];
let i = 0;
for (const cue of cues) {
  const file = resolve(outDir, `cap-${String(i).padStart(4, "0")}.png`);
  await page.setContent(page_html(cue.text), { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10_000 }).catch(() => {});
  await page.screenshot({ path: file, omitBackground: true });
  manifest.push({ file, start: cue.start, end: cue.end, text: cue.text });
  i++;
  if (i % 20 === 0) console.log(`  ${i}/${cues.length}`);
}

await ctx.close();
await browser.close();

writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`rendered ${manifest.length} caption frames to ${outDir}`);
