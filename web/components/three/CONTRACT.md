# 3D component contract

Frozen interface between the app shell (agent D) and the 3D components
(agents E and F). **Do not change a signature here without saying so** — three
agents build against it in parallel. Add optional props freely; never rename or
remove one, and never change what a required prop means.

All components:

- are client components (`"use client"` at the top of the file),
- render **inside** a `<Canvas>` that the app shell owns — so no component here
  mounts its own `<Canvas>`, and none of them import `OrbitControls`,
- take all their data through props and perform no fetching,
- render `null` rather than throwing when data is missing or malformed. A
  campaign is a live stream: every component will be mounted with partial data
  at some point, and one bad frame must not blank the whole scene.

Shared types come from `@/lib/contracts` (generated — do not edit). Artifact
payload shapes are documented on the `Artifact` docstring in
`backend/athanor/contracts.py`; the loader hands you the parsed payload.

## Agent E — `components/three/structure/`

```ts
// Positions are in angstroms. `cell` is a 3x3 row-major lattice matrix, or
// null for an isolated molecule.
export type Frame = number[][];              // [[x, y, z], ...] per atom
export type Cell = number[][] | null;        // [[ax,ay,az],[bx,by,bz],[cx,cy,cz]]

export interface StructureData {
  symbols: string[];
  cell: Cell;
  pbc: boolean;
  positions: Frame;
}

// A static structure: ball-and-stick, plus the unit cell when periodic.
export function StructureView(props: {
  data: StructureData;
  showCell?: boolean;          // default true when pbc
  showBonds?: boolean;         // default true
  supercell?: [number, number, number];  // default [1,1,1]
  highlight?: number[];        // atom indices to emphasize
  coordination?: number[];     // atom indices to draw coordination polyhedra for
  onPickAtom?: (index: number) => void;
}): JSX.Element | null;

// Animated playback over frames (relaxation trajectory or NEB path).
export function TrajectoryView(props: {
  symbols: string[];
  cell: Cell;
  pbc: boolean;
  frames: Frame[];
  energies?: number[];
  frameIndex?: number;         // controlled; when omitted the component autoplays
  playing?: boolean;           // default true when frameIndex is omitted
  loop?: boolean;              // default true
  fps?: number;                // default 12
  mobileIndex?: number;        // draw this atom's path as a tube (NEB)
  onFrameChange?: (index: number) => void;
}): JSX.Element | null;

// Translucent void isosurface for a porous framework.
export function VoidSurface(props: {
  cell: number[][];
  shape: [number, number, number];
  values: number[];            // flat, row-major over shape, 0..1
  isoLevel?: number;           // default 0.5
  color?: string;
  opacity?: number;            // default 0.35
}): JSX.Element | null;

// Guest molecules sitting in adsorption sites.
export function AdsorptionSites(props: {
  host: StructureData;
  guests: { symbols: string[]; positions: Frame; energy_ev?: number }[];
  showHost?: boolean;          // default true
}): JSX.Element | null;
```

Also export, for reuse by agent F and the app shell:

```ts
export const ELEMENT_COLORS: Record<string, string>;  // CPK-style, hex
export const ELEMENT_RADII: Record<string, number>;   // angstroms
export function elementColor(symbol: string): string; // falls back for unknown
```

## Agent F — `components/three/abstract/`

```ts
// Every candidate as a point in 3D property space; camera can fly through it.
export function ChemicalSpace(props: {
  points: Record<string, [number, number, number]>;  // candidate_id -> xyz
  labels?: Record<string, string>;                   // candidate_id -> display name
  axisLabels?: [string, string, string];
  paretoRank?: Record<string, number>;               // 0 = on the frontier
  selectedId?: string | null;
  flythrough?: boolean;        // default false; animates the camera along the cloud
  onSelect?: (candidateId: string) => void;
}): JSX.Element | null;

// The Pareto frontier as a surface, with candidates as points above/on it.
export function ParetoSurface(props: {
  points: { candidate_id: string; rank: number; values: Record<string, number>; scalar_score: number }[];
  axes: [string, string, string];      // which `values` keys map to x, y, z
  axisLabels?: [string, string, string];
  directions?: ("min" | "max" | "target")[];  // per axis, for orientation
  selectedId?: string | null;
  onSelect?: (candidateId: string) => void;
}): JSX.Element | null;

// Hypothesis tree: nodes grow as hypotheses are proposed, and a refuted
// branch goes dark. This is the single most important visual in the product.
export function HypothesisTree(props: {
  nodes: {
    id: string;
    parent_id: string | null;
    round: number;
    branch: string;
    statement: string;
    verdict: "SUPPORTED" | "REFUTED" | "INCONCLUSIVE" | null;  // null = still open
  }[];
  selectedId?: string | null;
  onSelect?: (hypothesisId: string) => void;
}): JSX.Element | null;
```

## Conventions

- **Up is +Y.** Lattice vectors map straight to world axes (a→x, b→y, c→z).
- **Scale:** structures are drawn in angstroms, so the app shell positions the
  camera by the content's bounding sphere. Export nothing that assumes a
  particular camera distance.
- **Colors:** elements use `ELEMENT_COLORS`. Verdict colors are shared:
  supported `#34d399`, refuted `#f87171`, inconclusive `#fbbf24`, open
  `#94a3b8`. Refuted branches additionally drop to ~25% opacity.
- **Performance:** anything that can draw more than ~200 identical meshes must
  use `<Instances>`/`InstancedMesh`, not one mesh per atom. A 300-atom
  supercell with bonds is a normal case.
- **Disposal:** geometries and materials created in a `useMemo` must be
  disposed on unmount, or replaying a campaign repeatedly leaks GPU memory.
