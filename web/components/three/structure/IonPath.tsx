"use client";

/**
 * The glowing migration path of a mobile ion.
 *
 * `@react-three/postprocessing` is not installed, so there is no real bloom
 * pass. The glow is faked the way it was done before bloom existed, and it
 * holds up well at video resolution:
 *
 *  - a bright, nearly opaque **core** tube, `toneMapped={false}` so it keeps
 *    its colour instead of being rolled off by ACES,
 *  - two concentric **shells** at ~2.4x and ~4.5x the core radius with
 *    additive blending, `depthWrite={false}` and falling opacity, which
 *    reproduces the soft radial falloff of a bloom kernel,
 *  - an additive **halo sprite** on the ion itself.
 *
 * The curve is a centripetal Catmull-Rom through the unwrapped frame-by-frame
 * positions. `TrajectoryView` samples the *same* curve object to place the
 * ion, so the ion can never drift outside its own trail at a corner — which
 * is exactly what happens if you lerp the ion but spline the tube.
 */

import { useEffect, useMemo } from "react";
import * as THREE from "three";

import type { Vec3 } from "./types";

export interface IonPathProps {
  /** Unwrapped path points, in order. */
  points: Vec3[];
  color?: string;
  coreRadius?: number;
  opacity?: number;
  /** Tube segments along the curve. */
  segments?: number;
}

/** Builds the curve once so the caller and the tube agree exactly. */
export function useIonCurve(points: Vec3[]): THREE.CatmullRomCurve3 | null {
  return useMemo(() => {
    if (points.length < 2) return null;
    const vecs = points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    // 'centripetal' avoids the cusps and self-intersections that a uniform
    // Catmull-Rom produces when consecutive NEB images are unevenly spaced.
    return new THREE.CatmullRomCurve3(vecs, false, "centripetal", 0.5);
  }, [points]);
}

export function IonPath({
  points,
  color = "#a855f7",
  coreRadius = 0.075,
  opacity = 1,
  segments = 160,
}: IonPathProps) {
  const curve = useIonCurve(points);

  const geometries = useMemo(() => {
    if (!curve) return null;
    const core = new THREE.TubeGeometry(curve, segments, coreRadius, 12, false);
    const mid = new THREE.TubeGeometry(curve, segments, coreRadius * 2.4, 14, false);
    const outer = new THREE.TubeGeometry(curve, segments, coreRadius * 4.5, 16, false);
    return { core, mid, outer };
  }, [curve, coreRadius, segments]);

  useEffect(() => {
    if (!geometries) return;
    return () => {
      geometries.core.dispose();
      geometries.mid.dispose();
      geometries.outer.dispose();
    };
  }, [geometries]);

  if (!geometries) return null;

  return (
    <group>
      {/* Outermost falloff first: additive shells are order-independent but
          drawing large-to-small keeps the depth sort stable. */}
      {/* The two glow shells ignore depth. A real bloom pass bleeds over
          whatever is in front of the emitter, and without that the trail
          disappears the moment a framework atom overlaps it — which, inside a
          95-atom cell, is most of the time. The core keeps depth testing, so
          the ion still reads as being *inside* the structure. */}
      <mesh geometry={geometries.outer} renderOrder={10}>
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.07 * opacity}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          depthTest={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      <mesh geometry={geometries.mid} renderOrder={11}>
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.17 * opacity}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          depthTest={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      <mesh geometry={geometries.core} renderOrder={12}>
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.92 * opacity}
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

/**
 * A soft additive halo, used to make the mobile ion glow. The texture is built
 * inside `useMemo` rather than at module scope: a module-level `document`
 * reference would break server rendering of any page importing this file.
 */
export function useGlowTexture(): THREE.Texture | null {
  const texture = useMemo(() => {
    if (typeof document === "undefined") return null;
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    // A Gaussian-ish falloff; a linear ramp looks like a flat disc.
    grad.addColorStop(0.0, "rgba(255,255,255,1)");
    grad.addColorStop(0.18, "rgba(255,255,255,0.65)");
    grad.addColorStop(0.42, "rgba(255,255,255,0.22)");
    grad.addColorStop(0.72, "rgba(255,255,255,0.05)");
    grad.addColorStop(1.0, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  useEffect(() => {
    if (!texture) return;
    return () => texture.dispose();
  }, [texture]);

  return texture;
}

/** Faint wireframe sphere marking where the hop starts and ends. */
export function SiteGhost({
  position,
  radius,
  color,
}: {
  position: Vec3;
  radius: number;
  color: string;
}) {
  return (
    <mesh position={position} renderOrder={5}>
      <sphereGeometry args={[radius, 18, 12]} />
      <meshBasicMaterial
        color={color}
        wireframe
        transparent
        opacity={0.28}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}
