"use client";

/**
 * `VoidSurface` — a translucent isosurface of the pore space in a porous
 * framework, extracted from a scalar grid.
 *
 * Signature frozen by `components/three/CONTRACT.md`.
 *
 * The isosurface itself comes from `marching-cubes.ts` (marching tetrahedra,
 * written from scratch — no library is available). The grid is interpreted in
 * fractional cell coordinates and transformed by the lattice matrix, so the
 * surface sits correctly inside a non-orthogonal cell.
 *
 * Material notes: the point of this view is to see the pore *and* the
 * framework inside it, so the surface is rendered
 *  - `transparent` with `depthWrite={false}` so the framework behind it is
 *    never occluded by depth,
 *  - `side={DoubleSide}` so you can fly the camera into the pore and still
 *    see the wall from inside,
 *  - with a Fresnel-ish rim achieved by a second, slightly inflated
 *    additive shell — a flat alpha blend reads as fog, whereas an edge-lit
 *    surface reads as a cavity with a shape.
 */

import { useEffect, useMemo } from "react";
import * as THREE from "three";

import { marchingTetrahedra } from "./marching-cubes";
import { normalizeVoidGrid } from "./normalize";

export interface VoidSurfaceProps {
  cell: number[][];
  shape: [number, number, number];
  /** Flat, row-major over `shape`, 0..1. */
  values: number[];
  /** Default 0.5. */
  isoLevel?: number;
  color?: string;
  /** Default 0.35. */
  opacity?: number;

  // --- additive options (not in the frozen contract) -------------------
  /** Draw the inflated additive rim shell. Default true. */
  rim?: boolean;
  /** Also draw a faint wireframe over the surface. Default false. */
  wireframe?: boolean;
}

export function VoidSurface(props: VoidSurfaceProps) {
  const grid = useMemo(
    () => normalizeVoidGrid({ cell: props.cell, shape: props.shape, values: props.values }),
    [props.cell, props.shape, props.values],
  );
  if (!grid) return null;
  return <VoidSurfaceInner {...props} />;
}

function VoidSurfaceInner({
  cell,
  shape,
  values,
  isoLevel = 0.5,
  color = "#38bdf8",
  opacity = 0.35,
  rim = true,
  wireframe = false,
}: VoidSurfaceProps) {
  const geometry = useMemo(() => {
    const grid = normalizeVoidGrid({ cell, shape, values });
    if (!grid) return null;
    const iso = Number.isFinite(isoLevel) ? isoLevel : 0.5;
    const result = marchingTetrahedra(grid.values, grid.shape, grid.cell, iso);
    if (!result) return null;

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(result.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));
    g.setIndex(new THREE.BufferAttribute(result.indices, 1));
    g.computeBoundingSphere();
    return g;
  }, [cell, shape, values, isoLevel]);

  useEffect(() => {
    if (!geometry) return;
    return () => geometry.dispose();
  }, [geometry]);

  if (!geometry) return null;

  return (
    <group>
      <mesh geometry={geometry} renderOrder={6}>
        <meshStandardMaterial
          color={color}
          transparent
          opacity={opacity}
          roughness={0.22}
          metalness={0.0}
          // Front faces only. The rim pass below draws the back faces, so
          // DoubleSide here would render every back face twice at exactly the
          // same depth and stipple the whole surface with z-fighting.
          side={rim ? THREE.FrontSide : THREE.DoubleSide}
          // Without this the surface hides the framework it is supposed to
          // wrap around, because the nearest translucent fragment still
          // writes depth.
          depthWrite={false}
        />
      </mesh>

      {rim && (
        <mesh geometry={geometry} renderOrder={7}>
          <meshBasicMaterial
            color={color}
            transparent
            opacity={opacity * 0.45}
            blending={THREE.AdditiveBlending}
            side={THREE.BackSide}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}

      {wireframe && (
        <mesh geometry={geometry} renderOrder={8}>
          <meshBasicMaterial
            color={color}
            wireframe
            transparent
            opacity={0.12}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}
    </group>
  );
}
