/**
 * Payloads lifted verbatim from `campaigns/fixture/events.jsonl` (a real
 * recorded campaign). Do not "tidy" the numbers: the point is to test the
 * components on real data. The fixture's `migration_barrier` values are known
 * to be wrong while the backend regenerates them, which is exactly why nothing
 * in these components hardcodes an axis range.
 */

export const FIXTURE_EMBEDDING = {
  "c-mp-1097036": [
    13.227,
    2.822,
    0.138
  ],
  "c-mp-676361": [
    19.414,
    5.211,
    0.02
  ],
  "c-mp-985583": [
    14.659,
    2.81,
    0.0
  ],
  "c-mp-985584": [
    0.0,
    2.288,
    0.07100000000000001
  ]
} as Record<string, [number, number, number]>;

export const FIXTURE_PARETO = [
  {
    "candidate_id": "c-mp-985583",
    "rank": 0,
    "values": {
      "energy_above_hull": 0.0,
      "band_gap": 2.81,
      "migration_barrier": 14.659
    },
    "scalar_score": 0.634273
  },
  {
    "candidate_id": "c-mp-1097036",
    "rank": 0,
    "values": {
      "energy_above_hull": 0.0138,
      "band_gap": 2.822,
      "migration_barrier": 13.227
    },
    "scalar_score": 0.501249
  },
  {
    "candidate_id": "c-mp-676361",
    "rank": 0,
    "values": {
      "energy_above_hull": 0.002,
      "band_gap": 5.211,
      "migration_barrier": 19.414
    },
    "scalar_score": 0.463768
  }
];

export const FIXTURE_OBJECTIVES = [
  {
    "property": "migration_barrier",
    "label": "Li migration barrier",
    "direction": "min",
    "target": null,
    "weight": 2.0,
    "unit": "eV"
  },
  {
    "property": "energy_above_hull",
    "label": "Energy above hull",
    "direction": "min",
    "target": null,
    "weight": 1.0,
    "unit": "eV/atom"
  },
  {
    "property": "band_gap",
    "label": "Band gap (electrochemical window proxy)",
    "direction": "max",
    "target": null,
    "weight": 1.0,
    "unit": "eV"
  }
];

export const FIXTURE_HYPOTHESES = [
  {
    "id": "h1",
    "parent_id": null,
    "round": 1,
    "branch": "main",
    "statement": "Among near-hull lithium thiophosphates, a lower energy above hull predicts a lower Li migration barrier, because a well-ordered lattice gives cleaner migration channels.",
    "rationale": "Stability and ionic conductivity are usually discussed as a trade-off. If they in fact move together across this family, the search collapses to one axis and we can screen on stability alone.",
    "prediction": "Barrier should correlate positively with energy above hull across the seed set (Spearman rho > 0.5).",
    "falsification_criterion": "If the most stable seed does not have the lowest barrier, or the correlation is absent or inverted, the hypothesis is refuted.",
    "batch_plan": {
      "n_candidates": 4,
      "strategy": "Score every retrieved seed on both axes; no perturbations yet.",
      "properties": [
        "migration_barrier",
        "energy_above_hull",
        "band_gap"
      ]
    }
  }
];

export const FIXTURE_VERDICTS: Record<string, "SUPPORTED" | "REFUTED" | "INCONCLUSIVE"> =
  Object.fromEntries([
  {
    "hypothesis_id": "h1",
    "verdict": "REFUTED"
  }
].map((v) => [v.hypothesis_id, v.verdict])) as Record<
    string,
    "SUPPORTED" | "REFUTED" | "INCONCLUSIVE"
  >;
