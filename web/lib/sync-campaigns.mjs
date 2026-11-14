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
  console.error(`no campaigns directory at ${src}`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const campaigns = [];
for (const name of readdirSync(src).sort()) {
  const log = resolve(src, name, "events.jsonl");
  if (!existsSync(log)) continue;

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
