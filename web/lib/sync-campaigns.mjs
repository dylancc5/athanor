/**
 * Copy recorded campaigns into `web/public/campaigns/` and write the manifest
 * the static source reads. The public build has no backend, so this is how
 * campaigns ship.
 *
 *   cd web && node lib/sync-campaigns.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const src = resolve(process.cwd(), "../campaigns");
const dest = resolve(process.cwd(), "public/campaigns");

if (!existsSync(src)) {
  // A deploy that uploads only `web/` (Vercel with this as the root directory)
  // has no sibling `campaigns/`. The recorded campaigns are committed under
  // `public/campaigns/`, so that build is still correct — skip rather than
  // fail it. Only error when there is genuinely nothing to serve.
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    console.log(
      `no source at ${src}; keeping the ${readdirSync(dest).length} committed ` +
        `campaign file(s) already in public/campaigns/`,
    );
    process.exit(0);
  }
  console.error(
    `no campaigns directory at ${src}, and public/campaigns/ is empty — ` +
      `nothing to serve. Record a campaign first (backend/scripts/record_campaigns.py).`,
  );
  process.exit(1);
}

// Never ship a campaign that is still being recorded. A log without a
// terminal event is a live run in progress, and copying it would replace a
// complete campaign with one that stops before its verdict and proposal —
// exactly the part the demo exists to show.
const isComplete = (logPath) => {
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    try {
      const type = JSON.parse(lines[i]).body?.type;
      return type === "campaign.completed" || type === "campaign.error";
    } catch {
      return false;
    }
  }
  return false;
};

// Decide what to ship BEFORE touching the destination. Wiping first and then
// skipping would delete a good published campaign and replace it with nothing.
const ready = readdirSync(src)
  .sort()
  .filter((name) => {
    const log = resolve(src, name, "events.jsonl");
    if (!existsSync(log)) return false;
    if (!isComplete(log)) {
      console.log(`  ${name}: SKIPPED — still recording (no terminal event)`);
      return false;
    }
    return true;
  });

if (ready.length === 0) {
  const kept = existsSync(dest) ? readdirSync(dest).length : 0;
  console.log(
    kept
      ? `no complete campaigns to sync; leaving the ${kept} already published untouched`
      : "no complete campaigns to sync, and nothing is published yet",
  );
  process.exit(kept ? 0 : 1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const campaigns = [];
for (const name of ready) {
  const log = resolve(src, name, "events.jsonl");

  mkdirSync(resolve(dest, name), { recursive: true });
  cpSync(log, resolve(dest, name, "events.jsonl"));
  const artifacts = resolve(src, name, "artifacts");
  if (existsSync(artifacts)) {
    cpSync(artifacts, resolve(dest, name, "artifacts"), { recursive: true });
  }

  const events = readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const spec = events.find((e) => e.body.type === "spec.created")?.body.spec;
  const started = events.find((e) => e.body.type === "campaign.started")?.body;
  campaigns.push({
    id: name,
    title: spec?.title ?? name,
    goal: started?.goal ?? "",
    domain: spec?.domain ?? null,
    n_events: events.length,
    completed: events.some((e) => e.body.type === "campaign.completed"),
  });
  console.log(`  ${name}: ${events.length} events`);
}

writeFileSync(
  resolve(dest, "index.json"),
  `${JSON.stringify({ campaigns }, null, 2)}\n`,
);
console.log(`wrote ${campaigns.length} campaigns to public/campaigns/`);
