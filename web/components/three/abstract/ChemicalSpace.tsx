"use client";

/**
 * Every candidate the campaign has seen, as a point in 3D property space.
 *
 * The inputs are raw physical values — eV, eV/atom, angstroms — whose
 * magnitudes differ by orders of magnitude, so each axis is normalized to its
 * own observed range and nothing about the range is hardcoded. A late-arriving
 * outlier rescales the space; `PointCloud` damps the points to their new homes
 * so the cloud glides instead of snapping.
 *
 * Pareto rank drives color and size: rank 0 reads as special (warm, larger, a
 * soft halo), deeper shells recede into cool grey, and candidates with no rank
 * yet stay deliberately neutral — never frontier.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Billboard, Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { AxisFrame } from "./AxisFrame";
import { PointCloud, type CloudItem } from "./PointCloud";
import { CHROME, CLOUD, DAMP_LAMBDA } from "./theme";
import { axisRanges, damp, formatValue, isVec3, normalizeVec3, type Vec3 } from "./math";

export interface ChemicalSpaceProps {
  points: Record<string, Vec3>;
  labels?: Record<string, string>;
  axisLabels?: [string, string, string];
  paretoRank?: Record<string, number>;
  selectedId?: string | null;
  flythrough?: boolean;
  onSelect?: (candidateId: string) => void;
  /** Depth fog. On by default; only applied when the scene has no fog of its
   *  own, and restored on unmount. */
  fog?: boolean;
}

const HALF = 1; // the cloud always occupies [-1, 1]^3 after normalization
const CLOUD_RADIUS = Math.sqrt(3) * HALF;

const SHELL = new THREE.Color(CLOUD.shell);
const DEEP = new THREE.Color(CLOUD.deepShell);
const scratch = new THREE.Color();

/**
 * Depth fog tied to the camera, not to a fixed distance — the shell frames the
 * camera off the content's bounding sphere, so any constant near/far would be
 * wrong at some zoom.
 */
function CameraFog() {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const owned = useRef(false);
  const fog = useMemo(() => new THREE.Fog(0x070b12, 1, 10), []);

  useEffect(() => {
    if (scene.fog) return; // someone else owns it; leave it alone
    // Fog has to be the colour the shell actually clears to, or the cloud
    // fades into a visible band of the wrong colour.
    if (scene.background instanceof THREE.Color) {
      fog.color.copy(scene.background);
    } else {
      const clear = new THREE.Color();
      gl.getClearColor(clear);
      if (clear.r + clear.g + clear.b > 0) fog.color.copy(clear);
    }
    scene.fog = fog;
    owned.current = true;
    return () => {
      if (owned.current && scene.fog === fog) scene.fog = null;
      owned.current = false;
    };
  }, [scene, gl, fog]);

  useFrame((state) => {
    if (!owned.current) return;
    const d = state.camera.position.length();
    fog.near = Math.max(0.1, d - CLOUD_RADIUS * 1.1);
    fog.far = d + CLOUD_RADIUS * 1.8;
  });
  return null;
}

/** Slow drift through the cloud. Only mounted when `flythrough` is on, because
 *  it writes the camera, which otherwise belongs to the app shell. */
function Flythrough({ enabled }: { enabled: boolean }) {
  const camera = useThree((s) => s.camera);
  const t = useRef(0);
  const target = useRef(new THREE.Vector3());
  const home = useRef<THREE.Vector3 | null>(null);

  useEffect(() => {
    if (!enabled) return;
    home.current = camera.position.clone();
    const saved = home.current;
    return () => {
      camera.position.copy(saved);
      camera.lookAt(0, 0, 0);
    };
  }, [enabled, camera]);

  useFrame((_, dt) => {
    if (!enabled) return;
    t.current += Math.min(dt, 0.1);
    const a = t.current * 0.13;
    // A wide lissajous that passes through the cloud instead of orbiting it:
    // the point of a flythrough is parallax between near and far candidates.
    const r = 2.9 + 1.5 * Math.sin(a * 0.61);
    const next = new THREE.Vector3(
      Math.cos(a) * r,
      0.9 * Math.sin(a * 0.47) + 0.35,
      Math.sin(a * 1.13) * r * 0.82,
    );
    camera.position.lerp(next, 1 - Math.exp(-1.6 * Math.min(dt, 0.1)));
    target.current.set(
      0.45 * Math.sin(a * 0.83),
      0.3 * Math.cos(a * 0.7),
      0.45 * Math.cos(a * 0.9),
    );
    camera.lookAt(target.current);
  });
  return null;
}


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

export function ChemicalSpace({
  points,
  labels,
  axisLabels,
  paretoRank,
  selectedId,
  flythrough = false,
  onSelect,
  fog = true,
}: ChemicalSpaceProps): React.JSX.Element | null {
  const [hovered, setHovered] = useState<string | null>(null);

  const entries = useMemo(() => {
    if (!points || typeof points !== "object") return [];
    return Object.entries(points)
      .filter((e): e is [string, Vec3] => isVec3(e[1]))
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }, [points]);

  const ranges = useMemo(() => axisRanges(entries.map((e) => e[1])), [entries]);

  const maxRank = useMemo(() => {
    let m = 0;
    for (const r of Object.values(paretoRank ?? {})) {
      if (Number.isFinite(r)) m = Math.max(m, r as number);
    }
    return m;
  }, [paretoRank]);

  const items = useMemo<CloudItem[]>(
    () =>
      entries.map(([id, raw]) => {
        const rank = paretoRank?.[id];
        const ranked = typeof rank === "number" && Number.isFinite(rank);
        let color: string;
        let scale: number;
        if (!ranked) {
          color = CLOUD.unranked;
          scale = 0.85;
        } else if (rank === 0) {
          color = CLOUD.frontier;
          scale = 1.75;
        } else {
          const t = maxRank > 1 ? Math.min(1, (rank! - 1) / (maxRank - 1)) : 0;
          color = `#${scratch.copy(SHELL).lerp(DEEP, 0.35 + 0.65 * t).getHexString()}`;
          scale = 1.15 - 0.35 * t;
        }
        return { id, position: normalizeVec3(raw, ranges, HALF), color, scale };
      }),
    [entries, paretoRank, ranges, maxRank],
  );

  const frontierItems = useMemo(
    () =>
      items
        .filter((i) => paretoRank?.[i.id] === 0)
        .map((i) => ({ ...i, color: CLOUD.frontierGlow, scale: i.scale * 3.4 })),
    [items, paretoRank],
  );

  const positionById = useMemo(() => {
    const out: Record<string, Vec3> = {};
    for (const i of items) out[i.id] = i.position;
    return out;
  }, [items]);

  // Gentle breathing of the whole cloud: enough motion to read as live without
  // competing with the data.
  const groupRef = useRef<THREE.Group>(null);
  useFrame((state, dt) => {
    const g = groupRef.current;
    if (!g) return;
    g.rotation.y = damp(
      g.rotation.y,
      0.04 * Math.sin(state.clock.elapsedTime * 0.12),
      DAMP_LAMBDA * 0.3,
      dt,
    );
  });

  if (!entries.length) return null;

  const focusId = hovered ?? selectedId ?? null;
  const focusPos = focusId ? positionById[focusId] : undefined;
  const focusRaw = focusId ? points?.[focusId] : undefined;

  return (
    <group>
      {fog && <CameraFog />}
      <Flythrough enabled={flythrough} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[3, 6, 4]} intensity={0.7} />
      <directionalLight position={[-4, -2, -3]} intensity={0.2} color="#7dd3fc" />

      <group ref={groupRef}>
        <AxisFrame half={HALF} axisLabels={axisLabels} ranges={ranges} />
        {frontierItems.length > 0 && (
          <PointCloud items={frontierItems} baseRadius={0.03} opacity={0.55} glow />
        )}
        <PointCloud
          items={items}
          baseRadius={0.03}
          selectedId={selectedId}
          hoveredId={hovered}
          onSelect={onSelect}
          onHover={setHovered}
        />
        {selectedId && positionById[selectedId] && (
          <SelectionRing position={positionById[selectedId]} color={CHROME.selection} />
        )}
        {focusPos && (
          <Html position={focusPos} center zIndexRange={[40, 30]} style={{ pointerEvents: "none" }}>
            <div
              style={{
                transform: "translate(0, -28px)",
                padding: "6px 9px",
                borderRadius: 5,
                whiteSpace: "nowrap",
                background: "rgba(8,13,22,0.93)",
                border: "1px solid rgba(148,163,184,0.35)",
                boxShadow: "0 8px 22px rgba(0,0,0,0.55)",
                fontFamily: "ui-sans-serif, system-ui, sans-serif",
                color: "#e2e8f0",
                fontSize: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 7,
                    background:
                      paretoRank?.[focusId!] === 0 ? CLOUD.frontier : CLOUD.shell,
                    display: "inline-block",
                  }}
                />
                {labels?.[focusId!] ?? focusId}
                {paretoRank?.[focusId!] === 0 && (
                  <span style={{ color: CLOUD.frontier, fontSize: 9.5, letterSpacing: "0.1em" }}>
                    FRONTIER
                  </span>
                )}
              </div>
              {isVec3(focusRaw) && (
                <div
                  style={{
                    marginTop: 3,
                    fontSize: 10,
                    color: CHROME.labelDim,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  }}
                >
                  {formatValue(focusRaw[0])} · {formatValue(focusRaw[1])} ·{" "}
                  {formatValue(focusRaw[2])}
                </div>
              )}
            </div>
          </Html>
        )}
      </group>
    </group>
  );
}
