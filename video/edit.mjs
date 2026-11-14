/**
 * Composes the final demo video with ffmpeg, driven by timeline.json.
 *
 *   node edit.mjs --probe        inspect input/dylan.mov: duration + speech runs,
 *                                and propose `at` values for timeline.json
 *   node edit.mjs --captions     build work/captions.srt by aligning the script's
 *                                narration blocks to the detected speech runs
 *   node edit.mjs                render out/athanor-demo.mp4
 *   node edit.mjs --preview 30   render only the first 30s (fast iteration)
 *
 * Design: the NARRATION is the spine. Screen footage and cards are laid against
 * Dylan's voice, because a demo cut to the voice reads as deliberate while a
 * voice cut to the footage reads as rushed. Everything here is therefore timed
 * in narration seconds.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    timeline: { type: "string", default: "timeline.json" },
    probe: { type: "boolean", default: false },
    captions: { type: "boolean", default: false },
    preview: { type: "string" },
    out: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const T = JSON.parse(readFileSync(resolve(args.timeline), "utf8"));
const narration = resolve(T.sources.narration);
const screen = resolve(T.sources.screen);
const cardsDir = resolve(T.sources.cards);

function run(cmd, cmdArgs, { capture = false } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, cmdArgs, { stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let out = "", err = "";
    if (capture) {
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
    }
    p.on("close", (code) =>
      code === 0 ? res({ out, err }) : rej(new Error(`${cmd} exited ${code}\n${err.slice(-4000)}`)),
    );
    p.on("error", rej);
  });
}

async function duration(file) {
  const { out } = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { capture: true },
  );
  return parseFloat(out.trim());
}

/** Speech runs, from ffmpeg's silence detector. */
async function speechRuns(file, { noiseDb = -34, minSilence = 0.45 } = {}) {
  const { err } = await run(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", file, "-af",
     `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, "-f", "null", "-"],
    { capture: true },
  );
  const total = await duration(file);
  const starts = [...err.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...err.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));

  // Invert the silences to get speech.
  const runs = [];
  let cursor = 0;
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    if (s > cursor + 0.05) runs.push({ from: cursor, to: s });
    cursor = ends[i] ?? total;
  }
  if (cursor < total - 0.05) runs.push({ from: cursor, to: total });
  return { total, runs: runs.filter((r) => r.to - r.from > 0.25) };
}

/** The narration blocks, read from script.md so there is one source of truth. */
function scriptBlocks() {
  const md = readFileSync(resolve("script.md"), "utf8");
  const blocks = [];
  let section = null;
  for (const line of md.split("\n")) {
    const h = line.match(/^##\s+\d+\.\s+(.+?)\s*\(/);
    if (h) section = h[1].trim();
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      const text = q[1].trim();
      if (!text) continue;
      blocks.push({ section, text: text.replace(/\*\*/g, "").replace(/\s*\/\/\s*/g, " ") });
    }
  }
  return blocks;
}

function fmtSrtTime(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60), ms = Math.round((t % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/** Split a block into caption-sized lines (~70 chars, broken at clause ends). */
function captionChunks(text, max = 72) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max && cur) { lines.push(cur.trim()); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur.trim());
  return lines;
}

async function doProbe() {
  if (!existsSync(narration)) {
    console.log(`narration not found: ${narration}`);
    console.log("Record the take first (see script.md / teleprompter.html), then re-run --probe.");
    if (existsSync(screen)) console.log(`\nscreen footage IS present: ${screen} (${(await duration(screen)).toFixed(1)}s)`);
    return;
  }
  const { total, runs } = await speechRuns(narration);
  const blocks = scriptBlocks();
  console.log(`narration: ${narration}`);
  console.log(`  duration ${total.toFixed(1)}s · ${runs.length} speech runs · ${blocks.length} script blocks\n`);

  // Long pauses are the likeliest section boundaries.
  const gaps = [];
  for (let i = 1; i < runs.length; i++) {
    gaps.push({ at: runs[i].from, len: runs[i].from - runs[i - 1].to });
  }
  gaps.sort((a, b) => b.len - a.len);
  console.log("longest pauses (candidate section boundaries):");
  for (const g of gaps.slice(0, 8)) console.log(`  ${g.at.toFixed(2)}s   (${g.len.toFixed(2)}s pause)`);

  console.log("\nspeech runs:");
  for (const [i, r] of runs.entries()) {
    console.log(`  ${String(i).padStart(2)} ${r.from.toFixed(2)}–${r.to.toFixed(2)}s  (${(r.to - r.from).toFixed(2)}s)`);
  }
  if (runs.length !== blocks.length) {
    console.log(`\nNOTE: ${runs.length} speech runs vs ${blocks.length} script blocks — they need not match`);
    console.log("(you breathe mid-sentence). Use the longest pauses above to set segment `at` values.");
  }
  if (existsSync(screen)) {
    console.log(`\nscreen footage: ${(await duration(screen)).toFixed(1)}s — ${total > await duration(screen) ? "SHORTER than narration; record a longer tour or slow it" : "long enough"}`);
  } else {
    console.log(`\nscreen footage missing: ${screen} (run record.mjs)`);
  }
}

async function doCaptions() {
  if (!existsSync(narration)) { console.log(`narration not found: ${narration}`); return; }
  const { runs } = await speechRuns(narration);
  const blocks = scriptBlocks();

  // Distribute blocks across speech runs proportionally to word count, then
  // split each block into caption lines across its time span. This is a rough
  // alignment, not ASR — hand-correct work/captions.srt afterwards.
  const totalWords = blocks.reduce((a, b) => a + b.text.split(/\s+/).length, 0);
  const speechTotal = runs.reduce((a, r) => a + (r.to - r.from), 0);
  let t = runs.length ? runs[0].from : 0;
  let runIdx = 0, usedInRun = 0;

  const cues = [];
  for (const b of blocks) {
    const words = b.text.split(/\s+/).length;
    let span = (words / totalWords) * speechTotal;
    const lines = captionChunks(b.text);
    for (const line of lines) {
      const share = (line.split(/\s+/).length / words) * span;
      // Skip over silence between runs.
      while (runIdx < runs.length && usedInRun >= runs[runIdx].to - runs[runIdx].from) {
        runIdx++; usedInRun = 0;
        if (runIdx < runs.length) t = runs[runIdx].from;
      }
      const start = t, end = t + share;
      cues.push({ start, end, line });
      t = end; usedInRun += share;
    }
  }

  const srt = cues.map((c, i) =>
    `${i + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}\n${c.line}\n`,
  ).join("\n");
  const out = resolve(T.captions.srt);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, srt);
  console.log(`wrote ${out} (${cues.length} cues)`);
  console.log("This is a proportional alignment, not speech recognition — review and");
  console.log("nudge the timings before the final render.");
}

/** Build the ffmpeg filter graph for the composite. */
function buildGraph({ narrationDur, cards, previewTo }) {
  const W = T.output.width, H = T.output.height, FPS = T.output.fps;
  const f = [];

  // Screen footage: scale to frame, pad if the aspect differs, hold the last
  // frame if it runs short so the voice is never left over black.
  f.push(`[1:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
         `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x06070a,fps=${FPS},` +
         `tpad=stop_mode=clone:stop_duration=600,setsar=1[screen]`);

  // Dylan: rounded-corner PIP.
  const pipW = Math.round(W * T.pip.scale / 2) * 2;
  f.push(`[0:v]scale=${pipW}:-2,fps=${FPS},setsar=1[pipraw]`);
  f.push(`[pipraw]format=yuva420p,` +
         `geq=lum='p(X,Y)':a='if(gt(hypot(max(0,${T.pip.cornerRadius}-X)+max(0,X-(W-${T.pip.cornerRadius})),` +
         `max(0,${T.pip.cornerRadius}-Y)+max(0,Y-(H-${T.pip.cornerRadius}))),${T.pip.cornerRadius}),0,255)'[pip]`);

  const m = T.pip.margin;
  f.push(`[screen][pip]overlay=W-w-${m}:H-h-${m}:format=auto[composite]`);

  // Cards: each is an input image overlaid for its window, with a fade.
  let last = "composite";
  cards.forEach((c, i) => {
    const idx = 2 + i; // inputs 0=narration, 1=screen, 2.. = cards
    const label = `c${i}`;
    const fade = c.fade ?? 0.4;
    if (c.mode === "fullscreen") {
      f.push(`[${idx}:v]scale=${W}:${H},format=yuva420p,` +
             `fade=t=in:st=0:d=${fade}:alpha=1,fade=t=out:st=${Math.max(0, c.duration - fade)}:d=${fade}:alpha=1,` +
             `setsar=1[${label}]`);
    } else {
      f.push(`[${idx}:v]scale=${W}:${H},format=yuva420p,` +
             `fade=t=in:st=0:d=${fade}:alpha=1,fade=t=out:st=${Math.max(0, c.duration - fade)}:d=${fade}:alpha=1,` +
             `setsar=1[${label}]`);
    }
    const outLabel = `ov${i}`;
    f.push(`[${last}][${label}]overlay=0:0:enable='between(t,${c.at},${c.at + c.duration})'[${outLabel}]`);
    last = outLabel;
  });

  // Captions.
  let vFinal = last;
  if (T.captions?.enabled && existsSync(resolve(T.captions.srt))) {
    const srt = resolve(T.captions.srt).replace(/([:'\\])/g, "\\$1");
    f.push(`[${last}]subtitles='${srt}':force_style='FontName=Inter,Fontsize=${T.captions.fontSize},` +
           `PrimaryColour=&H00FAFAFA,OutlineColour=&H90000000,BorderStyle=3,Outline=2,Shadow=0,` +
           `MarginV=${T.captions.marginBottom}'[vout]`);
    vFinal = "vout";
  }

  // Audio: normalize the narration to a consistent broadcast loudness.
  f.push(`[0:a]loudnorm=I=${T.audio.narrationLoudnessLUFS}:TP=-1.5:LRA=11,aresample=48000[aout]`);

  return { filter: f.join(";"), vLabel: vFinal, aLabel: "aout" };
}

function collectCards() {
  const out = [];
  for (const seg of T.segments) {
    for (const c of seg.cards ?? []) {
      if (c.at === null || c.at === undefined) continue;
      const file = resolve(cardsDir, `${c.card}.png`);
      if (!existsSync(file)) {
        console.log(`  skipping card "${c.card}" — ${file} not rendered (run render-cards.mjs)`);
        continue;
      }
      out.push({ ...c, file });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

async function doRender() {
  const missing = [];
  if (!existsSync(narration)) missing.push(`narration: ${narration}`);
  if (!existsSync(screen)) missing.push(`screen footage: ${screen}`);
  if (missing.length) {
    console.log("cannot render — missing inputs:");
    for (const m of missing) console.log(`  - ${m}`);
    console.log("\nRecord the tour with record.mjs, and the narration per script.md.");
    process.exitCode = 1;
    return;
  }

  const narrationDur = await duration(narration);
  const cards = collectCards();
  const unscheduled = T.segments.flatMap((s) => (s.cards ?? []).filter((c) => c.at == null));
  if (unscheduled.length) {
    console.log(`note: ${unscheduled.length} card(s) have no \`at\` yet and are omitted.`);
    console.log("      run `node edit.mjs --probe` and fill them into timeline.json.\n");
  }

  const outPath = resolve(args.out ?? T.output.path);
  mkdirSync(dirname(outPath), { recursive: true });

  const { filter, vLabel, aLabel } = buildGraph({ narrationDur, cards });
  const inputs = ["-i", narration, "-i", screen, ...cards.flatMap((c) => ["-i", c.file])];
  const previewTo = args.preview ? ["-t", String(Number(args.preview))] : [];

  const ff = [
    "-hide_banner", "-y",
    ...inputs,
    "-filter_complex", filter,
    "-map", `[${vLabel}]`, "-map", `[${aLabel}]`,
    "-c:v", "libx264", "-preset", args.preview ? "veryfast" : "slow",
    "-b:v", T.output.videoBitrate, "-maxrate", T.output.videoBitrate, "-bufsize", "24M",
    "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.2",
    "-c:a", "aac", "-b:a", T.output.audioBitrate, "-ar", "48000",
    "-movflags", "+faststart",
    "-shortest",
    ...previewTo,
    outPath,
  ];

  console.log(`rendering ${outPath}`);
  console.log(`  narration ${narrationDur.toFixed(1)}s · screen ${(await duration(screen)).toFixed(1)}s · ${cards.length} cards`);
  if (args["dry-run"]) {
    console.log(`\nffmpeg ${ff.map((a) => (/[\s;']/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
    return;
  }
  await run("ffmpeg", ff);

  const d = await duration(outPath);
  console.log(`\ndone: ${outPath} (${Math.floor(d / 60)}m${String(Math.round(d % 60)).padStart(2, "0")}s)`);
  console.log("Check it before uploading: audio sync, the REFUTED beat landing on 'fails',");
  console.log("and that no card covers the NEB animation.");
}

if (args.probe) await doProbe();
else if (args.captions) await doCaptions();
else await doRender();
