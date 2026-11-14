"use client";

/**
 * ===========================================================================
 * THE SWAP FILE
 * ===========================================================================
 * Every 3D component the app shell uses is imported from here and nowhere
 * else, so wiring up agents E and F is a one-file change.
 *
 * When `components/three/structure/` and `components/three/abstract/` land,
 * delete the placeholders below and uncomment these two blocks:
 *
 *   export {
 *     StructureView, TrajectoryView, VoidSurface, AdsorptionSites,
 *     ELEMENT_COLORS, ELEMENT_RADII, elementColor,
 *   } from "@/components/three/structure";
 *
 *   export {
 *     ChemicalSpace, ParetoSurface, HypothesisTree,
 *   } from "@/components/three/abstract";
 *
 * The placeholders implement the signatures in
 * `web/components/three/CONTRACT.md` exactly, render something minimal but
 * real, mount no <Canvas> of their own, include no OrbitControls, and return
 * null on missing or malformed data.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type * as THREE from "three";
import { Instance, Instances, Line, Text } from "@react-three/drei";
import { VERDICT_COLOR } from "@/lib/design";

export type Frame = number[][];
export type Cell = number[][] | null;

export interface StructureData {
  symbols: string[];
  cell: Cell;
  pbc: boolean;
  positions: Frame;
}

// --------------------------------------------------------------------------
// Element tables (placeholder — agent E owns the real ones)
// --------------------------------------------------------------------------

export const ELEMENT_COLORS: Record<string, string> = {
  H: "#ffffff",
  Li: "#cc80ff",
  B: "#ffb5b5",
  C: "#909090",
  N: "#3050f8",
  O: "#ff0d0d",
  F: "#90e050",
  Na: "#ab5cf2",
  Mg: "#8aff00",
  Al: "#bfa6a6",
  Si: "#f0c8a0",
  P: "#ff8000",
  S: "#ffff30",
  Cl: "#1ff01f",
  K: "#8f40d4",
  Ca: "#3dff00",
  Ti: "#bfc2c7",
  Fe: "#e06633",
  Cu: "#c88033",
  Zn: "#7d80b0",
  Br: "#a62929",
  Zr: "#94e0e0",
  I: "#940094",
  La: "#70d4ff",
};

export const ELEMENT_RADII: Record<string, number> = {
  H: 0.31,
  Li: 1.28,
  B: 0.84,
  C: 0.76,
  N: 0.71,
  O: 0.66,
  F: 0.57,
  Na: 1.66,
  Mg: 1.41,
  Al: 1.21,
  Si: 1.11,
  P: 1.07,
  S: 1.05,
  Cl: 1.02,
  K: 2.03,
  Ca: 1.76,
  Ti: 1.6,
  Fe: 1.32,
  Cu: 1.32,
  Zn: 1.22,
  Br: 1.2,
  Zr: 1.75,
  I: 1.39,
  La: 1.87,
};

export function elementColor(symbol: string): string {
  return ELEMENT_COLORS[symbol] ?? "#64748b";
}

function elementRadius(symbol: string): number {
  return ELEMENT_RADII[symbol] ?? 1.0;
}

function validFrame(positions: unknown): positions is Frame {
  return (
    Array.isArray(positions) &&
    positions.length > 0 &&
    positions.every(
      (p) => Array.isArray(p) && p.length >= 3 && p.every((n) => typeof n === "number"),
    )
  );
}

// --------------------------------------------------------------------------
// Atoms + cell — shared by the structure and trajectory placeholders
// --------------------------------------------------------------------------

function Atoms({
  symbols,
  positions,
  highlight,
  scale = 0.42,
}: {
  symbols: string[];
  positions: Frame;
  highlight?: number[];
  scale?: number;
}) {
  const bySymbol = useMemo(() => {
    const groups = new Map<string, { index: number; p: number[] }[]>();
    positions.forEach((p, i) => {
      const s = symbols[i] ?? "X";
      const bucket = groups.get(s);
      if (bucket) bucket.push({ index: i, p });
      else groups.set(s, [{ index: i, p }]);
    });
    return [...groups.entries()];
  }, [symbols, positions]);

  return (
    <group>
      {bySymbol.map(([symbol, items]) => (
        <Instances key={symbol} limit={Math.max(items.length, 1)}>
          <sphereGeometry args={[1, 14, 12]} />
          <meshStandardMaterial
            color={elementColor(symbol)}
            roughness={0.45}
            metalness={0.1}
          />
          {items.map(({ index, p }) => {
            const on = highlight?.includes(index);
            const r = elementRadius(symbol) * scale * (on ? 1.5 : 1);
            return (
              <Instance key={index} position={[p[0], p[1], p[2]]} scale={[r, r, r]} />
            );
          })}
        </Instances>
      ))}
    </group>
  );
}

function CellBox({ cell }: { cell: number[][] }) {
  const segments = useMemo(() => {
    const [a, b, c] = cell;
    if (!a || !b || !c) return [];
    const corner = (i: number, j: number, k: number): [number, number, number] => [
      i * a[0] + j * b[0] + k * c[0],
      i * a[1] + j * b[1] + k * c[1],
      i * a[2] + j * b[2] + k * c[2],
    ];
    const edges: [number, number, number][][] = [];
    const nodes: [number, number, number][] = [];
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) nodes.push(corner(i, j, k));
    const idx = (i: number, j: number, k: number) => i * 4 + j * 2 + k;
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++) {
        edges.push([nodes[idx(i, j, 0)], nodes[idx(i, j, 1)]]);
        edges.push([nodes[idx(i, 0, j)], nodes[idx(i, 1, j)]]);
        edges.push([nodes[idx(0, i, j)], nodes[idx(1, i, j)]]);
      }
    return edges;
  }, [cell]);

  return (
    <group>
      {segments.map((pts, i) => (
        <Line key={i} points={pts} color="#334155" lineWidth={1} />
      ))}
    </group>
  );
}

// --------------------------------------------------------------------------
// Agent E placeholders
// --------------------------------------------------------------------------

export function StructureView(props: {
  data: StructureData;
  showCell?: boolean;
  showBonds?: boolean;
  supercell?: [number, number, number];
  highlight?: number[];
  coordination?: number[];
  onPickAtom?: (index: number) => void;
}): React.JSX.Element | null {
  const { data, showCell, highlight } = props;
  if (!data || !validFrame(data.positions)) return null;
  const cellOn = showCell ?? data.pbc;
  return (
    <group>
      <Atoms symbols={data.symbols} positions={data.positions} highlight={highlight} />
      {cellOn && data.cell ? <CellBox cell={data.cell} /> : null}
    </group>
  );
}

export function TrajectoryView(props: {
  symbols: string[];
  cell: Cell;
  pbc: boolean;
  frames: Frame[];
  energies?: number[];
  frameIndex?: number;
  playing?: boolean;
  loop?: boolean;
  fps?: number;
  mobileIndex?: number;
  onFrameChange?: (index: number) => void;
}): React.JSX.Element | null {
  const {
    symbols,
    cell,
    pbc,
    frames,
    frameIndex,
    playing,
    loop = true,
    fps = 12,
    mobileIndex,
    onFrameChange,
  } = props;

  const controlled = frameIndex !== undefined;
  const [auto, setAuto] = useState(0);
  const active = controlled ? frameIndex : auto;
  const isPlaying = playing ?? !controlled;
  const changeRef = useRef(onFrameChange);
  changeRef.current = onFrameChange;

  useEffect(() => {
    if (controlled || !isPlaying || !frames || frames.length < 2) return;
    const id = setInterval(() => {
      setAuto((f) => {
        const next = f + 1;
        if (next >= frames.length) return loop ? 0 : f;
        return next;
      });
    }, 1000 / Math.max(1, fps));
    return () => clearInterval(id);
  }, [controlled, isPlaying, frames, fps, loop]);

  useEffect(() => {
    changeRef.current?.(active ?? 0);
  }, [active]);

  if (!Array.isArray(frames) || frames.length === 0) return null;
  const positions = frames[Math.max(0, Math.min(active ?? 0, frames.length - 1))];
  if (!validFrame(positions)) return null;

  const path =
    mobileIndex !== undefined
      ? frames
          .map((f) => f[mobileIndex])
          .filter((p): p is number[] => Array.isArray(p) && p.length >= 3)
          .map((p) => [p[0], p[1], p[2]] as [number, number, number])
      : [];

  return (
    <group>
      <Atoms
        symbols={symbols}
        positions={positions}
        highlight={mobileIndex !== undefined ? [mobileIndex] : undefined}
      />
      {pbc && cell ? <CellBox cell={cell} /> : null}
      {path.length > 1 ? <Line points={path} color="#38bdf8" lineWidth={3} /> : null}
    </group>
  );
}

export function VoidSurface(props: {
  cell: number[][];
  shape: [number, number, number];
  values: number[];
  isoLevel?: number;
  color?: string;
  opacity?: number;
}): React.JSX.Element | null {
  const { cell, shape, values, isoLevel = 0.5, color = "#38bdf8", opacity = 0.35 } = props;
  const voxels = useMemo(() => {
    if (!cell?.[0] || !Array.isArray(values) || values.length === 0) return [];
    const [nx, ny, nz] = shape;
    if (!nx || !ny || !nz) return [];
    const out: [number, number, number][] = [];
    const stride = Math.max(1, Math.floor(Math.cbrt(values.length / 4000)));
    for (let i = 0; i < nx; i += stride)
      for (let j = 0; j < ny; j += stride)
        for (let k = 0; k < nz; k += stride) {
          const v = values[i * ny * nz + j * nz + k];
          if (typeof v !== "number" || v < isoLevel) continue;
          const fa = i / nx;
          const fb = j / ny;
          const fc = k / nz;
          out.push([
            fa * cell[0][0] + fb * cell[1][0] + fc * cell[2][0],
            fa * cell[0][1] + fb * cell[1][1] + fc * cell[2][1],
            fa * cell[0][2] + fb * cell[1][2] + fc * cell[2][2],
          ]);
        }
    return out;
  }, [cell, shape, values, isoLevel]);

  if (voxels.length === 0) return null;
  return (
    <group>
      <Instances limit={voxels.length}>
        <boxGeometry args={[0.9, 0.9, 0.9]} />
        <meshStandardMaterial color={color} transparent opacity={opacity} />
        {voxels.map((p, i) => (
          <Instance key={i} position={p} />
        ))}
      </Instances>
      <CellBox cell={cell} />
    </group>
  );
}

export function AdsorptionSites(props: {
  host: StructureData;
  guests: { symbols: string[]; positions: Frame; energy_ev?: number }[];
  showHost?: boolean;
}): React.JSX.Element | null {
  const { host, guests, showHost = true } = props;
  if (!host || !validFrame(host.positions)) return null;
  return (
    <group>
      {showHost ? <StructureView data={host} /> : null}
      {(guests ?? []).map((g, i) =>
        validFrame(g.positions) ? (
          <Atoms key={i} symbols={g.symbols} positions={g.positions} scale={0.5} />
        ) : null,
      )}
    </group>
  );
}

// --------------------------------------------------------------------------
// Agent F placeholders
// --------------------------------------------------------------------------

function normalize(points: [number, number, number][], span = 10) {
  if (points.length === 0) return { scale: 1, center: [0, 0, 0] as [number, number, number] };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i]);
      max[i] = Math.max(max[i], p[i]);
    }
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-6);
  return {
    scale: span / extent,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] as [
      number,
      number,
      number,
    ],
  };
}

function AxisTriad({ labels }: { labels?: [string, string, string] }) {
  const L = 6;
  const axes: { to: [number, number, number]; color: string; label?: string }[] = [
    { to: [L, 0, 0], color: "#64748b", label: labels?.[0] },
    { to: [0, L, 0], color: "#64748b", label: labels?.[1] },
    { to: [0, 0, L], color: "#64748b", label: labels?.[2] },
  ];
  return (
    <group>
      {axes.map((a, i) => (
        <group key={i}>
          <Line points={[[0, 0, 0], a.to]} color={a.color} lineWidth={1} />
          {a.label ? (
            <Text
              position={[a.to[0] * 1.08, a.to[1] * 1.08, a.to[2] * 1.08]}
              fontSize={0.5}
              color="#94a3b8"
              anchorX="left"
            >
              {a.label}
            </Text>
          ) : null}
        </group>
      ))}
    </group>
  );
}

export function ChemicalSpace(props: {
  points: Record<string, [number, number, number]>;
  labels?: Record<string, string>;
  axisLabels?: [string, string, string];
  paretoRank?: Record<string, number>;
  selectedId?: string | null;
  flythrough?: boolean;
  onSelect?: (candidateId: string) => void;
}): React.JSX.Element | null {
  const { points, labels, axisLabels, paretoRank, selectedId, onSelect } = props;
  const entries = useMemo(
    () =>
      Object.entries(points ?? {}).filter(
        ([, p]) => Array.isArray(p) && p.length === 3 && p.every((n) => typeof n === "number"),
      ),
    [points],
  );
  const { scale, center } = useMemo(() => normalize(entries.map(([, p]) => p)), [entries]);
  if (entries.length === 0) return null;

  return (
    <group>
      <AxisTriad labels={axisLabels} />
      {entries.map(([id, p]) => {
        const pos: [number, number, number] = [
          (p[0] - center[0]) * scale,
          (p[1] - center[1]) * scale,
          (p[2] - center[2]) * scale,
        ];
        const onFrontier = paretoRank?.[id] === 0;
        const selected = selectedId === id;
        return (
          <group key={id} position={pos}>
            <mesh
              onClick={(e) => {
                e.stopPropagation();
                onSelect?.(id);
              }}
            >
              <sphereGeometry args={[selected ? 0.42 : 0.28, 16, 14]} />
              <meshStandardMaterial
                color={onFrontier ? "#38bdf8" : "#64748b"}
                emissive={selected ? "#38bdf8" : "#000000"}
                emissiveIntensity={selected ? 0.8 : 0}
              />
            </mesh>
            {labels?.[id] ? (
              <Text position={[0, 0.6, 0]} fontSize={0.38} color="#cbd5e1">
                {labels[id]}
              </Text>
            ) : null}
          </group>
        );
      })}
    </group>
  );
}

export function ParetoSurface(props: {
  points: {
    candidate_id: string;
    rank: number;
    values: Record<string, number>;
    scalar_score: number;
  }[];
  axes: [string, string, string];
  axisLabels?: [string, string, string];
  directions?: ("min" | "max" | "target")[];
  selectedId?: string | null;
  onSelect?: (candidateId: string) => void;
}): React.JSX.Element | null {
  const { points, axes, axisLabels, selectedId, onSelect } = props;
  const mapped = useMemo(() => {
    if (!Array.isArray(points)) return [];
    return points
      .map((p) => {
        const v = [p.values?.[axes[0]], p.values?.[axes[1]], p.values?.[axes[2]]];
        if (v.some((n) => typeof n !== "number")) return null;
        return { id: p.candidate_id, rank: p.rank, xyz: v as [number, number, number] };
      })
      .filter((x): x is { id: string; rank: number; xyz: [number, number, number] } =>
        Boolean(x),
      );
  }, [points, axes]);
  const { scale, center } = useMemo(() => normalize(mapped.map((m) => m.xyz)), [mapped]);
  if (mapped.length === 0) return null;

  return (
    <group>
      <AxisTriad labels={axisLabels} />
      {mapped.map((m) => (
        <mesh
          key={m.id}
          position={[
            (m.xyz[0] - center[0]) * scale,
            (m.xyz[1] - center[1]) * scale,
            (m.xyz[2] - center[2]) * scale,
          ]}
          onClick={(e) => {
            e.stopPropagation();
            onSelect?.(m.id);
          }}
        >
          <sphereGeometry args={[m.id === selectedId ? 0.45 : 0.3, 16, 14]} />
          <meshStandardMaterial color={m.rank === 0 ? "#38bdf8" : "#475569"} />
        </mesh>
      ))}
    </group>
  );
}

export function HypothesisTree(props: {
  nodes: {
    id: string;
    parent_id: string | null;
    round: number;
    branch: string;
    statement: string;
    verdict: "SUPPORTED" | "REFUTED" | "INCONCLUSIVE" | null;
  }[];
  selectedId?: string | null;
  onSelect?: (hypothesisId: string) => void;
}): React.JSX.Element | null {
  const { nodes, selectedId, onSelect } = props;
  const laid = useMemo(() => {
    if (!Array.isArray(nodes) || nodes.length === 0) return [];
    const perRound = new Map<number, number>();
    return nodes.map((n) => {
      const col = perRound.get(n.round) ?? 0;
      perRound.set(n.round, col + 1);
      return { ...n, pos: [col * 3 - 1.5, -(n.round - 1) * 3, 0] as [number, number, number] };
    });
  }, [nodes]);

  if (laid.length === 0) return null;
  const byId = new Map(laid.map((n) => [n.id, n]));

  return (
    <group>
      {laid.map((n) => {
        const color = VERDICT_COLOR[n.verdict ?? "OPEN"];
        const dim = n.verdict === "REFUTED";
        const parent = n.parent_id ? byId.get(n.parent_id) : undefined;
        return (
          <group key={n.id}>
            {parent ? (
              <Line
                points={[parent.pos, n.pos]}
                color={color}
                lineWidth={2}
                transparent
                opacity={dim ? 0.25 : 0.8}
              />
            ) : null}
            <mesh
              position={n.pos}
              onClick={(e) => {
                e.stopPropagation();
                onSelect?.(n.id);
              }}
            >
              <icosahedronGeometry args={[n.id === selectedId ? 0.9 : 0.7, 1]} />
              <meshStandardMaterial
                color={color}
                transparent
                opacity={dim ? 0.3 : 1}
                emissive={color}
                emissiveIntensity={dim ? 0.05 : 0.35}
              />
            </mesh>
            <Text
              position={[n.pos[0], n.pos[1] - 1.3, n.pos[2]]}
              fontSize={0.42}
              color={dim ? "#64748b" : "#e2e8f0"}
              maxWidth={6}
              anchorX="center"
            >
              {n.statement.length > 70 ? `${n.statement.slice(0, 70)}…` : n.statement}
            </Text>
          </group>
        );
      })}
    </group>
  );
}

/** Marker the viewer reads so it can say, honestly, that these are stand-ins. */
export const THREE_PLACEHOLDERS = true;

export type ThreeObject3D = THREE.Object3D;
