"use client";

/**
 * `TrajectoryView` — animated playback over frames, for the two cases that
 * matter in ATHANOR:
 *
 *  1. a **relaxation trajectory**: atoms settling into equilibrium, with the
 *     energy falling frame by frame;
 *  2. an **NEB migration path**: a lithium ion hopping between sites, its
 *     trail drawn as a glowing tube.
 *
 * Signature frozen by `components/three/CONTRACT.md`; extra props are additive.
 *
 * How the animation works
 * -----------------------
 * A float `cursor` (continuous frame position) is advanced inside `useFrame`
 * and the instance matrices are rewritten directly — React never re-renders
 * during playback. Positions are interpolated with a Catmull-Rom through the
 * frames rather than a linear lerp, so motion eases through each image instead
 * of visibly snapping at frame boundaries.
 *
 * The mobile ion is sampled from the *same* `CatmullRomCurve3` that generates
 * the glow tube, so it can never leave its own trail.
 *
 * Bond topology is inferred once from the first frame (with periodic image
 * shifts) and then held fixed, with only the endpoints moving. Re-inferring
 * per frame makes bonds flicker on and off as distances cross the cutoff.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import {
  boundingSphere,
  inferBonds,
  trajectoryBoundingSphere,
  unwrapPath,
} from "../../../lib/structure-parse";
import { IONIC_CATIONS, elementColor, elementRadius } from "../elements";
import { AtomInstances, type AtomInstancesHandle } from "./AtomInstances";
import { BondInstances, type BondInstancesHandle } from "./BondInstances";
import { EnergyReadout } from "./EnergyReadout";
import { IonPath, SiteGhost, useGlowTexture, useIonCurve } from "./IonPath";
import { StructureLights } from "./Lights";
import { UnitCell } from "./UnitCell";
import { normalizeTrajectory } from "./normalize";
import type { Cell, Frame, TrajectoryData, Vec3 } from "./types";

export interface TrajectoryViewProps {
  symbols: string[];
  cell: Cell;
  pbc: boolean;
  frames: Frame[];
  energies?: number[];
  /**
   * Controlled frame position. Fractional values are honoured and
   * interpolated, so the shell can scrub smoothly or hold a deterministic
   * mid-hop pose for a screenshot.
   */
  frameIndex?: number;
  /** Default true when `frameIndex` is omitted. */
  playing?: boolean;
  /** Default true. */
  loop?: boolean;
  /** Default 12. */
  fps?: number;
  /** Draw this atom's path as a glowing tube (NEB). */
  mobileIndex?: number;
  onFrameChange?: (index: number) => void;

  // --- additive options (not in the frozen contract) -------------------
  lights?: boolean;
  showCell?: boolean;
  showBonds?: boolean;
  showAxes?: boolean;
  /** Draw the in-scene energy profile. Default true when energies exist. */
  showEnergy?: boolean;
  /** Barrier callout on the energy panel, eV. */
  barrierEv?: number;
  /** Title on the energy panel. */
  label?: string;
  /**
   * Amplify per-atom displacement from frame 0. A relaxation trajectory moves
   * atoms by ~0.01 A, which is invisible; 1 is honest, higher is a teaching
   * aid. Never applied to the mobile ion of an NEB path (that motion is real
   * and already visible).
   */
  exaggerate?: number;
  /**
   * Play forwards then backwards instead of jumping back to frame 0. Defaults
   * to true for an NEB path, where wrapping would teleport the ion across the
   * cell. Ignored when `loop` is false.
   */
  pingPong?: boolean;
  /** Faint wireframe spheres at the start and end of the hop. Default true. */
  showSiteGhosts?: boolean;
  radiusScale?: number;
  bondRadius?: number;
  bondExclude?: readonly string[];
  mobileColor?: string;
}

export function TrajectoryView(props: TrajectoryViewProps) {
  const data = useMemo(
    () =>
      normalizeTrajectory({
        symbols: props.symbols,
        cell: props.cell,
        pbc: props.pbc,
        frames: props.frames,
        energies: props.energies,
        mobile_index: props.mobileIndex,
      }),
    [props.symbols, props.cell, props.pbc, props.frames, props.energies, props.mobileIndex],
  );
  if (!data) return null;
  return <TrajectoryViewInner {...props} data={data} />;
}

function TrajectoryViewInner({
  data,
  frameIndex,
  playing,
  loop = true,
  fps = 12,
  onFrameChange,
  lights = true,
  showCell,
  showBonds = true,
  showAxes = true,
  showEnergy,
  barrierEv,
  label,
  exaggerate = 1,
  pingPong,
  showSiteGhosts = true,
  radiusScale = 1,
  bondRadius = 0.11,
  bondExclude = IONIC_CATIONS,
  mobileColor = "#a855f7",
}: TrajectoryViewProps & { data: TrajectoryData }) {
  const { symbols, cell, pbc, frames, energies, mobileIndex } = data;
  const nFrames = frames.length;
  const nAtoms = symbols.length;

  const controlled = frameIndex != null && Number.isFinite(frameIndex);
  const isNeb = mobileIndex != null;
  const autoPlay = playing ?? !controlled;
  const bounce = pingPong ?? isNeb;

  const atomsRef = useRef<AtomInstancesHandle>(null);
  const bondsRef = useRef<BondInstancesHandle>(null);
  const mobileRef = useRef<THREE.Group>(null);

  /** Continuous frame position; the single source of truth for the pose. */
  const cursorRef = useRef(controlled ? clamp(frameIndex as number, 0, nFrames - 1) : 0);
  const dirRef = useRef(1);
  const lastReportedRef = useRef(-1);

  /** Scratch buffer for the interpolated pose. */
  const poseRef = useRef<Float32Array>(new Float32Array(nAtoms * 3));
  useEffect(() => {
    poseRef.current = new Float32Array(nAtoms * 3);
  }, [nAtoms]);

  /**
   * Frames flattened into one Float32Array, for cache-friendly interpolation.
   * `exaggerate` is baked in here so it costs nothing per animation frame.
   */
  const flatFrames = useMemo(() => {
    const out = new Float32Array(nFrames * nAtoms * 3);
    const amp = Number.isFinite(exaggerate) ? Math.max(0, exaggerate) : 1;
    const base = frames[0];
    for (let f = 0; f < nFrames; f++) {
      const frame = frames[f];
      for (let a = 0; a < nAtoms; a++) {
        const o = (f * nAtoms + a) * 3;
        const skip = amp === 1 || a === mobileIndex;
        for (let k = 0; k < 3; k++) {
          out[o + k] = skip
            ? frame[a][k]
            : base[a][k] + (frame[a][k] - base[a][k]) * amp;
        }
      }
    }
    return out;
  }, [frames, nFrames, nAtoms, exaggerate, mobileIndex]);

  /** Bond topology, fixed once from the first frame. */
  const bonds = useMemo(() => {
    if (!showBonds) return [];
    return inferBonds(symbols, frames[0], cell, pbc, { exclude: bondExclude });
  }, [showBonds, symbols, frames, cell, pbc, bondExclude]);

  /** Unwrapped mobile-ion path, and the curve the tube and ion both use. */
  const pathPoints = useMemo<Vec3[]>(
    () => (mobileIndex == null ? [] : unwrapPath(frames, mobileIndex, cell)),
    [frames, mobileIndex, cell],
  );
  const curve = useIonCurve(pathPoints);
  const glowTexture = useGlowTexture();

  /** Stable camera framing: the union of every frame plus the cell. */
  const framing = useMemo(
    () => trajectoryBoundingSphere(frames, cell),
    [frames, cell],
  );

  const mobileRadius = mobileIndex == null ? 0 : elementRadius(symbols[mobileIndex]) * radiusScale;

  /**
   * The relaxation case has nothing to spline a tube along, so the energy
   * panel is the thing that tells the story. It is anchored above the content.
   */
  /**
   * The energy panel sits in clear space *above* the cell rather than inside
   * it. Two earlier placements were worse: at 0.92r it was cropped off the top
   * of the viewport, and once moved inside the sphere the structure's own
   * atoms punched through the plot and the numbers (drei's `<Text>` builds its
   * material lazily, so it cannot simply be told to skip the depth test).
   * Putting it in empty space above the box needs no depth tricks at all —
   * `trajectoryFraming` reserves the headroom so the shell frames it.
   */
  const panel = useMemo(
    () => energyPanelLayout(framing.center, framing.radius),
    [framing],
  );

  // Keep a tiny bit of React state only so a controlled `frameIndex` change
  // re-renders the energy marker; the heavy work stays in useFrame.
  const [renderCursor, setRenderCursor] = useState(cursorRef.current);

  useFrame((_, delta) => {
    let cursor = cursorRef.current;

    if (controlled) {
      // Ease towards the requested position so a jumpy controlled index still
      // reads as motion rather than a cut. Snaps when already close.
      const target = clamp(frameIndex as number, 0, nFrames - 1);
      const diff = target - cursor;
      cursor = Math.abs(diff) < 1e-3 ? target : cursor + diff * Math.min(1, delta * 12);
    } else if (autoPlay && nFrames > 1) {
      cursor += dirRef.current * delta * fps;
      if (bounce) {
        while (cursor > nFrames - 1 || cursor < 0) {
          if (cursor > nFrames - 1) {
            cursor = 2 * (nFrames - 1) - cursor;
            dirRef.current = -1;
          } else {
            cursor = -cursor;
            dirRef.current = 1;
          }
        }
      } else if (loop) {
        cursor = ((cursor % (nFrames - 1)) + (nFrames - 1)) % (nFrames - 1);
      } else {
        cursor = clamp(cursor, 0, nFrames - 1);
      }
    }
    cursorRef.current = cursor;

    // --- pose ---------------------------------------------------------
    const pose = poseRef.current;
    sampleCatmullRom(flatFrames, nFrames, nAtoms, cursor, pose);

    // The mobile ion rides the tube's own curve.
    if (mobileIndex != null && curve && nFrames > 1) {
      const p = curve.getPoint(clamp(cursor / (nFrames - 1), 0, 1));
      pose[mobileIndex * 3] = p.x;
      pose[mobileIndex * 3 + 1] = p.y;
      pose[mobileIndex * 3 + 2] = p.z;
      if (mobileRef.current) mobileRef.current.position.set(p.x, p.y, p.z);
    }

    atomsRef.current?.setPositions(pose);
    bondsRef.current?.setPositions(pose);

    // --- callbacks ----------------------------------------------------
    const nearest = Math.round(cursor);
    if (nearest !== lastReportedRef.current) {
      lastReportedRef.current = nearest;
      onFrameChange?.(nearest);
    }
    // Quantized: the cursor advances ~0.17 per tick at 10 fps, so a 0.02
    // threshold re-rendered the whole subtree on essentially every animation
    // frame. A tenth of a frame is finer than the energy marker can show.
    const quantized = Math.round(cursor * 10) / 10;
    if (quantized !== renderCursor) setRenderCursor(quantized);
  });

  const drawCell = (showCell ?? pbc) && cell != null;
  const drawEnergy = (showEnergy ?? true) && energies != null && energies.length >= 2;

  /** The mobile ion is hidden in the main instanced mesh and drawn separately
   *  so it can carry its own emissive material and halo. */
  const atomRadii = useMemo(() => {
    const out = new Array<number>(nAtoms);
    for (let i = 0; i < nAtoms; i++) {
      out[i] = i === mobileIndex ? 0 : elementRadius(symbols[i]) * radiusScale;
    }
    return out;
  }, [symbols, nAtoms, mobileIndex, radiusScale]);

  return (
    <group>
      {lights && <StructureLights />}

      <AtomInstances
        ref={atomsRef}
        symbols={symbols}
        positions={frames[0]}
        radii={atomRadii}
      />

      {bonds.length > 0 && (
        <BondInstances
          ref={bondsRef}
          symbols={symbols}
          positions={frames[0]}
          bonds={bonds}
          cell={cell}
          radius={bondRadius}
        />
      )}

      {/* --- the mobile ion ------------------------------------------- */}
      {mobileIndex != null && (
        <>
          <IonPath
            points={pathPoints}
            color={mobileColor}
            coreRadius={Math.max(0.07, mobileRadius * 0.22)}
          />

          {showSiteGhosts && pathPoints.length >= 2 && (
            <>
              <SiteGhost
                position={pathPoints[0]}
                radius={mobileRadius * 1.25}
                color={mobileColor}
              />
              <SiteGhost
                position={pathPoints[pathPoints.length - 1]}
                radius={mobileRadius * 1.25}
                color={mobileColor}
              />
            </>
          )}

          <group ref={mobileRef} position={pathPoints[0] ?? [0, 0, 0]}>
            {/* Oversized on purpose: the mobile ion is the subject of the
                shot, and at its true display radius it is indistinguishable
                from the dozens of other lithiums around it. */}
            <mesh renderOrder={13}>
              <sphereGeometry args={[mobileRadius * 1.5, 32, 24]} />
              <meshStandardMaterial
                color={elementColor(symbols[mobileIndex])}
                emissive={mobileColor}
                // Kept well below 1: at 0.9 the emissive swamped the base
                // colour and the ion rendered as a featureless white blob
                // instead of a glowing lithium.
                emissiveIntensity={0.3}
                roughness={0.22}
                metalness={0.1}
              />
            </mesh>
            {glowTexture && (
              <sprite scale={[mobileRadius * 6, mobileRadius * 6, 1]} renderOrder={14}>
                <spriteMaterial
                  map={glowTexture}
                  color={mobileColor}
                  blending={THREE.AdditiveBlending}
                  transparent
                  opacity={0.26}
                  depthWrite={false}
                  depthTest={false}
                  toneMapped={false}
                />
              </sprite>
            )}
          </group>
        </>
      )}

      {drawCell && <UnitCell cell={cell as number[][]} showAxes={showAxes} />}

      {drawEnergy && (
        <EnergyReadout
          energies={energies}
          position={renderCursor}
          anchor={panel.anchor}
          width={panel.width}
          height={panel.height}
          title={label ?? (isNeb ? "NEB migration path" : "Relaxation")}
          barrierEv={barrierEv}
          accent={isNeb ? "#c084fc" : "#5eead4"}
        />
      )}
    </group>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Sample every atom at continuous frame position `t` with a uniform
 * Catmull-Rom through the frames, endpoints clamped.
 *
 * Writes into `out` (flat xyz triples) and allocates nothing, so this is safe
 * to call every animation frame.
 */
export function sampleCatmullRom(
  flat: Float32Array,
  nFrames: number,
  nAtoms: number,
  t: number,
  out: Float32Array,
): void {
  if (nFrames === 1) {
    out.set(flat.subarray(0, nAtoms * 3));
    return;
  }
  const clamped = clamp(t, 0, nFrames - 1);
  const i1 = Math.min(nFrames - 1, Math.floor(clamped));
  const f = clamped - i1;
  const i0 = Math.max(0, i1 - 1);
  const i2 = Math.min(nFrames - 1, i1 + 1);
  const i3 = Math.min(nFrames - 1, i1 + 2);

  const s = nAtoms * 3;
  const b0 = i0 * s;
  const b1 = i1 * s;
  const b2 = i2 * s;
  const b3 = i3 * s;

  const f2 = f * f;
  const f3 = f2 * f;
  // Standard uniform Catmull-Rom basis (tension 0.5).
  const w0 = -0.5 * f3 + f2 - 0.5 * f;
  const w1 = 1.5 * f3 - 2.5 * f2 + 1;
  const w2 = -1.5 * f3 + 2 * f2 + 0.5 * f;
  const w3 = 0.5 * f3 - 0.5 * f2;

  for (let k = 0; k < s; k++) {
    out[k] = flat[b0 + k] * w0 + flat[b1 + k] * w1 + flat[b2 + k] * w2 + flat[b3 + k] * w3;
  }
}

/**
 * Where the energy panel sits, and how big it is, for a given content sphere.
 * Shared by the component and by `trajectoryFraming` so the two can never
 * disagree about how much headroom the panel needs.
 */
export function energyPanelLayout(
  center: readonly number[],
  radius: number,
): { anchor: Vec3; width: number; height: number; top: number } {
  const width = Math.max(3.5, radius * 0.72);
  const height = width * 0.3;
  // Bottom edge of the card clears the top of the content sphere.
  const bottom = center[1] + radius * 1.0;
  const anchor: Vec3 = [center[0], bottom + height, center[2]];
  return { anchor, width, height, top: bottom + height * 2 };
}

/**
 * Framing helper for the app shell: the sphere the camera should frame.
 *
 * By default this reserves room for the energy panel above the structure,
 * because `TrajectoryView` draws one whenever energies are supplied. Pass
 * `energyPanel: false` to frame the structure alone.
 */
export function trajectoryFraming(
  frames: Frame[],
  cell: Cell,
  options: { energyPanel?: boolean } = {},
) {
  const base = trajectoryBoundingSphere(frames, cell);
  if (options.energyPanel === false) return base;

  const { top } = energyPanelLayout(base.center, base.radius);
  // Grow the sphere just enough to contain the card's top edge, keeping the
  // structure itself inside it.
  const bottom = base.center[1] - base.radius;
  const center: [number, number, number] = [
    base.center[0],
    (top + bottom) / 2,
    base.center[2],
  ];
  const halfHeight = (top - bottom) / 2;
  return { center, radius: Math.max(base.radius, halfHeight) };
}

/** Framing helper for a single structure, re-exported for symmetry. */
export { boundingSphere };
