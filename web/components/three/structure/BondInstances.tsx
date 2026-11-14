"use client";

/**
 * Instanced bond cylinders.
 *
 * Every bond is drawn as **two** half-cylinders, each coloured by the atom it
 * starts from and meeting flush at the bond midpoint. That is what makes a
 * ball-and-stick model readable at a glance — a single grey stick between an
 * orange P and a yellow S tells you much less.
 *
 * One `InstancedMesh` holds all halves. Bond *topology* is fixed by the caller
 * (inferred once, with periodic image shifts) and only the endpoints are
 * rewritten per animation frame, so bonds never pop in and out mid-playback.
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import * as THREE from "three";

import { elementColor } from "../elements";
import { applyMat3, isValidCell } from "../../../lib/structure-parse";
import type { Bond, Cell, Frame } from "./types";

export interface BondInstancesHandle {
  setPositions: (flat: Float32Array | number[][]) => void;
}

export interface BondInstancesProps {
  symbols: string[];
  positions: Frame;
  bonds: Bond[];
  cell: Cell;
  radius?: number;
  segments?: number;
  opacity?: number;
  /**
   * Bonds longer than this are skipped at draw time. Guards against an atom
   * drifting mid-trajectory and leaving a stick stretched across the cell.
   */
  maxDrawLength?: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();

export const BondInstances = forwardRef<BondInstancesHandle, BondInstancesProps>(
  function BondInstances(
    {
      symbols,
      positions,
      bonds,
      cell,
      radius = 0.11,
      segments = 10,
      opacity = 1,
      maxDrawLength = 4.2,
    },
    ref,
  ) {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    const count = bonds.length * 2;

    /**
     * A unit cylinder of height 1 centred on the origin, aligned +Y. Open
     * ended: both caps are either buried in an atom sphere or flush against
     * the other half, so caps would only cost triangles.
     */
    const geometry = useMemo(
      () => new THREE.CylinderGeometry(1, 1, 1, segments, 1, true),
      [segments],
    );
    const material = useMemo(
      () =>
        new THREE.MeshStandardMaterial({
          roughness: 0.5,
          metalness: 0.05,
          transparent: opacity < 1,
          opacity,
          depthWrite: opacity >= 1,
        }),
      [opacity],
    );

    useEffect(() => () => geometry.dispose(), [geometry]);
    useEffect(() => () => material.dispose(), [material]);

    /** Precomputed Cartesian lattice translation per bond. */
    const shifts = useMemo(() => {
      const out = new Float32Array(bonds.length * 3);
      if (!isValidCell(cell)) return out;
      const m = cell as number[][];
      for (let b = 0; b < bonds.length; b++) {
        const s = bonds[b].shift;
        if (s[0] === 0 && s[1] === 0 && s[2] === 0) continue;
        const t = applyMat3([s[0], s[1], s[2]], m);
        out[b * 3] = t[0];
        out[b * 3 + 1] = t[1];
        out[b * 3 + 2] = t[2];
      }
      return out;
    }, [bonds, cell]);

    const writeMatrices = (src: Float32Array | number[][]) => {
      const mesh = meshRef.current;
      if (!mesh) return;
      const flat = src instanceof Float32Array;
      const get = (i: number, k: number) =>
        flat ? (src as Float32Array)[i * 3 + k] : (src as number[][])[i][k];

      for (let b = 0; b < bonds.length; b++) {
        const { i, j } = bonds[b];
        const ax = get(i, 0);
        const ay = get(i, 1);
        const az = get(i, 2);
        const bx = get(j, 0) + shifts[b * 3];
        const by = get(j, 1) + shifts[b * 3 + 1];
        const bz = get(j, 2) + shifts[b * 3 + 2];

        _dir.set(bx - ax, by - ay, bz - az);
        const len = _dir.length();
        const half = len / 2;

        if (len < 1e-6 || len > maxDrawLength) {
          // Collapse to nothing rather than drawing a wrong stick.
          _m.makeScale(0, 0, 0);
          mesh.setMatrixAt(b * 2, _m);
          mesh.setMatrixAt(b * 2 + 1, _m);
          continue;
        }

        _dir.multiplyScalar(1 / len);
        _q.setFromUnitVectors(_up, _dir);
        _scale.set(radius, half, radius);

        // Half from atom i: centred a quarter of the way along.
        _pos.set(ax + _dir.x * half * 0.5, ay + _dir.y * half * 0.5, az + _dir.z * half * 0.5);
        _m.compose(_pos, _q, _scale);
        mesh.setMatrixAt(b * 2, _m);

        // Half from atom j: centred three quarters along.
        _pos.set(
          ax + _dir.x * half * 1.5,
          ay + _dir.y * half * 1.5,
          az + _dir.z * half * 1.5,
        );
        _m.compose(_pos, _q, _scale);
        mesh.setMatrixAt(b * 2 + 1, _m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };

    useEffect(() => {
      const mesh = meshRef.current;
      if (!mesh) return;
      for (let b = 0; b < bonds.length; b++) {
        _color.set(elementColor(symbols[bonds[b].i]));
        mesh.setColorAt(b * 2, _color);
        _color.set(elementColor(symbols[bonds[b].j]));
        mesh.setColorAt(b * 2 + 1, _color);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }, [bonds, symbols]);

    useEffect(() => {
      writeMatrices(positions);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [positions, bonds, shifts, radius]);

    useImperativeHandle(
      ref,
      () => ({ setPositions: writeMatrices }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [bonds, shifts, radius],
    );

    if (count === 0) return null;

    return (
      <instancedMesh
        key={count}
        ref={meshRef}
        args={[geometry, material, count]}
        frustumCulled={false}
      />
    );
  },
);
