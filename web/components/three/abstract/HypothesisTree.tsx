"use client";

/**
 * The hypothesis tree: the campaign's reasoning, drawn as it happens.
 *
 * Each hypothesis is a node, `parent_id` gives the edges, `branch` splays
 * parallel lines of attack into their own directions, and `round` drives depth.
 * Verdicts are carried by color and light, and a refuted hypothesis takes its
 * whole subtree dark — that is the picture of a research program killing its
 * own idea, which is the thing this product actually does.
 *
 * Design notes:
 *  - Layout is sticky (see treeLayout.ts): a node never moves once placed, so
 *    the growth animation reads as growth and not as a reshuffle.
 *  - Every animation is a damped approach to a target held in a ref, so a
 *    re-render with one more node (which happens on every event) interrupts
 *    nothing and restarts nothing.
 *  - Labels are DOM (`Html`), because drei's `Text` pulls a font off a CDN and
 *    the demo must run offline.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Billboard, Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { CHROME, DAMP_LAMBDA, TREE, VERDICT_COLORS, verdictColor } from "./theme";
import { damp, truncate, type Vec3 } from "./math";
import {
  EMPTY_LAYOUT,
  layoutTree,
  nodeStates,
  type NodeState,
  type PlacedNode,
  type TreeLayout,
  type TreeNodeInput,
} from "./treeLayout";

export interface HypothesisTreeProps {
  nodes: TreeNodeInput[];
  selectedId?: string | null;
  onSelect?: (hypothesisId: string) => void;
}

const SPAWN_STAGGER = 0.07; // seconds between nodes on a bulk (replayed) mount

const SCRATCH = new THREE.Color();
const HSL = { h: 0, s: 0, l: 0 };

/** One hypothesis. Owns its own animation so the tree can re-render freely. */
function TreeNode({
  node,
  state,
  verdict,
  selected,
  hovered,
  geometry,
  delay,
  onSelect,
  onHover,
}: {
  node: PlacedNode;
  state: NodeState;
  verdict: TreeNodeInput["verdict"];
  selected: boolean;
  hovered: boolean;
  geometry: THREE.SphereGeometry;
  delay: number;
  onSelect?: (id: string) => void;
  onHover?: (id: string | null) => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  const clock = useRef(0);
  const scale = useRef(0);
  const current = useRef({ opacity: 1, emissive: 0.5 });
  const color = useRef(new THREE.Color(verdictColor(verdict)));
  const targetColor = useMemo(() => new THREE.Color(verdictColor(verdict)), [verdict]);

  useFrame((_, dt) => {
    clock.current += dt;
    const mesh = meshRef.current;
    const mat = matRef.current;
    if (!mesh || !mat) return;

    const live = clock.current > delay;
    const emphasis = selected ? 1.5 : hovered ? 1.25 : 1;
    // Refuted nodes also shrink a little: dead ideas should not compete for
    // attention with live ones, but must stay big enough to read.
    const sizeForState = state.refuted ? 0.82 : state.shadowed ? 0.9 : 1;
    scale.current = damp(scale.current, live ? emphasis * sizeForState : 0, DAMP_LAMBDA * 1.3, dt);
    mesh.scale.setScalar(Math.max(scale.current, 0.0001));

    const pulse = verdict === null ? 0.1 + 0.07 * Math.sin(clock.current * 2.1) : 0;
    const targetOpacity = live ? state.opacity : 0;
    const targetEmissive = (state.refuted ? 0.16 : state.shadowed ? 0.3 : 0.62) + pulse;
    current.current.opacity = damp(current.current.opacity, targetOpacity, DAMP_LAMBDA * 0.9, dt);
    current.current.emissive = damp(current.current.emissive, targetEmissive, DAMP_LAMBDA, dt);

    // A verdict landing is an event worth watching: ease into the new color
    // over ~1s rather than cutting. `color.current` holds the undimmed value;
    // desaturation is applied to a scratch copy so it cannot compound.
    color.current.lerp(targetColor, 1 - Math.exp(-2.2 * Math.min(dt, 0.1)));
    SCRATCH.copy(color.current);
    if (state.refuted || state.shadowed) {
      SCRATCH.getHSL(HSL);
      SCRATCH.setHSL(
        HSL.h,
        HSL.s * (state.refuted ? 0.45 : 0.75),
        HSL.l * (state.refuted ? 0.78 : 0.92),
      );
    }
    mat.color.copy(SCRATCH);
    mat.emissive.copy(SCRATCH);
    mat.emissiveIntensity = current.current.emissive;
    mat.opacity = current.current.opacity;
  });

  return (
    <group position={node.position}>
      <mesh
        ref={meshRef}
        geometry={geometry}
        onPointerOver={(e) => {
          e.stopPropagation();
          onHover?.(node.id);
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          onHover?.(null);
        }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect?.(node.id);
        }}
      >
        <meshStandardMaterial
          ref={matRef}
          transparent
          depthWrite={!state.refuted}
          roughness={0.3}
          metalness={0.1}
          toneMapped={false}
        />
      </mesh>
      {selected && (
        <Billboard>
          <mesh>
            <ringGeometry args={[TREE.nodeRadius * 1.6, TREE.nodeRadius * 1.78, 48]} />
            <meshBasicMaterial
              color={CHROME.selection}
              transparent
              opacity={0.75}
              side={THREE.DoubleSide}
              toneMapped={false}
            />
          </mesh>
        </Billboard>
      )}
    </group>
  );
}

/** Edges as one buffer: a deep campaign has hundreds, and each drei `Line`
 *  would be its own draw call. */
function TreeEdges({
  layout,
  states,
  verdicts,
}: {
  layout: TreeLayout;
  states: Record<string, NodeState>;
  verdicts: Record<string, TreeNodeInput["verdict"]>;
}) {
  const geometry = useMemo(() => {
    const SEG = 10;
    const verts: number[] = [];
    const cols: number[] = [];
    const from = new THREE.Color();
    const to = new THREE.Color();
    const c = new THREE.Color();
    for (const edge of layout.edges) {
      const childState = states[edge.childId];
      const parentState = states[edge.parentId];
      const dim = Math.min(childState?.opacity ?? 1, parentState?.opacity ?? 1);
      from.set(verdictColor(verdicts[edge.parentId] ?? null));
      to.set(verdictColor(verdicts[edge.childId] ?? null));
      let prev: Vec3 | null = null;
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG;
        // Smoothstep on the horizontal only: edges leave a parent vertically
        // and arrive at a child vertically, like a dendrogram.
        const e = t * t * (3 - 2 * t);
        const p: Vec3 = [
          edge.from[0] + (edge.to[0] - edge.from[0]) * e,
          edge.from[1] + (edge.to[1] - edge.from[1]) * t,
          edge.from[2] + (edge.to[2] - edge.from[2]) * e,
        ];
        if (prev) {
          c.copy(from).lerp(to, t).multiplyScalar(0.55 * dim + 0.1);
          verts.push(...prev, ...p);
          cols.push(c.r, c.g, c.b, c.r, c.g, c.b);
        }
        prev = p;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    return g;
  }, [layout, states, verdicts]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  if (!layout.edges.length) return null;
  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent opacity={0.95} />
    </lineSegments>
  );
}

/** Faint ring per round, so depth reads as campaign time. */
function RoundRings({ layout }: { layout: TreeLayout }) {
  const geometry = useMemo(() => {
    const verts: number[] = [];
    const SEG = 72;
    for (let d = 0; d <= layout.maxDepth; d++) {
      const r = (layout.radiusByDepth[d] ?? 0) + 0.9;
      const y = d * TREE.levelHeight;
      for (let s = 0; s < SEG; s++) {
        const a0 = (s / SEG) * Math.PI * 2;
        const a1 = ((s + 1) / SEG) * Math.PI * 2;
        verts.push(Math.cos(a0) * r, y, Math.sin(a0) * r, Math.cos(a1) * r, y, Math.sin(a1) * r);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    return g;
  }, [layout.maxDepth, layout.radiusByDepth]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group>
      <lineSegments geometry={geometry} frustumCulled={false}>
        <lineBasicMaterial color={CHROME.grid} transparent opacity={0.55} />
      </lineSegments>
      {Array.from({ length: layout.maxDepth + 1 }, (_, d) => (
        <Html
          key={d}
          position={[(layout.radiusByDepth[d] ?? 0) + 1.15, d * TREE.levelHeight, 0]}
          center
          zIndexRange={[12, 6]}
          style={{ pointerEvents: "none" }}
        >
          <div
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 10,
              letterSpacing: "0.16em",
              color: CHROME.labelDim,
              whiteSpace: "nowrap",
              textShadow: "0 1px 3px rgba(0,0,0,0.9)",
            }}
          >
            R{d + 1}
          </div>
        </Html>
      ))}
    </group>
  );
}

function VerdictChip({ verdict }: { verdict: TreeNodeInput["verdict"] }) {
  const label = verdict ?? "OPEN";
  const color = verdictColor(verdict);
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: 3,
        border: `1px solid ${color}`,
        color,
        fontSize: 9.5,
        letterSpacing: "0.12em",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}
    >
      {label}
    </span>
  );
}

export function HypothesisTree({
  nodes,
  selectedId,
  onSelect,
}: HypothesisTreeProps): React.JSX.Element | null {
  const [hovered, setHovered] = useState<string | null>(null);
  const layoutRef = useRef<TreeLayout>(EMPTY_LAYOUT);
  const groupRef = useRef<THREE.Group>(null);

  const safeNodes = useMemo(
    () =>
      (Array.isArray(nodes) ? nodes : []).filter(
        (n): n is TreeNodeInput => !!n && typeof n.id === "string" && n.id.length > 0,
      ),
    [nodes],
  );

  // Sticky: feed the previous layout back in so nothing already on screen can
  // be moved by a re-ordered or rebuilt `nodes` array.
  const layout = useMemo(() => {
    const next = layoutTree(safeNodes, layoutRef.current);
    layoutRef.current = next;
    return next;
  }, [safeNodes]);

  const states = useMemo(() => nodeStates(safeNodes), [safeNodes]);
  const verdicts = useMemo(() => {
    const out: Record<string, TreeNodeInput["verdict"]> = {};
    for (const n of safeNodes) if (!(n.id in out)) out[n.id] = n.verdict ?? null;
    return out;
  }, [safeNodes]);
  const byId = useMemo(() => {
    const out: Record<string, TreeNodeInput> = {};
    for (const n of safeNodes) if (!(n.id in out)) out[n.id] = n;
    return out;
  }, [safeNodes]);

  const geometry = useMemo(() => new THREE.SphereGeometry(TREE.nodeRadius, 32, 22), []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Recentre vertically as the tree grows, damped so it never jolts.
  const targetY = -(layout.maxDepth * TREE.levelHeight) / 2;
  useFrame((_, dt) => {
    const g = groupRef.current;
    if (!g) return;
    g.position.y = damp(g.position.y, targetY, DAMP_LAMBDA * 0.6, dt);
  });

  const focusId = hovered ?? selectedId ?? null;
  const focus = focusId ? layout.byId[focusId] : undefined;
  const focusNode = focusId ? byId[focusId] : undefined;

  if (!layout.nodes.length) return null;

  return (
    <group ref={groupRef}>
      <ambientLight intensity={0.5} />
      <directionalLight position={[4, 8, 6]} intensity={0.75} />
      <directionalLight position={[-6, 2, -4]} intensity={0.25} color="#93c5fd" />

      <RoundRings layout={layout} />
      <TreeEdges layout={layout} states={states} verdicts={verdicts} />

      {layout.nodes.map((placed) => (
        <TreeNode
          key={placed.id}
          node={placed}
          state={states[placed.id] ?? { opacity: 1, refuted: false, shadowed: false }}
          verdict={verdicts[placed.id] ?? null}
          selected={placed.id === selectedId}
          hovered={placed.id === hovered}
          geometry={geometry}
          delay={Math.min(placed.order * SPAWN_STAGGER, 1.6)}
          onSelect={onSelect}
          onHover={setHovered}
        />
      ))}

      {focus && focusNode && (
        <Html
          position={[focus.position[0], focus.position[1] + TREE.nodeRadius * 2.1, focus.position[2]]}
          center
          zIndexRange={[40, 30]}
          style={{ pointerEvents: "none" }}
        >
          <div
            style={{
              width: 288,
              transform: "translateY(-50%)",
              padding: "9px 11px",
              borderRadius: 6,
              background: "rgba(8,13,22,0.93)",
              border: `1px solid ${
                states[focusNode.id]?.refuted ? VERDICT_COLORS.REFUTED : "rgba(148,163,184,0.35)"
              }`,
              boxShadow: "0 10px 28px rgba(0,0,0,0.6)",
              fontFamily: "ui-sans-serif, system-ui, sans-serif",
              color: "#e2e8f0",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5 }}>
              <VerdictChip verdict={verdicts[focusNode.id] ?? null} />
              <span
                style={{
                  fontSize: 9.5,
                  letterSpacing: "0.1em",
                  color: CHROME.labelDim,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                }}
              >
                R{(focus.depth ?? 0) + 1} · {focus.branch} · {focusNode.id}
              </span>
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.42 }}>
              {truncate(focusNode.statement ?? "", 190)}
            </div>
          </div>
        </Html>
      )}
    </group>
  );
}
