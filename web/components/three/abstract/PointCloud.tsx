"use client";

/**
 * Instanced, pickable, self-animating point cloud — the shared substrate of
 * ChemicalSpace and ParetoSurface.
 *
 * Two things it has to get right for a live campaign:
 *  - A new point arriving rescales the axes, which moves every other point.
 *    Positions are therefore damped toward their targets rather than snapped,
 *    so the cloud glides instead of jumping once per event.
 *  - Animation state lives in a ref keyed by candidate id, so a re-render with
 *    one extra point does not restart anything that is already on screen.
 *
 * One InstancedMesh, so a thousand candidates stay a single draw call.
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { DAMP_LAMBDA } from "./theme";
import { makeGlowTexture } from "./glow";
import { damp, isVec3, type Vec3 } from "./math";

export interface CloudItem {
  id: string;
  position: Vec3;
  color: string;
  /** World radius multiplier, 1 = base radius. */
  scale: number;
  /** 0..1, scales emissive punch. Frontier points use this to read as special. */
  glow?: number;
}

export interface PointCloudProps {
  items: CloudItem[];
  baseRadius?: number;
  selectedId?: string | null;
  hoveredId?: string | null;
  onSelect?: (id: string) => void;
  onHover?: (id: string | null) => void;
  opacity?: number;
  /** Render as camera-facing additive glow sprites instead of lit spheres.
   *  A translucent lit sphere reads as a dark blob on a dark background; an
   *  additive sprite with a radial falloff reads as light. */
  glow?: boolean;
}

interface Anim {
  p: Vec3;
  scale: number;
  spawned: boolean;
}

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpTarget = new THREE.Color();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export function PointCloud({
  items,
  baseRadius = 0.035,
  selectedId,
  hoveredId,
  onSelect,
  onHover,
  opacity = 1,
  glow = false,
}: PointCloudProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const anim = useRef<Map<string, Anim>>(new Map());
  const colors = useRef<Map<string, THREE.Color>>(new Map());

  // Grow the buffer in powers of two: reallocating on every single arrival
  // would throw away the animation mid-flight.
  const capacity = useMemo(() => {
    const n = Math.max(items.length, 1);
    return Math.max(64, 2 ** Math.ceil(Math.log2(n)));
  }, [items.length]);

  const geometry = useMemo(
    () => (glow ? new THREE.PlaneGeometry(2, 2) : new THREE.SphereGeometry(1, 20, 14)),
    [glow],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  const glowMap = useMemo(() => (glow ? makeGlowTexture() : null), [glow]);
  useEffect(() => () => glowMap?.dispose(), [glowMap]);

  // InstancedMesh does not allocate instanceColor for us.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }, [capacity]);

  // Drop animation state for candidates that are gone (replay restart).
  useEffect(() => {
    const live = new Set(items.map((i) => i.id));
    for (const id of Array.from(anim.current.keys())) {
      if (!live.has(id)) anim.current.delete(id);
    }
    for (const id of Array.from(colors.current.keys())) {
      if (!live.has(id)) colors.current.delete(id);
    }
  }, [items]);

  useFrame((state, dt) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // Glow sprites are quads, so they are turned to face the camera here
    // rather than through a per-point <Billboard> (one draw call, not N).
    if (glow) tmpQuat.copy(state.camera.quaternion);
    const count = Math.min(items.length, capacity);
    mesh.count = count;

    for (let i = 0; i < count; i++) {
      const item = items[i];
      const target = isVec3(item.position) ? item.position : [0, 0, 0];
      let a = anim.current.get(item.id);
      if (!a) {
        // Spawn at the target, pulled a little toward the origin, at zero size:
        // the point then grows and settles instead of popping into existence.
        a = { p: [target[0] * 0.82, target[1] * 0.82, target[2] * 0.82], scale: 0, spawned: false };
        anim.current.set(item.id, a);
      }
      const emphasis = item.id === selectedId ? 1.55 : item.id === hoveredId ? 1.3 : 1;
      const wanted = Math.max(0.0001, item.scale) * emphasis;
      a.p[0] = damp(a.p[0], target[0], DAMP_LAMBDA, dt);
      a.p[1] = damp(a.p[1], target[1], DAMP_LAMBDA, dt);
      a.p[2] = damp(a.p[2], target[2], DAMP_LAMBDA, dt);
      a.scale = damp(a.scale, wanted, DAMP_LAMBDA * 1.4, dt);
      a.spawned = true;

      const r = baseRadius * a.scale;
      if (glow) {
        tmpPos.set(a.p[0], a.p[1], a.p[2]);
        tmpScale.setScalar(r);
        tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
      } else {
        tmpMatrix.makeScale(r, r, r);
        tmpMatrix.setPosition(a.p[0], a.p[1], a.p[2]);
      }
      mesh.setMatrixAt(i, tmpMatrix);

      let c = colors.current.get(item.id);
      if (!c) {
        c = new THREE.Color(item.color);
        colors.current.set(item.id, c);
      }
      tmpTarget.set(item.color);
      c.lerp(tmpTarget, 1 - Math.exp(-DAMP_LAMBDA * Math.min(dt, 0.1)));
      mesh.setColorAt(i, c);
    }
    for (let i = count; i < capacity; i++) mesh.setMatrixAt(i, HIDDEN);

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  });

  const pick = (e: ThreeEvent<PointerEvent | MouseEvent>): string | null => {
    const i = e.instanceId;
    if (i === undefined || i < 0 || i >= items.length) return null;
    return items[i].id;
  };

  return (
    <instancedMesh
      key={capacity}
      ref={meshRef}
      args={[geometry, undefined, capacity]}
      frustumCulled={false}
      onPointerMove={(e) => {
        if (!onHover) return;
        e.stopPropagation();
        onHover(pick(e));
      }}
      onPointerOut={(e) => {
        if (!onHover) return;
        e.stopPropagation();
        onHover(null);
      }}
      onClick={(e) => {
        if (!onSelect) return;
        const id = pick(e);
        if (!id) return;
        e.stopPropagation();
        onSelect(id);
      }}
    >
      {glow ? (
        <meshBasicMaterial
          map={glowMap}
          transparent
          opacity={opacity}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
          fog={false}
        />
      ) : (
      <meshStandardMaterial
        roughness={0.38}
        metalness={0.12}
        emissiveIntensity={0.55}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity >= 1}
        toneMapped={false}
      />
      )}
    </instancedMesh>
  );
}
