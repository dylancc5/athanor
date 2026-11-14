"use client";

/**
 * Instanced atom spheres.
 *
 * One `InstancedMesh` for the whole structure: a 300-atom supercell is a
 * normal case and one mesh per atom would stall. Matrices and colours are
 * written directly through refs rather than through drei's `<Instance>`
 * children, so an animating trajectory does not push React through a
 * reconciliation pass on every frame.
 *
 * Exposed as a ref handle (`AtomInstancesHandle`) so `TrajectoryView` can
 * rewrite positions from inside `useFrame` without re-rendering.
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";

import { elementColor, elementRadius } from "../elements";
import type { Frame } from "./types";

export interface AtomInstancesHandle {
  /** Rewrite every instance matrix from a flat Float32Array of xyz triples. */
  setPositions: (flat: Float32Array | number[][]) => void;
  mesh: THREE.InstancedMesh | null;
}

export interface AtomInstancesProps {
  symbols: string[];
  positions: Frame;
  /** Multiplies the element display radius. 1 = ball-and-stick default. */
  radiusScale?: number;
  /** Per-atom radius override, in angstroms. */
  radii?: number[];
  /** Per-atom colour override, as hex strings. */
  colors?: (string | undefined)[];
  /** Sphere tessellation. 24x16 reads as smooth at video resolution. */
  segments?: [number, number];
  opacity?: number;
  roughness?: number;
  metalness?: number;
  onPickAtom?: (index: number) => void;
}

const _m = new THREE.Matrix4();
const _color = new THREE.Color();

export const AtomInstances = forwardRef<AtomInstancesHandle, AtomInstancesProps>(
  function AtomInstances(
    {
      symbols,
      positions,
      radiusScale = 1,
      radii,
      colors,
      segments = [24, 16],
      opacity = 1,
      roughness = 0.38,
      metalness = 0.12,
      onPickAtom,
    },
    ref,
  ) {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    const count = Math.min(symbols.length, positions.length);

    const geometry = useMemo(
      () => new THREE.SphereGeometry(1, segments[0], segments[1]),
      [segments[0], segments[1]],
    );
    const material = useMemo(
      () =>
        new THREE.MeshStandardMaterial({
          roughness,
          metalness,
          transparent: opacity < 1,
          opacity,
          depthWrite: opacity >= 1,
        }),
      [roughness, metalness, opacity],
    );

    // Dispose what we allocated, or replaying a campaign leaks GPU memory.
    useEffect(() => () => geometry.dispose(), [geometry]);
    useEffect(() => () => material.dispose(), [material]);

    /** Per-instance radius, resolved once. */
    const scales = useMemo(() => {
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        out[i] = (radii?.[i] ?? elementRadius(symbols[i])) * radiusScale;
      }
      return out;
    }, [symbols, radii, radiusScale, count]);

    const writeMatrices = (src: Float32Array | number[][]) => {
      const mesh = meshRef.current;
      if (!mesh) return;
      const flat = src instanceof Float32Array;
      for (let i = 0; i < count; i++) {
        const x = flat ? src[i * 3] : (src as number[][])[i][0];
        const y = flat ? src[i * 3 + 1] : (src as number[][])[i][1];
        const z = flat ? src[i * 3 + 2] : (src as number[][])[i][2];
        const s = scales[i];
        _m.makeScale(s, s, s);
        _m.setPosition(x, y, z);
        mesh.setMatrixAt(i, _m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };

    // Colours must be written before the first render or instanceColor stays
    // unallocated and every instance silently draws white.
    useEffect(() => {
      const mesh = meshRef.current;
      if (!mesh) return;
      for (let i = 0; i < count; i++) {
        _color.set(colors?.[i] ?? elementColor(symbols[i]));
        mesh.setColorAt(i, _color);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }, [symbols, colors, count]);

    useEffect(() => {
      writeMatrices(positions);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [positions, scales, count]);

    useImperativeHandle(
      ref,
      () => ({
        setPositions: writeMatrices,
        get mesh() {
          return meshRef.current;
        },
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [scales, count],
    );

    const handleClick = onPickAtom
      ? (e: ThreeEvent<MouseEvent>) => {
          if (e.instanceId == null) return;
          e.stopPropagation();
          onPickAtom(e.instanceId);
        }
      : undefined;

    if (count === 0) return null;

    return (
      <instancedMesh
        key={count}
        ref={meshRef}
        args={[geometry, material, count]}
        // The cached bounding sphere is computed before matrices are written,
        // so leaving culling on makes the whole structure vanish at some
        // camera angles.
        frustumCulled={false}
        onClick={handleClick}
      />
    );
  },
);
