"use client";

/**
 * The Pareto frontier as an actual surface, not a scatter.
 *
 * Rank-0 points are triangulated (see delaunay.ts — Bowyer–Watson in the plane
 * perpendicular to the all-objectives-improve direction, which a non-dominated
 * set cannot fold over) and the dominated shells float behind it, fading with
 * rank. Every axis is flipped so that "better" always points along +, whatever
 * each objective's `direction` says, and the rail labels state the real
 * physical range in the rail's own direction so the flip cannot mislead.
 *
 * Degenerate cases are the normal case early in a campaign: the fixture's first
 * frontier is exactly three points (one triangle), and before that it is two,
 * or one, or three identical ones. Each falls back a step: surface → polyline →
 * points → `null`.
 */

import { useEffect, useMemo, useState } from "react";
import { Billboard, Html } from "@react-three/drei";
import * as THREE from "three";
import { AxisFrame } from "./AxisFrame";
import { PointCloud, type CloudItem } from "./PointCloud";
import { frontierMesh } from "./delaunay";
import { CHROME, CLOUD } from "./theme";
import {
  axisRanges,
  formatValue,
  isFiniteNumber,
  normalizeVec3,
  type Range,
  type Vec3,
} from "./math";

export interface ParetoPointInput {
  candidate_id: string;
  rank: number;
  values: Record<string, number>;
  scalar_score: number;
}

export interface ParetoSurfaceProps {
  points: ParetoPointInput[];
  axes: [string, string, string];
  axisLabels?: [string, string, string];
  directions?: ("min" | "max" | "target")[];
  selectedId?: string | null;
  onSelect?: (candidateId: string) => void;
}

const HALF = 1;
const SHELL = new THREE.Color(CLOUD.shell);
const DEEP = new THREE.Color(CLOUD.deepShell);
const scratch = new THREE.Color();


/** A thin billboarded ring: the one piece of chrome that says "this is the
 *  candidate you picked", legible at any distance without changing its color. */
function SelectionRing({ position, color }: { position: Vec3; color: string }) {
  return (
    <Billboard position={position}>
      <mesh raycast={() => null}>
        <ringGeometry args={[0.062, 0.072, 48]} />
        <meshBasicMaterial color={color} transparent opacity={0.85} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
    </Billboard>
  );
}

export function ParetoSurface({
  points,
  axes,
  axisLabels,
  directions,
  selectedId,
  onSelect,
}: ParetoSurfaceProps): React.JSX.Element | null {
  const [hovered, setHovered] = useState<string | null>(null);

  const axisKeys = useMemo<[string, string, string]>(
    () => [axes?.[0] ?? "", axes?.[1] ?? "", axes?.[2] ?? ""],
    [axes],
  );

  /** +1 keeps the axis as measured, -1 flips it so bigger is better.
   *  `"target"` carries no target value in these props, so it is deliberately
   *  left unflipped rather than guessed at. */
  const signs = useMemo<Vec3>(
    () => [0, 1, 2].map((a) => (directions?.[a] === "min" ? -1 : 1)) as Vec3,
    [directions],
  );

  const rows = useMemo(() => {
    if (!Array.isArray(points)) return [];
    const out: { id: string; rank: number; score: number; raw: Vec3; oriented: Vec3 }[] = [];
    const seen = new Set<string>();
    for (const p of points) {
      if (!p || typeof p.candidate_id !== "string" || !p.values) continue;
      if (seen.has(p.candidate_id)) continue;
      const raw: Vec3 = [
        p.values[axisKeys[0]],
        p.values[axisKeys[1]],
        p.values[axisKeys[2]],
      ] as Vec3;
      if (!isFiniteNumber(raw[0]) || !isFiniteNumber(raw[1]) || !isFiniteNumber(raw[2])) continue;
      seen.add(p.candidate_id);
      out.push({
        id: p.candidate_id,
        rank: isFiniteNumber(p.rank) ? Math.max(0, Math.round(p.rank)) : 1,
        score: isFiniteNumber(p.scalar_score) ? p.scalar_score : 0,
        raw,
        oriented: [raw[0] * signs[0], raw[1] * signs[1], raw[2] * signs[2]],
      });
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }, [points, axisKeys, signs]);

  const ranges = useMemo(() => axisRanges(rows.map((r) => r.oriented)), [rows]);

  /** What each rail actually spans in physical units, read along the rail. */
  const railRanges = useMemo<[Range, Range, Range]>(
    () =>
      [0, 1, 2].map((a) => {
        const lo = ranges[a].min * signs[a];
        const hi = ranges[a].max * signs[a];
        return { min: lo, max: hi };
      }) as [Range, Range, Range],
    [ranges, signs],
  );

  const placed = useMemo(
    () => rows.map((r) => ({ ...r, position: normalizeVec3(r.oriented, ranges, HALF) })),
    [rows, ranges],
  );

  const maxRank = useMemo(() => placed.reduce((m, p) => Math.max(m, p.rank), 0), [placed]);

  const items = useMemo<CloudItem[]>(
    () =>
      placed.map((p) => {
        if (p.rank === 0) {
          return { id: p.id, position: p.position, color: CLOUD.frontier, scale: 1.7 };
        }
        const t = maxRank > 1 ? Math.min(1, (p.rank - 1) / (maxRank - 1)) : 0;
        return {
          id: p.id,
          position: p.position,
          color: `#${scratch.copy(SHELL).lerp(DEEP, 0.3 + 0.7 * t).getHexString()}`,
          scale: 1.1 - 0.4 * t,
        };
      }),
    [placed, maxRank],
  );

  const frontier = useMemo(() => placed.filter((p) => p.rank === 0), [placed]);

  /** A soft bloom on the frontier only: the one group of candidates a viewer
   *  should find without being told. */
  const frontierGlow = useMemo<CloudItem[]>(
    () =>
      frontier.map((p) => ({
        id: `${p.id}-glow`,
        position: p.position,
        color: CLOUD.frontierGlow,
        scale: 5.4,
      })),
    [frontier],
  );
  const mesh = useMemo(() => frontierMesh(frontier.map((p) => p.position)), [frontier]);

  const surface = useMemo(() => {
    if (mesh.kind !== "surface") return null;
    const pos: number[] = [];
    for (const [a, b, c] of mesh.triangles) {
      pos.push(...mesh.positions[a], ...mesh.positions[b], ...mesh.positions[c]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }, [mesh]);
  useEffect(() => () => surface?.dispose(), [surface]);

  const outline = useMemo(() => {
    const verts: number[] = [];
    if (mesh.kind === "surface") {
      for (const [a, b, c] of mesh.triangles) {
        verts.push(...mesh.positions[a], ...mesh.positions[b]);
        verts.push(...mesh.positions[b], ...mesh.positions[c]);
        verts.push(...mesh.positions[c], ...mesh.positions[a]);
      }
    } else if (mesh.kind === "polyline") {
      for (let i = 0; i + 1 < mesh.path.length; i++) {
        verts.push(...mesh.positions[mesh.path[i]], ...mesh.positions[mesh.path[i + 1]]);
      }
    }
    if (!verts.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    return g;
  }, [mesh]);
  useEffect(() => () => outline?.dispose(), [outline]);

  /** Thin droppers from each dominated point down to the frontier's plane:
   *  without them a dominated point's distance from the surface is ambiguous. */
  const droppers = useMemo(() => {
    const verts: number[] = [];
    for (const p of placed) {
      if (p.rank === 0) continue;
      verts.push(p.position[0], p.position[1], p.position[2]);
      verts.push(p.position[0], -HALF, p.position[2]);
    }
    if (!verts.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    return g;
  }, [placed]);
  useEffect(() => () => droppers?.dispose(), [droppers]);

  if (!placed.length) return null;

  const focusId = hovered ?? selectedId ?? null;
  const focus = focusId ? placed.find((p) => p.id === focusId) : undefined;

  return (
    <group>
      <ambientLight intensity={0.5} />
      <directionalLight position={[3, 7, 4]} intensity={0.75} />
      <directionalLight position={[-4, 1, -4]} intensity={0.22} color="#7dd3fc" />

      <AxisFrame half={HALF} axisLabels={axisLabels} ranges={railRanges} betterAtPlus />

      {surface && (
        <mesh geometry={surface} frustumCulled={false}>
          <meshStandardMaterial
            color={CLOUD.surface}
            emissive={CLOUD.surface}
            emissiveIntensity={0.12}
            transparent
            opacity={0.3}
            side={THREE.DoubleSide}
            depthWrite={false}
            roughness={0.45}
            metalness={0.05}
          />
        </mesh>
      )}
      {outline && (
        <lineSegments geometry={outline} frustumCulled={false}>
          <lineBasicMaterial color={CLOUD.surface} transparent opacity={0.55} />
        </lineSegments>
      )}
      {droppers && (
        <lineSegments geometry={droppers} frustumCulled={false}>
          <lineBasicMaterial color={CHROME.axis} transparent opacity={0.22} />
        </lineSegments>
      )}

      {frontierGlow.length > 0 && (
        <PointCloud items={frontierGlow} baseRadius={0.03} opacity={0.45} glow />
      )}
      <PointCloud
        items={items}
        baseRadius={0.03}
        selectedId={selectedId}
        hoveredId={hovered}
        onSelect={onSelect}
        onHover={setHovered}
      />

      {selectedId &&
        (() => {
          const sel = placed.find((p) => p.id === selectedId);
          return sel ? <SelectionRing position={sel.position} color={CHROME.selection} /> : null;
        })()}
      {focus && (
        <Html position={focus.position} center zIndexRange={[40, 30]} style={{ pointerEvents: "none" }}>
          <div
            style={{
              transform: "translate(0, -30px)",
              padding: "7px 10px",
              borderRadius: 5,
              whiteSpace: "nowrap",
              background: "rgba(8,13,22,0.93)",
              border: `1px solid ${focus.rank === 0 ? CLOUD.frontier : "rgba(148,163,184,0.35)"}`,
              boxShadow: "0 8px 22px rgba(0,0,0,0.55)",
              fontFamily: "ui-sans-serif, system-ui, sans-serif",
              color: "#e2e8f0",
              fontSize: 12,
            }}
          >
            <div style={{ display: "flex", gap: 7, alignItems: "baseline" }}>
              <span>{focus.id}</span>
              <span
                style={{
                  fontSize: 9.5,
                  letterSpacing: "0.1em",
                  color: focus.rank === 0 ? CLOUD.frontier : CHROME.labelDim,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                }}
              >
                {focus.rank === 0 ? "FRONTIER" : `SHELL ${focus.rank}`} · SCORE{" "}
                {formatValue(focus.score)}
              </span>
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 10.5,
                color: CHROME.label,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                lineHeight: 1.5,
              }}
            >
              {[0, 1, 2].map((a) => (
                <div key={a}>
                  <span style={{ color: CHROME.labelDim }}>
                    {axisLabels?.[a] ?? axisKeys[a]}
                  </span>{" "}
                  {formatValue(focus.raw[a])}
                </div>
              ))}
            </div>
          </div>
        </Html>
      )}
    </group>
  );
}
