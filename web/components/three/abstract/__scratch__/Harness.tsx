"use client";

/**
 * Visual harness for the abstract views. Not shipped.
 *
 * It stands in for the app shell: it owns the `<Canvas>`, the lights' ambient
 * background and `OrbitControls`, exactly as CONTRACT.md says the shell does,
 * so the components are exercised through the same seams agent D uses.
 *
 * Run it (without touching anyone else's files) by cloning web/ into a scratch
 * directory, dropping a two-line route that re-exports `HarnessPage`, and
 * starting `next dev -p 3002` there. Scene is chosen with `?scene=`.
 */

import { Suspense, useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { ChemicalSpace } from "../ChemicalSpace";
import { HypothesisTree } from "../HypothesisTree";
import { ParetoSurface } from "../ParetoSurface";
import { VERDICT_COLORS } from "../theme";
import {
  OBJECTIVE_LABELS,
  PARETO_COLLINEAR,
  PARETO_DEGENERATE,
  SYNTHETIC_AXES,
  SYNTHETIC_DIRECTIONS,
  SYNTHETIC_LABELS,
  SYNTHETIC_PARETO,
  SYNTHETIC_POINTS,
  SYNTHETIC_RANKS,
  SYNTHETIC_TREE,
  SYNTHETIC_TREE_EARLIER,
  TREE_BROKEN,
  TREE_CHAIN,
  TREE_SINGLE,
} from "./data";
import {
  FIXTURE_EMBEDDING,
  FIXTURE_HYPOTHESES,
  FIXTURE_OBJECTIVES,
  FIXTURE_PARETO,
  FIXTURE_VERDICTS,
} from "../__tests__/fixtures";

const BG = "#070b12";

const fixtureTree = FIXTURE_HYPOTHESES.map((h) => ({
  id: h.id,
  parent_id: h.parent_id,
  round: h.round,
  branch: h.branch,
  statement: h.statement,
  verdict: (FIXTURE_VERDICTS[h.id] ?? null) as
    | "SUPPORTED"
    | "REFUTED"
    | "INCONCLUSIVE"
    | null,
}));

const fixtureAxes = FIXTURE_OBJECTIVES.map((o) => o.property) as [string, string, string];
const fixtureAxisLabels = FIXTURE_OBJECTIVES.map((o) => `${o.label} (${o.unit})`) as [
  string,
  string,
  string,
];
const fixtureDirections = FIXTURE_OBJECTIVES.map((o) => o.direction) as (
  | "min"
  | "max"
  | "target"
)[];
const fixtureRanks: Record<string, number> = Object.fromEntries(
  FIXTURE_PARETO.map((p) => [p.candidate_id, p.rank]),
);

function Stage({
  camera,
  children,
  autoRotate = false,
}: {
  camera: [number, number, number];
  children: React.ReactNode;
  autoRotate?: boolean;
}) {
  return (
    <Canvas
      camera={{ position: camera, fov: 42 }}
      dpr={[1, 2]}
      gl={{ antialias: true }}
      style={{ background: BG }}
    >
      <Suspense fallback={null}>{children}</Suspense>
      <OrbitControls enableDamping autoRotate={autoRotate} autoRotateSpeed={0.35} />
    </Canvas>
  );
}

function Legend() {
  return (
    <div
      style={{
        position: "absolute",
        left: 20,
        bottom: 18,
        display: "flex",
        gap: 16,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        fontSize: 11,
        letterSpacing: "0.08em",
        color: "#94a3b8",
      }}
    >
      {Object.entries(VERDICT_COLORS).map(([k, v]) => (
        <span key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 8, background: v }} />
          {k}
        </span>
      ))}
    </div>
  );
}

/** Every degenerate input at once, so one page load exercises them all and any
 *  throw shows up as a blank cell plus a console error. */
function EdgeGrid() {
  const cells: { label: string; node: React.ReactNode }[] = [
    { label: "tree · single node", node: <HypothesisTree nodes={TREE_SINGLE} /> },
    { label: "tree · deep chain", node: <HypothesisTree nodes={TREE_CHAIN} /> },
    { label: "tree · broken parents, cycles, NaN", node: <HypothesisTree nodes={TREE_BROKEN} /> },
    { label: "tree · empty", node: <HypothesisTree nodes={[]} /> },
    {
      label: "space · fixture (4 pts, 1 unranked)",
      node: (
        <ChemicalSpace
          points={FIXTURE_EMBEDDING}
          paretoRank={fixtureRanks}
          axisLabels={["Embedding 1", "Embedding 2", "Embedding 3"]}
        />
      ),
    },
    {
      label: "space · NaN and short rows",
      node: (
        <ChemicalSpace
          points={{
            bad: [Number.NaN, 1, 2] as [number, number, number],
            short: [1, 2] as never,
            ok: [1, 2, 3] as [number, number, number],
          }}
        />
      ),
    },
    { label: "space · empty", node: <ChemicalSpace points={{}} /> },
    {
      label: "pareto · fixture (3 frontier pts)",
      node: (
        <ParetoSurface
          points={FIXTURE_PARETO}
          axes={fixtureAxes}
          axisLabels={fixtureAxisLabels}
          directions={fixtureDirections}
        />
      ),
    },
    {
      label: "pareto · 1 frontier pt, dupes, NaN",
      node: (
        <ParetoSurface
          points={PARETO_DEGENERATE}
          axes={["a", "b", "c"]}
          axisLabels={["A", "B", "C"]}
          directions={["min", "min", "max"]}
        />
      ),
    },
    {
      label: "pareto · collinear frontier",
      node: (
        <ParetoSurface
          points={PARETO_COLLINEAR}
          axes={["a", "b", "c"]}
          axisLabels={["A", "B", "C"]}
          directions={["min", "min", "max"]}
        />
      ),
    },
    { label: "pareto · empty", node: <ParetoSurface points={[]} axes={["a", "b", "c"]} /> },
    {
      label: "pareto · axes that match nothing",
      node: <ParetoSurface points={FIXTURE_PARETO} axes={["x", "y", "z"]} />,
    },
  ];
  return (
    <div
      style={{
        position: "absolute",
        inset: "56px 16px 16px",
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gridAutoRows: "1fr",
        gap: 8,
      }}
    >
      {cells.map((c) => (
        <div key={c.label} style={{ position: "relative", border: "1px solid #1e293b" }}>
          <Canvas camera={{ position: [4.2, 2.4, 4.6], fov: 45 }} style={{ background: BG }}>
            <Suspense fallback={null}>{c.node}</Suspense>
            <OrbitControls enableDamping />
          </Canvas>
          <div
            style={{
              position: "absolute",
              left: 8,
              bottom: 6,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 10,
              color: "#64748b",
            }}
          >
            {c.label}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A scripted live campaign: nodes stream in, a verdict lands mid-flight, then
 *  the log is scrubbed back — the three things that must not make the tree
 *  jump, restart its animations, or keep rendering nodes that are gone. */
function LiveTree() {
  const [step, setStep] = useState(1);
  useEffect(() => {
    const id = setInterval(() => setStep((s) => s + 1), 900);
    return () => clearInterval(id);
  }, []);
  const nodes = (() => {
    // 1..10: grow. 11: h3 is refuted. 12: scrub back to five nodes. 13+: regrow.
    if (step <= 10) return SYNTHETIC_TREE.slice(0, step).map((n) => ({ ...n, verdict: null }));
    if (step === 11)
      return SYNTHETIC_TREE.slice(0, 10).map((n) => ({
        ...n,
        verdict: n.id === "h3" || n.id === "h1" ? n.verdict : null,
      }));
    // The scrub state is held for a few ticks: long enough to watch, and to
    // photograph.
    if (step <= 18) return SYNTHETIC_TREE.slice(0, 5);
    return SYNTHETIC_TREE.slice(0, Math.min(SYNTHETIC_TREE.length, step - 13));
  })();
  return (
    <>
      <HypothesisTree nodes={nodes} />
      <Html position={[0, 0, 0]} />
    </>
  );
}

type SceneKey =
  | "tree"
  | "tree-earlier"
  | "tree-fixture"
  | "tree-single"
  | "tree-chain"
  | "tree-broken"
  | "space"
  | "space-fly"
  | "space-fixture"
  | "space-empty"
  | "pareto"
  | "pareto-fixture"
  | "pareto-degenerate"
  | "pareto-collinear"
  | "pareto-empty"
  | "edge"
  | "tree-live";

const SCENES: Record<SceneKey, { label: string; node: React.ReactNode; legend?: boolean }> = {
  tree: {
    label: "Hypothesis tree — 5 rounds, 4 branches, two refuted",
    legend: true,
    node: (
      <Stage camera={[10.5, 3.2, 11.5]} autoRotate>
        <HypothesisTree nodes={SYNTHETIC_TREE} selectedId="h14" />
      </Stage>
    ),
  },
  "tree-earlier": {
    label: "Hypothesis tree — the same campaign, three events earlier",
    legend: true,
    node: (
      <Stage camera={[10.5, 3.2, 11.5]}>
        <HypothesisTree nodes={SYNTHETIC_TREE_EARLIER} />
      </Stage>
    ),
  },
  "tree-fixture": {
    label: "Hypothesis tree — the real fixture campaign (one refuted root)",
    legend: true,
    node: (
      <Stage camera={[3, 1.2, 3.4]}>
        <HypothesisTree nodes={fixtureTree} selectedId="h1" />
      </Stage>
    ),
  },
  "tree-single": {
    label: "Hypothesis tree — a single node",
    node: (
      <Stage camera={[2.4, 1.1, 2.6]}>
        <HypothesisTree nodes={TREE_SINGLE} />
      </Stage>
    ),
  },
  "tree-chain": {
    label: "Hypothesis tree — a deep chain",
    node: (
      <Stage camera={[8, 1.5, 9]}>
        <HypothesisTree nodes={TREE_CHAIN} />
      </Stage>
    ),
  },
  "tree-broken": {
    label: "Hypothesis tree — missing parents, cycles, NaN rounds, duplicates",
    node: (
      <Stage camera={[6, 2, 6.5]}>
        <HypothesisTree nodes={TREE_BROKEN} />
      </Stage>
    ),
  },
  space: {
    label: "Chemical space — 220 candidates, Pareto shells",
    node: (
      <Stage camera={[3.1, 1.9, 3.4]} autoRotate>
        <ChemicalSpace
          points={SYNTHETIC_POINTS}
          labels={SYNTHETIC_LABELS}
          paretoRank={SYNTHETIC_RANKS}
          axisLabels={OBJECTIVE_LABELS}
          selectedId={Object.keys(SYNTHETIC_POINTS)[7]}
        />
      </Stage>
    ),
  },
  "space-fly": {
    label: "Chemical space — flythrough",
    node: (
      <Stage camera={[3.1, 1.9, 3.4]}>
        <ChemicalSpace
          points={SYNTHETIC_POINTS}
          labels={SYNTHETIC_LABELS}
          paretoRank={SYNTHETIC_RANKS}
          axisLabels={OBJECTIVE_LABELS}
          flythrough
        />
      </Stage>
    ),
  },
  "space-fixture": {
    label: "Chemical space — the real fixture (4 points, one unranked)",
    node: (
      <Stage camera={[3.1, 1.9, 3.4]}>
        <ChemicalSpace
          points={FIXTURE_EMBEDDING}
          paretoRank={fixtureRanks}
          axisLabels={["Embedding 1", "Embedding 2", "Embedding 3"]}
        />
      </Stage>
    ),
  },
  "space-empty": {
    label: "Chemical space — empty and malformed input (must render nothing)",
    node: (
      <Stage camera={[3, 2, 3]}>
        <ChemicalSpace points={{}} />
        <ChemicalSpace
          points={{ bad: [Number.NaN, 1, 2] as [number, number, number], short: [1, 2] as never }}
        />
      </Stage>
    ),
  },
  pareto: {
    label: "Pareto surface — 220 candidates, frontier triangulated",
    node: (
      <Stage camera={[3.2, 2.1, 3.4]} autoRotate>
        <ParetoSurface
          points={SYNTHETIC_PARETO}
          axes={SYNTHETIC_AXES}
          axisLabels={OBJECTIVE_LABELS}
          directions={SYNTHETIC_DIRECTIONS}
          selectedId={SYNTHETIC_PARETO[0]?.candidate_id}
        />
      </Stage>
    ),
  },
  "pareto-fixture": {
    label: "Pareto surface — the real fixture (3 frontier points, one triangle)",
    node: (
      <Stage camera={[3.2, 2.1, 3.4]}>
        <ParetoSurface
          points={FIXTURE_PARETO}
          axes={fixtureAxes}
          axisLabels={fixtureAxisLabels}
          directions={fixtureDirections}
        />
      </Stage>
    ),
  },
  "pareto-degenerate": {
    label: "Pareto surface — one frontier point, duplicates, NaN, missing axis",
    node: (
      <Stage camera={[3.2, 2.1, 3.4]}>
        <ParetoSurface
          points={PARETO_DEGENERATE}
          axes={["a", "b", "c"]}
          axisLabels={["A (eV)", "B (eV/atom)", "C (eV)"]}
          directions={["min", "min", "max"]}
        />
      </Stage>
    ),
  },
  "pareto-collinear": {
    label: "Pareto surface — a collinear frontier (polyline fallback)",
    node: (
      <Stage camera={[3.2, 2.1, 3.4]}>
        <ParetoSurface
          points={PARETO_COLLINEAR}
          axes={["a", "b", "c"]}
          axisLabels={["A (eV)", "B (eV/atom)", "C (eV)"]}
          directions={["min", "min", "max"]}
        />
      </Stage>
    ),
  },
  "tree-live": {
    label: "Hypothesis tree — live: growth, a verdict landing, then a scrub back",
    legend: true,
    node: (
      <Stage camera={[10.5, 3.2, 11.5]}>
        <LiveTree />
      </Stage>
    ),
  },
  edge: {
    label: "Edge cases — every degenerate input at once",
    node: <EdgeGrid />,
  },
  "pareto-empty": {
    label: "Pareto surface — empty input (must render nothing)",
    node: (
      <Stage camera={[3, 2, 3]}>
        <ParetoSurface points={[]} axes={["a", "b", "c"]} />
      </Stage>
    ),
  },
};

export function HarnessPage() {
  const [scene, setScene] = useState<SceneKey | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("scene") as SceneKey | null;
    setScene(q && q in SCENES ? q : "tree");
  }, []);

  const active = scene ? SCENES[scene] : null;

  return (
    <div style={{ position: "fixed", inset: 0, background: BG }}>
      {active?.node}
      <div
        style={{
          position: "absolute",
          left: 20,
          top: 16,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          color: "#e2e8f0",
          fontSize: 13,
          letterSpacing: "0.02em",
          textShadow: "0 1px 4px rgba(0,0,0,0.8)",
        }}
      >
        <div style={{ fontSize: 10, letterSpacing: "0.22em", color: "#64748b" }}>ATHANOR</div>
        {active?.label ?? "…"}
      </div>
      {active?.legend && <Legend />}
      <div
        style={{
          position: "absolute",
          right: 16,
          top: 14,
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "flex-end",
          gap: 6,
          maxWidth: 420,
        }}
      >
        {(Object.keys(SCENES) as SceneKey[]).map((k) => (
          <a
            key={k}
            href={`?scene=${k}`}
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 10,
              padding: "3px 7px",
              borderRadius: 3,
              textDecoration: "none",
              color: k === scene ? "#0b1220" : "#94a3b8",
              background: k === scene ? "#cbd5e1" : "rgba(148,163,184,0.12)",
            }}
          >
            {k}
          </a>
        ))}
      </div>
    </div>
  );
}

export default HarnessPage;
