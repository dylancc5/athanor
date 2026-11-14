"use client";

/**
 * In-scene energy readout for a trajectory.
 *
 * Energies arrive as raw total energies (e.g. -140.0429 eV), which carry no
 * information for a viewer — what matters is the *change* along the path. So
 * everything is shown relative to the first frame, and for an NEB path the
 * peak is called out as the barrier.
 *
 * The profile is drawn as a billboarded polyline with a travelling marker. It
 * sits in the 3D scene rather than in DOM so it survives being captured as
 * part of the canvas (the demo video is a canvas recording) and so the app
 * shell does not have to lay anything out around it.
 */

import { useEffect, useMemo } from "react";
import { Billboard, Line, Text } from "@react-three/drei";

import { TEXT_FONT_PROPS } from "./font";
import * as THREE from "three";

import type { Vec3 } from "./types";

export interface EnergyReadoutProps {
  energies: number[];
  /** Continuous frame position, may be fractional. */
  position: number;
  /** Where to put the panel, in world coordinates. */
  anchor: Vec3;
  /** Panel width in angstroms. */
  width?: number;
  height?: number;
  color?: string;
  accent?: string;
  /** Label shown above the plot. */
  title?: string;
  /** eV; when given, shown as the barrier callout. */
  barrierEv?: number;
}

export function EnergyReadout({
  energies,
  position,
  anchor,
  width = 6,
  height = 2.2,
  color = "#9fb3c8",
  accent = "#c084fc",
  title,
  barrierEv,
}: EnergyReadoutProps) {
  const plot = useMemo(() => {
    const finite = energies.filter((e) => Number.isFinite(e));
    if (finite.length < 2) return null;
    const base = Number.isFinite(energies[0]) ? energies[0] : finite[0];
    const rel = energies.map((e) => (Number.isFinite(e) ? e - base : NaN));
    const relFinite = rel.filter((v) => Number.isFinite(v));
    const lo = Math.min(...relFinite, 0);
    const hi = Math.max(...relFinite, 0);
    const span = hi - lo || 1;

    const n = rel.length;
    const pts: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(rel[i])) continue;
      pts.push([
        (i / (n - 1) - 0.5) * width,
        ((rel[i] - lo) / span - 0.5) * height,
        0,
      ]);
    }

    // Zero line, so "downhill" is readable at a glance.
    const zeroY = ((0 - lo) / span - 0.5) * height;
    return { rel, lo, span, pts, zeroY, peak: hi };
  }, [energies, width, height]);

  const borderGeometry = useMemo(() => {
    const plane = new THREE.PlaneGeometry(width * 1.16, height * 2.0);
    const edges = new THREE.EdgesGeometry(plane);
    plane.dispose();
    return edges;
  }, [width, height]);
  useEffect(() => () => borderGeometry.dispose(), [borderGeometry]);

  if (!plot) return null;

  const n = plot.rel.length;
  const clamped = Math.max(0, Math.min(n - 1, position));
  const i0 = Math.floor(clamped);
  const i1 = Math.min(n - 1, i0 + 1);
  const frac = clamped - i0;
  const e0 = plot.rel[i0];
  const e1 = plot.rel[i1];
  const current =
    Number.isFinite(e0) && Number.isFinite(e1) ? e0 + (e1 - e0) * frac : NaN;

  const markerX = (clamped / (n - 1) - 0.5) * width;
  const markerY = Number.isFinite(current)
    ? ((current - plot.lo) / plot.span - 0.5) * height
    : 0;

  const fontSize = height * 0.2;

  // The frame counter is pinned to the right edge of the same row, so a long
  // caption has to be clipped rather than allowed to run under it. Troika has
  // no ellipsis mode and `maxWidth` would wrap it down into the plot, so the
  // string is trimmed to the character budget the row actually has.
  const titleBudget = Math.max(8, Math.floor((width * 0.62) / (fontSize * 0.52)));
  const shownTitle =
    title && title.length > titleBudget
      ? title.slice(0, titleBudget - 1).trimEnd() + "\u2026"
      : title;

  // Everything in the panel is drawn with `depthTest={false}` and a high
  // render order, so it behaves as an instrument overlay rather than as a
  // billboard buried in the structure. Without this the atoms in front of the
  // panel's plane punch holes through the plot and the numbers.
  const overlay = { depthTest: false, depthWrite: false, transparent: true } as const;

  return (
    <Billboard position={anchor} renderOrder={100}>
      {/* Backing card. Nearly opaque: a faint wash is not enough to read
          3 significant figures against a lattice of bright atoms. */}
      <mesh position={[0, 0, -0.02]} renderOrder={100}>
        <planeGeometry args={[width * 1.16, height * 2.0]} />
        <meshBasicMaterial color="#070a0f" opacity={0.88} {...overlay} />
      </mesh>
      {/* Hairline border, so the card reads as a panel and not as a smudge.
          The geometry is memoized: inline `args={[new PlaneGeometry(...)]}`
          hands R3F a fresh array every render, which during playback rebuilds
          and re-uploads this geometry 60 times a second and leaks it. */}
      <lineSegments geometry={borderGeometry} position={[0, 0, -0.01]} renderOrder={101}>
        <lineBasicMaterial color="#1e2a38" {...overlay} toneMapped={false} />
      </lineSegments>

      {shownTitle && (
        <Text
          {...TEXT_FONT_PROPS}
          renderOrder={102}
          position={[-width / 2, height * 0.82, 0]}
          fontSize={fontSize}
          color={color}
          anchorX="left"
          anchorY="middle"
          outlineWidth={fontSize * 0.08}
          outlineColor="#05070a"
        >
          {shownTitle}
        </Text>
      )}

      <Line
        renderOrder={102}
        points={[
          [-width / 2, plot.zeroY, 0],
          [width / 2, plot.zeroY, 0],
        ]}
        color="#3b4654"
        lineWidth={1}
        dashed
        dashSize={0.12}
        gapSize={0.1}
        toneMapped={false}
      />

      <Line
        points={plot.pts}
        color={accent}
        lineWidth={2.4}
        renderOrder={103}
        toneMapped={false}
      />

      {/* Travelling marker. */}
      <Line
        renderOrder={103}
        points={[
          [markerX, -height / 2, 0],
          [markerX, height / 2, 0],
        ]}
        color="#e2e8f0"
        lineWidth={1}
        transparent
        opacity={0.35}
        toneMapped={false}
      />
      <mesh position={[markerX, markerY, 0.01]} renderOrder={104}>
        <circleGeometry args={[height * 0.06, 16]} />
        <meshBasicMaterial color="#ffffff" {...overlay} toneMapped={false} />
      </mesh>

      <Text
          {...TEXT_FONT_PROPS}
        renderOrder={102}
        position={[-width / 2, -height * 0.82, 0]}
        fontSize={fontSize * 0.95}
        color="#e2e8f0"
        anchorX="left"
        anchorY="middle"
        outlineWidth={fontSize * 0.08}
        outlineColor="#05070a"
      >
        {Number.isFinite(current)
          ? `ΔE  ${current >= 0 ? "+" : "−"}${Math.abs(current).toFixed(3)} eV`
          : "ΔE  —"}
      </Text>

      {barrierEv != null && Number.isFinite(barrierEv) && (
        <Text
          {...TEXT_FONT_PROPS}
          renderOrder={102}
          position={[width / 2, -height * 0.82, 0]}
          fontSize={fontSize * 0.95}
          color={accent}
          anchorX="right"
          anchorY="middle"
          outlineWidth={fontSize * 0.08}
          outlineColor="#05070a"
        >
          {/* Spelled out rather than "Eₐ": the default troika font has no
              subscript-a glyph and renders it as a tofu box. */}
          {`barrier  ${barrierEv.toFixed(3)} eV`}
        </Text>
      )}

      <Text
          {...TEXT_FONT_PROPS}
        renderOrder={102}
        position={[width / 2, height * 0.82, 0]}
        fontSize={fontSize}
        color={color}
        anchorX="right"
        anchorY="middle"
        outlineWidth={fontSize * 0.08}
        outlineColor="#05070a"
      >
        {`frame ${Math.round(clamped) + 1}/${n}`}
      </Text>
    </Billboard>
  );
}
