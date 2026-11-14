"use client";

/**
 * Instrument chrome for the two property-space views: a floor grid, three axis
 * rails with tick marks, and DOM labels.
 *
 * Labels are drei `Html`, not `Text`: troika (which backs `Text`) fetches its
 * default font from a CDN, and the demo has to work offline. DOM text is also
 * simply sharper at video resolution.
 *
 * Everything lives in two buffer geometries, both disposed when they are
 * rebuilt — a replayed campaign remounts these constantly.
 */

import { useEffect, useMemo } from "react";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { CHROME } from "./theme";
import { formatValue, type Range } from "./math";

export interface AxisFrameProps {
  half?: number;
  axisLabels?: [string, string, string];
  /** Data ranges per axis, used for the end-of-rail tick values. */
  ranges?: [Range, Range, Range];
  /** Per-axis orientation: when given, the + end of the rail is annotated. */
  betterAtPlus?: boolean;
  divisions?: number;
  showFloor?: boolean;
}

const AXIS_DIRS: [number, number, number][] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export function AxisFrame({
  half = 1,
  axisLabels,
  ranges,
  betterAtPlus = false,
  divisions = 8,
  showFloor = true,
}: AxisFrameProps) {
  const h = Number.isFinite(half) && half > 0 ? half : 1;

  const grid = useMemo(() => {
    if (!showFloor) return null;
    const verts: number[] = [];
    const cols: number[] = [];
    const minor = new THREE.Color(CHROME.gridMinor);
    const major = new THREE.Color(CHROME.grid);
    const n = Math.max(2, Math.min(32, divisions));
    for (let i = 0; i <= n; i++) {
      const t = -h + (2 * h * i) / n;
      const edge = i === 0 || i === n;
      const c = edge ? major : minor;
      verts.push(t, -h, -h, t, -h, h, -h, -h, t, h, -h, t);
      for (let k = 0; k < 4; k++) cols.push(c.r, c.g, c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    return g;
  }, [h, divisions, showFloor]);
  useEffect(() => () => grid?.dispose(), [grid]);

  const rails = useMemo(() => {
    const verts: number[] = [];
    const cols: number[] = [];
    const base = new THREE.Color(CHROME.axis);
    const bright = new THREE.Color(CHROME.axisBright);
    const origin: [number, number, number] = [-h, -h, -h];
    for (const dir of AXIS_DIRS) {
      const end: [number, number, number] = [
        origin[0] + dir[0] * 2 * h,
        origin[1] + dir[1] * 2 * h,
        origin[2] + dir[2] * 2 * h,
      ];
      verts.push(...origin, ...end);
      cols.push(base.r, base.g, base.b, bright.r, bright.g, bright.b);
      // Ticks: short stubs pointing away from the frame.
      const away: [number, number, number] = [
        dir[0] ? 0 : -1,
        dir[1] ? 0 : dir[0] ? -1 : 0,
        0,
      ];
      const len = h * 0.05;
      for (let i = 1; i < 5; i++) {
        const t = i / 4;
        const p: [number, number, number] = [
          origin[0] + dir[0] * 2 * h * t,
          origin[1] + dir[1] * 2 * h * t,
          origin[2] + dir[2] * 2 * h * t,
        ];
        verts.push(...p, p[0] + away[0] * len, p[1] + away[1] * len, p[2] + away[2] * len);
        cols.push(base.r, base.g, base.b, base.r, base.g, base.b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    return g;
  }, [h]);
  useEffect(() => () => rails.dispose(), [rails]);

  return (
    <group>
      {grid && (
        <lineSegments geometry={grid} frustumCulled={false}>
          <lineBasicMaterial vertexColors transparent opacity={0.85} />
        </lineSegments>
      )}
      <lineSegments geometry={rails} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent opacity={0.9} />
      </lineSegments>

      {AXIS_DIRS.map((dir, a) => {
        const label = axisLabels?.[a];
        if (!label) return null;
        const pos: [number, number, number] = [
          -h + dir[0] * 2.16 * h,
          -h + dir[1] * 2.16 * h,
          -h + dir[2] * 2.16 * h,
        ];
        const r = ranges?.[a];
        return (
          <Html key={a} position={pos} center zIndexRange={[20, 10]} style={{ pointerEvents: "none" }}>
            <div
              style={{
                fontFamily: "ui-sans-serif, system-ui, sans-serif",
                fontSize: 11,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: CHROME.label,
                whiteSpace: "nowrap",
                textShadow: "0 1px 3px rgba(0,0,0,0.85)",
                textAlign: "center",
              }}
            >
              {label}
              {r && (
                <div style={{ fontSize: 9.5, letterSpacing: 0, textTransform: "none", color: CHROME.labelDim }}>
                  {formatValue(r.min)} → {formatValue(r.max)}
                  {betterAtPlus ? "  ·  better →" : ""}
                </div>
              )}
            </div>
          </Html>
        );
      })}
    </group>
  );
}
