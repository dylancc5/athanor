"use client";

/**
 * `StructureView` — a static crystal or molecule as ball-and-stick, with its
 * unit cell, optional coordination polyhedra, atom picking and highlights.
 *
 * Signature frozen by `components/three/CONTRACT.md`. Optional props beyond
 * the contract are additive only.
 *
 * Renders `null` on missing or malformed data. Validation happens in an outer
 * component so that the inner one can use hooks unconditionally — an early
 * `return null` before a hook would crash the moment live data went from bad
 * to good.
 */

import { useMemo } from "react";

import {
  boundingSphere,
  expandSupercell,
  inferBonds,
} from "../../../lib/structure-parse";
import { IONIC_CATIONS, elementColor, elementRadius } from "../elements";
import { AtomInstances } from "./AtomInstances";
import { BondInstances } from "./BondInstances";
import { CoordinationPolyhedra } from "./CoordinationPolyhedra";
import { StructureLights } from "./Lights";
import { UnitCell } from "./UnitCell";
import { normalizeIndices, normalizeStructure, normalizeSupercell } from "./normalize";
import type { StructureData } from "./types";

export interface StructureViewProps {
  data: StructureData;
  /** Default true when the structure is periodic. */
  showCell?: boolean;
  /** Default true. */
  showBonds?: boolean;
  /** Default [1, 1, 1]. */
  supercell?: [number, number, number];
  /** Atom indices to emphasise. */
  highlight?: number[];
  /** Atom indices to draw coordination polyhedra for. */
  coordination?: number[];
  onPickAtom?: (index: number) => void;

  // --- additive options (not in the frozen contract) -------------------
  /** Mount the default light rig. Set false when an outer view supplies one. */
  lights?: boolean;
  /** Multiplies element display radii. */
  radiusScale?: number;
  bondRadius?: number;
  /**
   * Elements drawn as free ions with no sticks. Defaults to the alkali and
   * alkaline-earth metals: Li-S at ~2.4 A is inside 1.15x the covalent sum,
   * so without this a lithium thiophosphate becomes a hairball and the PS4
   * tetrahedra disappear.
   */
  bondExclude?: readonly string[];
  /** Bond length tolerance as a multiple of the covalent radius sum. */
  bondTolerance?: number;
  /** Draw a/b/c arrows with the cell. Default true. */
  showAxes?: boolean;
  atomOpacity?: number;
}

export function StructureView(props: StructureViewProps) {
  const data = useMemo(() => normalizeStructure(props.data), [props.data]);
  if (!data) return null;
  return <StructureViewInner {...props} data={data} />;
}

function StructureViewInner({
  data,
  showCell,
  showBonds = true,
  supercell,
  highlight,
  coordination,
  onPickAtom,
  lights = true,
  radiusScale = 1,
  bondRadius = 0.11,
  bondExclude = IONIC_CATIONS,
  bondTolerance = 1.15,
  showAxes = true,
  atomOpacity = 1,
}: StructureViewProps & { data: StructureData }) {
  const repeat = useMemo(
    () => normalizeSupercell(supercell, data.positions.length),
    [supercell, data.positions.length],
  );

  const expanded = useMemo(
    () => expandSupercell(data, repeat[0], repeat[1], repeat[2]),
    [data, repeat],
  );

  const bonds = useMemo(() => {
    if (!showBonds) return [];
    return inferBonds(expanded.symbols, expanded.positions, expanded.cell, expanded.pbc, {
      tolerance: bondTolerance,
      exclude: bondExclude,
    });
  }, [expanded, showBonds, bondTolerance, bondExclude]);

  const natoms = expanded.positions.length;
  const cellsPerStructure = data.positions.length;

  /**
   * Highlight and coordination indices refer to the *original* cell. In a
   * supercell every image of the atom is highlighted, which is what you want
   * when pointing at "the Li site".
   */
  const highlightIndices = useMemo(() => {
    const base = normalizeIndices(highlight, cellsPerStructure);
    if (base.length === 0) return [];
    const out: number[] = [];
    const images = natoms / cellsPerStructure;
    for (let img = 0; img < images; img++) {
      for (const i of base) out.push(img * cellsPerStructure + i);
    }
    return out;
  }, [highlight, cellsPerStructure, natoms]);

  const coordinationIndices = useMemo(() => {
    const base = normalizeIndices(coordination, cellsPerStructure);
    if (base.length === 0) return [];
    const out: number[] = [];
    const images = natoms / cellsPerStructure;
    for (let img = 0; img < images; img++) {
      for (const i of base) out.push(img * cellsPerStructure + i);
    }
    return out;
  }, [coordination, cellsPerStructure, natoms]);

  const highlightData = useMemo(() => {
    if (highlightIndices.length === 0) return null;
    const positions = highlightIndices.map((i) => expanded.positions[i]);
    const symbols = highlightIndices.map((i) => expanded.symbols[i]);
    const radii = symbols.map((s) => elementRadius(s) * radiusScale * 1.45);
    const colors = symbols.map((s) => elementColor(s));
    return { positions, symbols, radii, colors };
  }, [highlightIndices, expanded, radiusScale]);

  const drawCell = (showCell ?? expanded.pbc) && expanded.cell != null;

  /**
   * Picking reports an index into the *original* cell, matching what
   * `highlight` and `coordination` take. Without the modulo, clicking an atom
   * in the second image of a supercell returns an index the caller cannot
   * feed back in.
   */
  const handlePick = useMemo(
    () =>
      onPickAtom ? (index: number) => onPickAtom(index % cellsPerStructure) : undefined,
    [onPickAtom, cellsPerStructure],
  );

  return (
    <group>
      {lights && <StructureLights />}

      <AtomInstances
        symbols={expanded.symbols}
        positions={expanded.positions}
        radiusScale={radiusScale}
        opacity={atomOpacity}
        onPickAtom={handlePick}
      />

      {bonds.length > 0 && (
        <BondInstances
          symbols={expanded.symbols}
          positions={expanded.positions}
          bonds={bonds}
          cell={expanded.cell}
          radius={bondRadius}
          opacity={atomOpacity}
        />
      )}

      {/* Highlight shells: additive halos that read at any zoom without
          hiding the atom underneath. */}
      {highlightData && (
        <AtomInstances
          symbols={highlightData.symbols}
          positions={highlightData.positions}
          radii={highlightData.radii}
          colors={highlightData.colors}
          opacity={0.3}
          segments={[20, 14]}
          roughness={0.9}
          metalness={0}
        />
      )}

      {coordinationIndices.length > 0 && (
        <CoordinationPolyhedra
          symbols={expanded.symbols}
          positions={expanded.positions}
          cell={expanded.cell}
          pbc={expanded.pbc}
          indices={coordinationIndices}
        />
      )}

      {drawCell && (
        <UnitCell
          cell={data.cell as number[][]}
          repeat={repeat}
          showAxes={showAxes}
        />
      )}
    </group>
  );
}

/**
 * Convenience re-export for the app shell: the sphere the camera should frame.
 * Mirrors what `StructureView` actually draws, including the supercell.
 */
export function structureBoundingSphere(
  data: StructureData,
  supercell?: [number, number, number],
) {
  const normalized = normalizeStructure(data);
  if (!normalized) return { center: [0, 0, 0] as [number, number, number], radius: 1 };
  const repeat = normalizeSupercell(supercell, normalized.positions.length);
  const expanded = expandSupercell(normalized, repeat[0], repeat[1], repeat[2]);
  return boundingSphere(expanded);
}
