"use client";

/**
 * Coordination polyhedra: the convex hull of an atom's nearest neighbours.
 *
 * This is the shape that carries the chemistry — PS4 tetrahedra in a lithium
 * thiophosphate, ErCl6 octahedra in Li3ErCl6 — so it gets a translucent
 * double-sided solid tinted by the central atom's colour plus a bright edge
 * wireframe, which is what makes the facets legible against a dark background.
 *
 * The hull is computed in `convex-hull.ts` (no library available). Neighbours
 * come from `neighborsOf`, which resolves periodic images, so a polyhedron on
 * the cell boundary is complete rather than sliced in half.
 */

import { useEffect, useMemo } from "react";
import * as THREE from "three";

import { neighborsOf } from "../../../lib/structure-parse";
import { elementColor } from "../elements";
import { convexHullFaces } from "./convex-hull";
import type { Cell, Frame } from "./types";

export interface CoordinationPolyhedraProps {
  symbols: string[];
  positions: Frame;
  cell: Cell;
  pbc: boolean;
  /** Central atom indices. */
  indices: number[];
  opacity?: number;
  /** Only neighbours of a different element count (skips cation-cation). */
  heteroOnly?: boolean;
  maxNeighbors?: number;
}

interface Built {
  geometry: THREE.BufferGeometry;
  edges: THREE.BufferGeometry;
  color: string;
}

export function CoordinationPolyhedra({
  symbols,
  positions,
  cell,
  pbc,
  indices,
  opacity = 0.3,
  heteroOnly = true,
  maxNeighbors = 8,
}: CoordinationPolyhedraProps) {
  const built = useMemo<Built[]>(() => {
    const out: Built[] = [];
    for (const center of indices) {
      const centerSymbol = symbols[center];
      let neighbors = neighborsOf(center, symbols, positions, cell, pbc, {
        maxNeighbors: maxNeighbors + 4,
      });
      if (heteroOnly) {
        neighbors = neighbors.filter((n) => symbols[n.index] !== centerSymbol);
      }
      // Keep the coordination shell: neighbours within 1.35x the closest
      // contact. Beyond that we would be hulling the second shell and the
      // tetrahedron turns into a blob.
      if (neighbors.length === 0) continue;
      const nearest = neighbors[0].distance;
      neighbors = neighbors
        .filter((n) => n.distance <= nearest * 1.35)
        .slice(0, maxNeighbors);
      if (neighbors.length < 4) continue;

      const pts = neighbors.map((n) => n.position as number[]);
      const faces = convexHullFaces(pts);
      if (faces.length === 0) continue;

      const positionsArr = new Float32Array(pts.length * 3);
      for (let i = 0; i < pts.length; i++) {
        positionsArr[i * 3] = pts[i][0];
        positionsArr[i * 3 + 1] = pts[i][1];
        positionsArr[i * 3 + 2] = pts[i][2];
      }
      const index = new Uint16Array(faces.length * 3);
      for (let f = 0; f < faces.length; f++) {
        index[f * 3] = faces[f][0];
        index[f * 3 + 1] = faces[f][1];
        index[f * 3 + 2] = faces[f][2];
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positionsArr, 3));
      geometry.setIndex(new THREE.BufferAttribute(index, 1));
      geometry.computeVertexNormals();

      out.push({
        geometry,
        edges: new THREE.EdgesGeometry(geometry, 1),
        color: elementColor(centerSymbol),
      });
    }
    return out;
  }, [symbols, positions, cell, pbc, indices, heteroOnly, maxNeighbors]);

  // Geometries are created here, so they must be disposed here.
  useEffect(
    () => () => {
      for (const b of built) {
        b.geometry.dispose();
        b.edges.dispose();
      }
    },
    [built],
  );

  if (built.length === 0) return null;

  return (
    <group>
      {built.map((b, i) => (
        <group key={i}>
          <mesh geometry={b.geometry} renderOrder={2}>
            <meshStandardMaterial
              color={b.color}
              transparent
              opacity={opacity}
              roughness={0.35}
              metalness={0.1}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
          <lineSegments geometry={b.edges} renderOrder={3}>
            <lineBasicMaterial
              color={b.color}
              transparent
              opacity={Math.min(1, opacity * 2.4)}
              toneMapped={false}
            />
          </lineSegments>
        </group>
      ))}
    </group>
  );
}
