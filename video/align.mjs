/**
 * Aligns the screen recording to Dylan's narration.
 *
 *   node align.mjs                       transcribe input/dylan.mov and align
 *   node align.mjs --audio other.mov
 *
 * Writes:
 *   work/transcript.json   word-level transcript with timestamps
 *   work/timing.json       { blocks: [...], dwell: { <beatId>: ms } }
 *   work/captions.srt      burned-in captions, timed to the real delivery
 *
 * How it works: whisper gives word-level timestamps. Each script block from
 * script.md is matched to the span of transcript words that best covers it,
 * so we learn when Dylan actually says each line — including the pauses and
 * the lines he reworded. Those spans become dwell times for the tour beats,
 * and the recorder replays the tour holding each beat exactly that long. The
 * footage is therefore cut to the voice at native speed, with no stretching.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    audio: { type: "string", default: "input/dylan.mov" },
    model: { type: "string", default: "" },
    out: { type: "string", default: "work" },
    reuse: { type: "boolean", default: false },
    // The replay advances between beats, which costs wall-clock the dwell does
    // not cover. Measured at ~4s per beat on this campaign; subtracted from
    // each beat's hold so the finished take matches the narration length.
    "transit-ms": { type: "string", default: "4200" },
  },
});

const WHISPER_MODELS = [
  args.model,
  `${process.env.HOME}/Library/Application Support/superwhisper/ggml-small.bin`,
  `${process.env.HOME}/Library/Application Support/superwhisper/ggml-base.bin`,
].filter(Boolean);

const outDir = resolve(args.out);
mkdirSync(outDir, { recursive: true });

/**
 * Which tour beat each script block should be sitting on. The tour has 14
 * beats and the script has 13 narration blocks, so this is the editorial
 * mapping — several narration lines ride one beat, and the ones that must
 * land exactly (the hop, the verdict) get a beat to themselves.
 */
const BLOCK_TO_BEAT = [
  "goal",        // 1 · open
  "goal",        // 2a · problem, cost
  "spec",        // 2b · problem, unvalidated candidates
  "spec",        // 3 · what it does
  "hypothesis",  // 4a · the four agents
  "skeptic",     // 4b · the physics is real
  "measurements",// 5a · it proposes
  "neb",         // 5b · the lithium hop        <- must land here
  "verdict",     // 5c · the prediction doesn't hold  <- must land here
  "proposal",    // 6a · what a lab can act on
  "ledger",      // 6b · possibilities
  "controller",  // 6c · roadmap / other labs' models
  "done",        // 6d · close
];

function run(cmd, cmdArgs) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? res({ out, err }) : rej(new Error(`${cmd} exited ${c}\n${err.slice(-2500)}`))));
    p.on("error", rej);
  });
}

const norm = (s) =>
  s.toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();

/** Narration blocks, read from script.md so there is one source of truth. */
function scriptBlocks() {
  const md = readFileSync(resolve("script.md"), "utf8");
  const blocks = [];
  let section = null;
  for (const line of md.split("\n")) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) section = h[1].trim();
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      const text = q[1].trim().replace(/\*\*/g, "");
      if (text) blocks.push({ section, text: text.replace(/\s*\/\/\s*/g, " ") });
    }
  }
  return blocks;
}

async function transcribe() {
  const cached = resolve(outDir, "transcript.json");
  if (args.reuse && existsSync(cached)) {
    console.log(`reusing ${cached}`);
    return JSON.parse(readFileSync(cached, "utf8"));
  }
  const audio = resolve(args.audio);
  if (!existsSync(audio)) {
    console.error(`narration not found: ${audio}`);
    console.error("Record the take and drop it there, then re-run.");
    process.exit(1);
  }
  const model = WHISPER_MODELS.find((m) => existsSync(m));
  if (!model) {
    console.error("no whisper model found. Looked in:\n  " + WHISPER_MODELS.join("\n  "));
    process.exit(1);
  }

  const wav = resolve(outDir, "narration.wav");
  console.log("extracting audio…");
  await run("ffmpeg", ["-v", "error", "-y", "-i", audio, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);

  console.log(`transcribing with ${model.split("/").pop()} (word timestamps)…`);
  const stem = resolve(outDir, "transcript");
  await run("whisper-cli", ["-m", model, "-f", wav, "--output-json", "-of", stem, "-ml", "1"]);

  const raw = JSON.parse(readFileSync(`${stem}.json`, "utf8"));
  // whisper -ml 1 emits sub-word TOKENS, not words: "proposes" comes back as
  // "prop" + "oses" and "doesn't" as "doesn" + "'t". A token that did not
  // begin with a space is a continuation of the previous one, so merge it back
  // or every caption is littered with split words.
  const tokens = (raw.transcription ?? []).map((t) => ({
    raw: t.text,
    text: t.text.trim(),
    from: t.offsets.from / 1000,
    to: t.offsets.to / 1000,
  }));
  const words = [];
  for (const t of tokens) {
    if (!t.text) continue;
    const continuation =
      words.length > 0 && (!/^\s/.test(t.raw) || /^[''’,.!?;:%)\]]/.test(t.text));
    if (continuation && /[a-z0-9''’,.!?;:]/i.test(t.text)) {
      const prev = words[words.length - 1];
      prev.text += t.text;
      prev.to = Math.max(prev.to, t.to);
    } else if (/[a-z0-9]/i.test(t.text)) {
      words.push({ text: t.text, from: t.from, to: t.to });
    }
  }
  writeFileSync(cached, JSON.stringify({ words }, null, 2));
  console.log(`  ${words.length} words, ${words.at(-1)?.to.toFixed(1)}s`);
  return { words };
}

/**
 * Align blocks to the transcript by dynamic programming over the cut points.
 *
 * Dylan reads the script in order, so the alignment is a monotonic partition
 * of the transcript into one contiguous span per block. A greedy left-to-right
 * walk compounds its own error — one block that overruns pushes every later
 * block late — so instead we choose all the cut points at once, maximising the
 * total word-overlap score. That is robust to rewording, skipped filler and
 * retakes, because a block that matches poorly cannot drag the rest along.
 */
function alignBlocks(words, blocks) {
  const N = words.length;
  const B = blocks.length;
  const wNorm = words.map((w) => norm(w.text));
  const targets = blocks.map((b) => norm(b.text).split(" ").filter(Boolean));
  const targetSets = targets.map((t) => new Set(t));

  // Score for block b covering words [i, j): overlap against its own length,
  // damped by how far the span is from the expected word count.
  const score = (b, i, j) => {
    const len = j - i;
    if (len <= 0) return -1e6;
    const set = targetSets[b];
    let hits = 0;
    for (let k = i; k < j; k++) if (set.has(wNorm[k])) hits++;
    const coverage = hits / Math.max(1, targets[b].length);
    const ratio = len / Math.max(1, targets[b].length);
    const lengthPenalty = Math.abs(Math.log(Math.max(0.2, ratio)));
    return coverage - 0.55 * lengthPenalty;
  };

  // Bound each span so the DP stays small and no block can swallow the take.
  const maxSpan = (b) => Math.max(12, Math.ceil(targets[b].length * 2.4));

  // best[b][i] = best total score for blocks b.. covering words i..N
  const best = Array.from({ length: B + 1 }, () => new Float64Array(N + 1).fill(-Infinity));
  const cut = Array.from({ length: B + 1 }, () => new Int32Array(N + 1).fill(-1));
  best[B][N] = 0;
  for (let i = 0; i <= N; i++) if (i !== N) best[B][i] = -1e6 * (N - i);

  for (let b = B - 1; b >= 0; b--) {
    const span = maxSpan(b);
    for (let i = N; i >= 0; i--) {
      let bestScore = -Infinity, bestJ = -1;
      const remaining = B - b;
      // Leave at least one word for every later block.
      const jMax = Math.min(N - (remaining - 1), i + span);
      for (let j = i + 1; j <= jMax; j++) {
        const tail = best[b + 1][j];
        if (tail === -Infinity) continue;
        const sc = score(b, i, j) + tail;
        if (sc > bestScore) { bestScore = sc; bestJ = j; }
      }
      best[b][i] = bestScore;
      cut[b][i] = bestJ;
    }
  }

  const spans = [];
  let i = 0;
  for (let b = 0; b < B; b++) {
    const j = cut[b][i] > 0 ? cut[b][i] : Math.min(i + targets[b].length, N);
    const from = words[i]?.from ?? spans.at(-1)?.to ?? 0;
    const to = words[Math.max(i, j - 1)]?.to ?? from;
    const set = targetSets[b];
    let hits = 0;
    for (let k = i; k < j; k++) if (set.has(wNorm[k])) hits++;
    spans.push({
      index: b,
      section: blocks[b].section,
      text: blocks[b].text,
      from,
      to,
      duration: Math.max(0.4, to - from),
      words: j - i,
      confidence: Math.max(0, Math.min(1, hits / Math.max(1, targets[b].length))),
      heard: words.slice(i, j).map((w) => w.text).join(" "),
    });
    i = j;
  }
  return spans;
}

/**
 * Terms speech recognition reliably mangles. These captions are burned in, so
 * a wrong product or model name is permanent and visible — worth a lookup.
 * Keys are matched case-insensitively against whole words.
 */
const TERM_FIXES = new Map(Object.entries({
  "athenaur": "ATHANOR", "athanor": "ATHANOR", "athena": "ATHANOR",
  "athenor": "ATHANOR", "athener": "ATHANOR", "ethanor": "ATHANOR",
  "atheneur": "ATHANOR", "anthanor": "ATHANOR",
  "mace": "MACE", "neb": "NEB", "dft": "DFT", "ood": "OOD",
  "pareto": "Pareto", "mattergen": "MatterGen", "matter-gen": "MatterGen",
  "gnome": "GNoME", "nome": "GNoME", "alchemy": "ALCHEMI", "alchemi": "ALCHEMI",
  "deepmind": "DeepMind", "deep-mind": "DeepMind",
  "nvidia": "NVIDIA", "meta": "Meta", "microsoft": "Microsoft",
  "claude": "Claude", "li3ps4": "Li3PS4", "lithium": "lithium",
}));

function fixTerms(text) {
  return text.replace(/[A-Za-z][A-Za-z0-9'-]*/g, (w) => {
    const hit = TERM_FIXES.get(w.toLowerCase());
    if (!hit) return w;
    // Keep sentence capitalisation if the word was already capitalised there.
    return hit;
  });
}

function fmtSrt(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60), ms = Math.round((t % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/** Caption lines from the real transcript, so they match what was actually said. */
function buildSrt(words, maxChars = 74) {
  const cues = [];
  let cur = [], start = null;
  for (const w of words) {
    if (start === null) start = w.from;
    cur.push(w);
    const text = cur.map((x) => x.text).join(" ");
    const endsClause = /[.!?,;:]$/.test(w.text);
    if (text.length >= maxChars || (endsClause && text.length > 28)) {
      cues.push({ start, end: w.to, text: fixTerms(text.replace(/\s+([,.!?;:])/g, "$1")) });
      cur = []; start = null;
    }
  }
  if (cur.length) cues.push({ start, end: cur.at(-1).to, text: fixTerms(cur.map((x) => x.text).join(" ")) });
  return cues.map((c, i) => `${i + 1}\n${fmtSrt(c.start)} --> ${fmtSrt(c.end)}\n${c.text}\n`).join("\n");
}

// ---------------------------------------------------------------------------

const { words } = await transcribe();
const blocks = scriptBlocks();
if (blocks.length !== BLOCK_TO_BEAT.length) {
  console.log(
    `NOTE: script.md has ${blocks.length} narration blocks but BLOCK_TO_BEAT maps ${BLOCK_TO_BEAT.length}. ` +
      `Edit the map in align.mjs so each line sits on the right beat.`,
  );
}

const spans = alignBlocks(words, blocks);

// Sum each beat's share of the narration; that is how long the tour holds it.
// Accumulate in seconds, convert to ms once. Several narration lines can ride
// one beat, and converting on each add would compound the unit conversion.
const dwellSeconds = {};
spans.forEach((s, i) => {
  const beat = BLOCK_TO_BEAT[i];
  if (!beat) return;
  dwellSeconds[beat] = (dwellSeconds[beat] ?? 0) + s.duration;
});
const transit = Number(args["transit-ms"]);
const dwell = Object.fromEntries(
  Object.entries(dwellSeconds).map(([k, v]) => [
    k,
    // Never below 1.5s: a beat still has to be readable on screen.
    Math.max(1500, Math.round(v * 1000 - transit)),
  ]),
);

const total = words.at(-1)?.to ?? 0;
console.log(`\nnarration: ${Math.floor(total / 60)}m${String(Math.round(total % 60)).padStart(2, "0")}s\n`);
console.log("block                              said      dur   beat        match");
for (const s of spans) {
  const flag = s.confidence < 0.45 ? "  <- check" : "";
  console.log(
    `  ${String(s.index).padStart(2)} ${(s.section ?? "").slice(0, 22).padEnd(22)} ` +
      `${s.from.toFixed(1).padStart(6)}s ${s.duration.toFixed(1).padStart(6)}s  ` +
      `${(BLOCK_TO_BEAT[s.index] ?? "-").padEnd(12)}${(s.confidence * 100).toFixed(0)}%${flag}`,
  );
}

writeFileSync(resolve(outDir, "timing.json"), JSON.stringify({ total, spans, dwell }, null, 2));
writeFileSync(resolve(outDir, "captions.srt"), buildSrt(words));
console.log(`\nwrote ${outDir}/timing.json and captions.srt`);
console.log("next: node record.mjs --timing work/timing.json   (re-records the tour to your pacing)");

const weak = spans.filter((s) => s.confidence < 0.45);
if (weak.length) {
  console.log(`\n${weak.length} block(s) matched weakly — likely reworded on the take:`);
  for (const s of weak) {
    console.log(`  [${s.index}] script: ${s.text.slice(0, 80)}…`);
    console.log(`      heard: ${s.heard.slice(0, 80)}…`);
  }
}
