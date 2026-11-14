/**
 * Loads the *real* campaign fixtures from disk so the tests run against the
 * actual MACE output and the actual CIFs the generators emit, not against
 * invented data.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__ -> structure -> three -> components -> web -> repo root
export const REPO_ROOT = path.resolve(here, "..", "..", "..", "..", "..");
export const CAMPAIGNS = path.join(REPO_ROOT, "campaigns");

export interface CandidateFixture {
  id: string;
  name: string;
  formula: string | null;
  structure: string;
  repr_kind: string;
}

/** Every unique candidate in a campaign's event log. */
export function loadCandidates(campaign = "fixture"): CandidateFixture[] {
  const file = path.join(CAMPAIGNS, campaign, "events.jsonl");
  if (!existsSync(file)) return [];
  const seen = new Map<string, CandidateFixture>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event: { body?: { type?: string; candidates?: CandidateFixture[] } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.body?.type !== "candidates.generated") continue;
    for (const c of event.body.candidates ?? []) {
      if (!seen.has(c.id)) seen.set(c.id, c);
    }
  }
  return [...seen.values()];
}

export function findCandidate(id: string): CandidateFixture | undefined {
  for (const campaign of listCampaigns()) {
    const hit = loadCandidates(campaign).find((c) => c.id === id);
    if (hit) return hit;
  }
  return undefined;
}

export function listCampaigns(): string[] {
  if (!existsSync(CAMPAIGNS)) return [];
  return readdirSync(CAMPAIGNS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

export interface ArtifactFile {
  campaign: string;
  file: string;
  name: string;
  payload: Record<string, unknown>;
}

/** Artifacts on disk that are not valid JSON at all. Never silently ignored. */
export const UNPARSEABLE_ARTIFACTS: { file: string; error: string }[] = [];

/** Every artifact JSON across every campaign directory. */
export function loadArtifacts(): ArtifactFile[] {
  const out: ArtifactFile[] = [];
  for (const campaign of listCampaigns()) {
    const dir = path.join(CAMPAIGNS, campaign, "artifacts");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        out.push({
          campaign,
          file,
          name,
          payload: JSON.parse(readFileSync(file, "utf8")),
        });
      } catch (err) {
        // Recorded rather than skipped: a fixture containing a bare `NaN` is
        // not valid JSON, and silently dropping it would let
        // "accepts every real artifact" pass without ever seeing it.
        const key = `${campaign}/${name}`;
        if (!UNPARSEABLE_ARTIFACTS.some((e) => e.file === key)) {
          UNPARSEABLE_ARTIFACTS.push({
            file: key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
  return out;
}

/**
 * Selectors, so the suite survives the campaign directory being reorganised.
 * Tests pick fixtures by the *property they need to exercise* rather than by
 * id — the campaigns were renamed and re-generated mid-build once already, and
 * hardcoded ids turned every geometry test red for reasons unrelated to the
 * code.
 */

/** Every CIF candidate across every campaign. */
export function cifCandidates(): CandidateFixture[] {
  return listCampaigns()
    .flatMap((c) => loadCandidates(c))
    .filter((c) => c.repr_kind === "cif");
}

/** The artifact payload for a candidate, by artifact id prefix. */
export function artifactFor(
  candidateId: string,
  kind: "relax" | "neb",
): ArtifactFile | undefined {
  return loadArtifacts().find((a) => a.name === `a-${kind}-${candidateId}.json`);
}

/** True when a lattice matrix is in the canonical crystallographic setting. */
export function isCanonicalOrientation(cell: number[][]): boolean {
  return (
    Math.abs(cell[0][1]) < 1e-6 &&
    Math.abs(cell[0][2]) < 1e-6 &&
    Math.abs(cell[1][2]) < 1e-6 &&
    cell[0][0] > 0
  );
}

/** Parse the cell block straight out of the CIF text, for cross-checking. */
export function cifDeclaredCell(text: string) {
  const grab = (tag: string) => {
    const m = text.match(new RegExp(`${tag}\\s+(\\S+)`, "i"));
    return m ? Number(m[1]) : NaN;
  };
  return {
    a: grab("_cell_length_a"),
    b: grab("_cell_length_b"),
    c: grab("_cell_length_c"),
    alpha: grab("_cell_angle_alpha"),
    beta: grab("_cell_angle_beta"),
    gamma: grab("_cell_angle_gamma"),
  };
}

/** Parse `_chemical_formula_sum` into element counts. */
export function parseFormulaSum(formula: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const token of formula.trim().split(/\s+/)) {
    const m = token.match(/^([A-Z][a-z]?)(\d*)$/);
    if (!m) continue;
    out[m[1]] = (out[m[1]] ?? 0) + (m[2] ? Number(m[2]) : 1);
  }
  return out;
}
