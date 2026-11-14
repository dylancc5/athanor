"use client";

/**
 * The unit cell: a wireframe parallelepiped plus the three lattice vectors.
 *
 * The box is drawn with `LineSegments2` (via drei's `<Line>`), which gives
 * screen-space line width — plain `THREE.Line` is locked to 1px on most
 * platforms and reads as a faint scratch at video resolution.
 *
 * The three lattice vectors a, b, c are drawn over the box in red/green/blue
 * with cone tips and labels, so an orientation is readable from a still frame.
 * Those three edges are drawn *in place of* the corresponding box edges rather
 * than on top of them, which is what would otherwise z-fight.
 */

import { useMemo } from "react";
import { Billboard, Line, Text } from "@react-three/drei";

import { TEXT_FONT_PROPS } from "./font";

import { applyMat3 } from "../../../lib/structure-parse";
import type { Vec3 } from "./types";

export interface UnitCellProps {
  cell: number[][];
  /** How many cells along a, b, c — draws the inner divisions too. */
  repeat?: [number, number, number];
  color?: string;
  opacity?: number;
  lineWidth?: number;
  /** Draw the a/b/c vectors with coloured arrows and labels. */
  showAxes?: boolean;
}

const AXIS_COLORS = ["#ff6b6b", "#6bdd7a", "#6ba8ff"] as const;
const AXIS_LABELS = ["a", "b", "c"] as const;

export function UnitCell({
  cell,
  repeat = [1, 1, 1],
  color = "#7f8ea3",
  opacity = 0.75,
  lineWidth = 1.4,
  showAxes = true,
}: UnitCellProps) {
  const { boxPoints, axes, scale } = useMemo(() => {
    const corner = (i: number, j: number, k: number): Vec3 =>
      applyMat3([i, j, k], cell);

    const [ra, rb, rc] = repeat;
    const segs: Vec3[] = [];

    // Outer box: 12 edges of the (ra, rb, rc) parallelepiped.
    const push = (p: Vec3, q: Vec3) => {
      segs.push(p, q);
    };
    for (let j = 0; j <= 1; j++) {
      for (let k = 0; k <= 1; k++) {
        push(corner(0, j * rb, k * rc), corner(ra, j * rb, k * rc));
      }
    }
    for (let i = 0; i <= 1; i++) {
      for (let k = 0; k <= 1; k++) {
        push(corner(i * ra, 0, k * rc), corner(i * ra, rb, k * rc));
      }
    }
    for (let i = 0; i <= 1; i++) {
      for (let j = 0; j <= 1; j++) {
        push(corner(i * ra, j * rb, 0), corner(i * ra, j * rb, rc));
      }
    }

    // The three vectors from the origin are replaced by the axis arrows, so
    // drop them from the wireframe to avoid two lines in the same place.
    const axisEdges = showAxes
      ? [
          [corner(0, 0, 0), corner(ra, 0, 0)],
          [corner(0, 0, 0), corner(0, rb, 0)],
          [corner(0, 0, 0), corner(0, 0, rc)],
        ]
      : [];
    const sameAs = (p: Vec3, q: Vec3) =>
      Math.abs(p[0] - q[0]) < 1e-9 &&
      Math.abs(p[1] - q[1]) < 1e-9 &&
      Math.abs(p[2] - q[2]) < 1e-9;
    const filtered: Vec3[] = [];
    for (let s = 0; s < segs.length; s += 2) {
      const dup = axisEdges.some(
        ([p, q]) => sameAs(segs[s], p) && sameAs(segs[s + 1], q),
      );
      if (!dup) filtered.push(segs[s], segs[s + 1]);
    }

    const vecs: Vec3[] = [
      applyMat3([ra, 0, 0], cell),
      applyMat3([0, rb, 0], cell),
      applyMat3([0, 0, rc], cell),
    ];
    const longest = Math.max(
      ...vecs.map((v) => Math.hypot(v[0], v[1], v[2])),
      1,
    );

    return { boxPoints: filtered, axes: vecs, scale: longest };
  }, [cell, repeat, showAxes]);

  // Arrow head and label sizes track the cell, so a 6 A cell and a 30 A
  // supercell both look right without a magic constant.
  const headLength = Math.min(1.1, scale * 0.07);
  const headRadius = headLength * 0.34;
  const fontSize = Math.max(0.45, scale * 0.055);

  return (
    <group>
      {boxPoints.length >= 2 && (
        <Line
          points={boxPoints}
          segments
          color={color}
          lineWidth={lineWidth}
          transparent
          opacity={opacity}
          // Cell edges often sit exactly on an isosurface boundary; nudging
          // the depth test keeps them from stitching in and out.
          polygonOffset
          polygonOffsetFactor={-2}
          toneMapped={false}
        />
      )}

      {showAxes &&
        axes.map((v, i) => {
          const len = Math.hypot(v[0], v[1], v[2]);
          if (!(len > 1e-6)) return null;
          const dir: Vec3 = [v[0] / len, v[1] / len, v[2] / len];
          const shaftEnd: Vec3 = [
            dir[0] * (len - headLength),
            dir[1] * (len - headLength),
            dir[2] * (len - headLength),
          ];
          const tip: Vec3 = [
            dir[0] * (len - headLength / 2),
            dir[1] * (len - headLength / 2),
            dir[2] * (len - headLength / 2),
          ];
          const labelAt: Vec3 = [
            v[0] + dir[0] * fontSize * 1.1,
            v[1] + dir[1] * fontSize * 1.1,
            v[2] + dir[2] * fontSize * 1.1,
          ];
          return (
            <group key={AXIS_LABELS[i]}>
              <Line
                points={[[0, 0, 0], shaftEnd]}
                color={AXIS_COLORS[i]}
                lineWidth={lineWidth * 1.8}
                toneMapped={false}
              />
              <mesh position={tip} quaternion={quaternionTo(dir)}>
                <coneGeometry args={[headRadius, headLength, 14]} />
                <meshBasicMaterial color={AXIS_COLORS[i]} toneMapped={false} />
              </mesh>
              <Billboard position={labelAt}>
                <Text
          {...TEXT_FONT_PROPS}
                  fontSize={fontSize}
                  color={AXIS_COLORS[i]}
                  anchorX="center"
                  anchorY="middle"
                  outlineWidth={fontSize * 0.08}
                  outlineColor="#05070a"
                >
                  {AXIS_LABELS[i]}
                </Text>
              </Billboard>
            </group>
          );
        })}
    </group>
  );
}

/** Quaternion rotating +Y onto `dir`, as a drei-friendly tuple. */
function quaternionTo(dir: Vec3): [number, number, number, number] {
  // Shortest-arc quaternion from (0,1,0) to dir, computed in closed form so
  // this stays a pure function (no THREE objects retained between renders).
  const [x, y, z] = dir;
  const dot = y; // (0,1,0) . dir
  if (dot > 1 - 1e-8) return [0, 0, 0, 1];
  if (dot < -1 + 1e-8) return [1, 0, 0, 0]; // 180 deg about +X
  // axis = up x dir = (z, 0, -x)
  const ax = z;
  const ay = 0;
  const az = -x;
  const s = Math.sqrt((1 + dot) * 2);
  return [ax / s, ay / s, az / s, s * 0.5];
}
