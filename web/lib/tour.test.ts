/**
 * Replays the fixture logs through the tour driver's matching logic and
 * renders every caption, so a beat that never fires — or interpolates an
 * empty string, "undefined" or "NaN" — fails here rather than on camera.
 *
 *   cd web && npx jiti lib/tour.test.ts
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Event } from "./contracts";
import { EMPTY_STATE, reduceEvent } from "./campaign-state";
import { TOUR } from "./tour";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Discover the recorded campaigns rather than hardcoding ids — they get
 *  renamed and re-recorded, and a hardcoded id would silently stop testing. */
function discoverCampaigns(): string[] {
  for (const base of [
    resolve(process.cwd(), "../campaigns"),
    resolve(process.cwd(), "public/campaigns"),
  ]) {
    if (!existsSync(base)) continue;
    const ids = readdirSync(base).filter((d) =>
      existsSync(resolve(base, d, "events.jsonl")),
    );
    if (ids.length > 0) return ids.sort();
  }
  throw new Error("no recorded campaigns found");
}

function loadLog(id: string): Event[] {
  const path = [
    resolve(process.cwd(), `../campaigns/${id}/events.jsonl`),
    resolve(process.cwd(), `public/campaigns/${id}/events.jsonl`),
  ].find((p) => existsSync(p));
  if (!path) throw new Error(`fixture ${id} not found`);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Event);
}

function run(id: string, expectAll: boolean) {
  console.log(`\n# tour over ${id}`);
  const events = loadLog(id);
  const fired = new Set<string>();
  const captions: { id: string; title: string; body: string }[] = [];

  // mirrors TourOverlay: after a beat fires the driver re-checks the same
  // event before resuming, so several beats can share one event
  let state = EMPTY_STATE;
  for (const event of events) {
    state = reduceEvent(state, event);
    for (;;) {
      const beat = TOUR.find((b) => !fired.has(b.id) && b.match(event, state));
      if (!beat) break;
      fired.add(beat.id);
      const body = beat.body(state, event);
      captions.push({ id: beat.id, title: beat.title, body });
    }
  }

  for (const c of captions) {
    const bad =
      c.body.length < 40 ||
      /undefined|NaN|\[object|null\b/.test(c.body) ||
      c.body.includes("  ");
    check(`beat "${c.id}" renders clean copy`, !bad, bad ? c.body.slice(0, 160) : "");
  }

  if (expectAll) {
    const missing = TOUR.filter((b) => !fired.has(b.id)).map((b) => b.id);
    check(
      "every beat fires on a complete campaign",
      missing.length === 0,
      missing.join(", "),
    );
    check(
      "the verdict beat names the refutation",
      captions.some((c) => c.id === "verdict" && /refut/i.test(c.body)),
    );
    check(
      "beats fire in script order",
      captions
        .map((c) => TOUR.findIndex((b) => b.id === c.id))
        .every((v, i, arr) => i === 0 || v > arr[i - 1]),
    );
  } else {
    check("a partial campaign still fires early beats", fired.size > 0, `${fired.size}`);
  }

  console.log(`  info ${captions.length} captions`);
  for (const c of captions) {
    console.log(`    [${c.id}] ${c.title}\n      ${c.body.slice(0, 150)}…`);
  }
}

const campaigns = discoverCampaigns();
console.log(`discovered campaigns: ${campaigns.join(", ")}`);
for (const id of campaigns) {
  const events = loadLog(id);
  const complete = events.some((e) => e.body.type === "campaign.completed");
  run(id, complete);
}

console.log(failures === 0 ? "\ntour: all checks passed" : `\ntour: ${failures} FAILED`);
if (failures > 0) process.exit(1);
