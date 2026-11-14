"use client";

/**
 * ===========================================================================
 * THE SWAP FILE — the one place the app shell imports 3D components from.
 * ===========================================================================
 * Real, landed modules are re-exported straight through:
 *   - element tables / colors / radii                -> three/elements  (agent E)
 *   - HypothesisTree, ChemicalSpace, ParetoSurface   -> three/abstract  (agent F)
 *
 * Still placeholders, pending agent E:
 *   StructureView, TrajectoryView, VoidSurface, AdsorptionSites
 *
 * To swap one in, delete its placeholder below and add it to the re-export
 * block above. Nothing outside this file changes.
 *
 * Every placeholder implements the signature in
 * `web/components/three/CONTRACT.md` exactly, mounts no <Canvas>, includes no
 * OrbitControls, and returns null on missing or malformed data.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Instance, Instances, Line } from "@react-three/drei";

// Agent E owns these: real CPK colors, covalent/vdW radii, element normalization.
export {
  ELEMENT_COLORS,
  ELEMENT_RADII,
  elementColor,
  elementRadius,
  covalentRadius,
  vdwRadius,
  normalizeElement,
} from "@/components/three/elements";
import { elementColor, elementRadius } from "@/components/three/elements";

// Agent F's abstract views are all real now — imported, not stubbed.
export {
  HypothesisTree,
  ChemicalSpace,
  ParetoSurface,
  type HypothesisTreeProps,
  type ChemicalSpaceProps,
  type ParetoSurfaceProps,
} from "@/components/three/abstract";

export type {
  Bond,
  BoundingSphere,
  Cell,
  Frame,
  StructureData,
  TrajectoryData,
  Vec3,
} from "@/components/three/structure/types";
import type { Cell, Frame, StructureData } from "@/components/three/structure/types";

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

/** Views still drawn by stand-ins, so the shell can be honest about it. */
export const PLACEHOLDER_VIEWS = ["structure", "trajectory", "void"] as const;
