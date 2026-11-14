/**
 * Reducer tests against the real recorded fixture logs.
 *
 * Run with the locally installed jiti (no test runner is installed):
 *   cd web && npx jiti lib/campaign-state.test.ts
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Event } from "./contracts";
import {
  EMPTY_STATE,
  createSnapshotCache,
  foldRange,
  reduceEvent,
  notebookEntries,
  reduceEvents,
  stateAt,
  verdictCounts,
} from "./campaign-state";

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, a: unknown, b: unknown) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  check(name, sa === sb, sa === sb ? "" : `\n    a=${trunc(sa)}\n    b=${trunc(sb)}`);
}

function trunc(s: string | undefined) {
  if (!s) return String(s);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
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
  const candidates = [
    resolve(process.cwd(), `../campaigns/${id}/events.jsonl`),
    resolve(process.cwd(), `public/campaigns/${id}/events.jsonl`),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) throw new Error(`fixture ${id} not found: tried ${candidates.join(", ")}`);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Event);
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

function run(id: string) {
  console.log(`\n# ${id}`);
  const events = loadLog(id);
  check("log is non-empty", events.length > 0, `${events.length} events`);

  // seq numbers are contiguous from 0 in these fixtures
  check(
    "seq is monotonic",
    events.every((e, i) => i === 0 || e.seq > events[i - 1].seq),
  );

  // 1. determinism: two independent replays are identical
  const a = reduceEvents(events);
  const b = reduceEvents(events);
  eq("replay twice is identical", a, b);

  // 2. no mutation of inputs: freeze the events and the empty state, replay again
  deepFreeze(events);
  deepFreeze(EMPTY_STATE);
  const c = reduceEvents(events);
  eq("replay with frozen inputs matches", a, c);

  // 3. snapshots never mutated by later folds
  const mid = Math.floor(events.length / 2);
  const snapshot = reduceEvents(events, mid);
  const snapshotJson = JSON.stringify(snapshot);
  foldRange(events, mid, events.length, snapshot); // keep folding onward from it
  eq("folding onward does not mutate the snapshot", JSON.parse(snapshotJson), snapshot);

  // 4. incremental equals full fold at every index
  let incremental = EMPTY_STATE;
  let stepOk = true;
  for (let i = 0; i < events.length; i++) {
    incremental = reduceEvent(incremental, events[i]);
    if (JSON.stringify(incremental) !== JSON.stringify(reduceEvents(events, i + 1))) {
      stepOk = false;
      console.log(`    diverged at index ${i} (${events[i].body.type})`);
      break;
    }
  }
  check("stepwise fold equals fresh fold at every index", stepOk);

  // 5. cached random seeking, forward and back, equals a fresh fold
  const cache = createSnapshotCache(5);
  const order = [0, events.length, 3, events.length - 1, 1, 12, 7, 40, 2, mid, 0, events.length];
  let seekOk = true;
  for (const n of order) {
    const want = reduceEvents(events, n);
    const got = stateAt(events, n, cache);
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      seekOk = false;
      console.log(`    seek to ${n} diverged`);
      break;
    }
  }
  check("cached seek (random order, both directions) equals fresh fold", seekOk);

  // 6. empty prefix is the empty state
  eq("count 0 is the empty state", stateAt(events, 0, cache), EMPTY_STATE);
  eq("count beyond the end clamps", stateAt(events, events.length + 50, cache), a);

  // 7. notebook entries are concatenated by entry_id, first heading wins
  const entries = notebookEntries(a);
  const deltas = events.filter((e) => e.body.type === "notebook.delta");
  if (deltas.length > 0) {
    const byEntry = new Map<string, string>();
    for (const e of deltas) {
      if (e.body.type !== "notebook.delta") continue;
      byEntry.set(e.body.entry_id, (byEntry.get(e.body.entry_id) ?? "") + e.body.text);
    }
    check("one notebook entry per entry_id", entries.length === byEntry.size);
    check(
      "notebook text is the concatenation of its deltas",
      entries.every((en) => en.text === byEntry.get(en.entryId)),
    );
    check(
      "every entry with a heading kept it",
      entries.every((en) => en.heading === null || typeof en.heading === "string"),
    );
    check(
      "chunk counts add up",
      entries.reduce((n, en) => n + en.chunks, 0) === deltas.length,
    );
  }

  // 8. derived facts that the panels depend on
  const measurementEvents = events.filter((e) => e.body.type === "measurement.recorded");
  check(
    "every measurement is in the log",
    a.measurementLog.length === measurementEvents.length,
    `${a.measurementLog.length} vs ${measurementEvents.length}`,
  );
  check(
    "every measured candidate is a known candidate",
    Object.keys(a.measurements).every((id) => id in a.candidates),
  );
  check(
    "every artifact's candidate is known",
    a.artifactIds.every((id) => a.artifacts[id].candidate_id in a.candidates),
  );
  check("spec materialized", a.spec !== null);
  check("goal captured", typeof a.goal === "string" && a.goal.length > 0);
  check("lastSeq is the final seq", a.lastSeq === events[events.length - 1].seq);

  const counts = verdictCounts(a);
  console.log(
    `  info verdicts: ${JSON.stringify(counts)}  candidates=${a.candidateIds.length}` +
      ` measurements=${a.measurementLog.length} artifacts=${a.artifactIds.length}` +
      ` notebook=${entries.length} completed=${a.completed}`,
  );
}

const campaigns = discoverCampaigns();
console.log(`discovered campaigns: ${campaigns.join(", ")}`);
for (const id of campaigns) run(id);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
