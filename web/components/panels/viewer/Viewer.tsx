"use client";

/**
 * The 3D region. The app shell owns the single <Canvas>, the lights, the
 * OrbitControls and the camera — agents E and F render inside it and bring
 * none of those. The camera is positioned from the content's bounding sphere,
 * so nothing downstream may assume a camera distance.
 */

import { useEffect, useMemo, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Bounds, OrbitControls } from "@react-three/drei";
import { Panel } from "@/components/ui/Panel";
import { Button, Chip } from "@/components/ui/Bits";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { candidateLabels, paretoRankMap } from "@/lib/campaign-state";
import { useCampaign } from "@/lib/store";
import {
  VIEWS,
  artifactForView,
  asFramesPayload,
  asVoidPayload,
  embeddingAxisLabels,
  relaxedStructure,
  viewAvailable,
  type ViewName,
} from "@/lib/views";
import {
  type BoundingSphere,
  ChemicalSpace,
  HypothesisTree,
  ParetoSurface,
  StructureView,
  TrajectoryView,
  VoidSurface,
  trajectoryFraming,
} from "./three";

// --------------------------------------------------------------------------
// Camera framing
// --------------------------------------------------------------------------
//
// The camera is fitted to the real bounding box of whatever got rendered,
// measured by drei's <Bounds>, rather than to a radius this file guessed.
// That is what lets agents E and F change their internal scales without the
// shell having to know. Remounting <Bounds> (via `key`) refits.

/** Applies an explicit framing sphere (agent E's `trajectoryFraming`). */
function FrameToSphere({ sphere }: { sphere: BoundingSphere }) {
  const camera = useThree((st) => st.camera);
  const controls = useThree((st) => st.controls) as
    | { target: { set: (x: number, y: number, z: number) => void }; update: () => void }
    | null;
  const key = `${sphere.center.join(",")}|${sphere.radius}`;
  useEffect(() => {
    const [cx, cy, cz] = sphere.center;
    const d = sphere.radius * 2.5;
    camera.position.set(cx + d * 0.62, cy + d * 0.42, cz + d * 0.74);
    if ("near" in camera) {
      camera.near = Math.max(0.01, sphere.radius / 100);
      camera.far = sphere.radius * 40;
      camera.updateProjectionMatrix();
    }
    camera.lookAt(cx, cy, cz);
    controls?.target.set(cx, cy, cz);
    controls?.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, camera, controls]);
  return null;
}

function FitOnChange({
  signature,
  active,
  margin = 1.25,
  children,
}: {
  signature: string;
  /** false while a component drives the camera itself */
  active: boolean;
  margin?: number;
  children: React.ReactNode;
}) {
  if (!active) return <group>{children}</group>;
  return (
    <Bounds key={signature} fit clip observe margin={margin}>
      {children}
    </Bounds>
  );
}

// --------------------------------------------------------------------------
// Scene — picks the active view and hands it its data
// --------------------------------------------------------------------------

interface SceneData {
  node: React.ReactNode;
  /** changes whenever the content changes, so the camera refits */
  signature: string;
  caption: string | null;
  /**
   * Agent F's abstract views each mount their own ambient + two directional
   * lights so they are never black in isolation. The shell must therefore NOT
   * add its own on top, or those scenes blow out. Agent E's structure views
   * carry no lights, so the shell lights those.
   */
  selfLit: boolean;
  /** true when the mounted component drives the camera itself */
  drivesCamera: boolean;
  /**
   * An explicit framing sphere. Agent E's `trajectoryFraming` reserves
   * headroom for the energy card, which a plain content fit crops off the top
   * — and the NEB shot is the hero image of the demo.
   */
  framing?: BoundingSphere;
  /** number of frames, when the scene is a trajectory */
  frameCount?: number;
  /** Bounds fit margin; larger pulls the camera back. */
  margin?: number;
}

/** `frameIndex` is a fractional frame position, or null while autoplaying. */
function useScene(frameIndex: number | null): SceneData {
  const state = useCampaign((s) => s.state);
  const view = useCampaign((s) => s.view);
  const flythrough = useCampaign((s) => s.flythrough);
  const selected = useCampaign((s) => s.selectedCandidateId);
  const selectedHypothesis = useCampaign((s) => s.selectedHypothesisId);
  const payloads = useCampaign((s) => s.artifactPayloads);
  const ensureArtifact = useCampaign((s) => s.ensureArtifact);
  const selectCandidate = useCampaign((s) => s.selectCandidate);
  const selectHypothesis = useCampaign((s) => s.selectHypothesis);

  const artifact = artifactForView(state, view, selected);

  // load lazily, cached by id in the store
  useEffect(() => {
    if (artifact) ensureArtifact(artifact);
  }, [artifact, ensureArtifact]);

  const payload = artifact ? payloads[artifact.id] : undefined;

  return useMemo<SceneData>(() => {
    const fallback: SceneData = {
      node: null,
      signature: "empty",
      caption: null,
      selfLit: false,
      drivesCamera: false,
    };

    if (view === "structure") {
      const data = relaxedStructure(payload);
      if (!data) return fallback;
      return {
        node: <StructureView data={data} showCell highlight={undefined} />,
        signature: `structure:${artifact?.id ?? ""}:${data.positions.length}`,
        selfLit: true, // StructureView mounts its own light rig
        drivesCamera: false,
        caption: artifact?.label ?? null,
      };
    }

    if (view === "trajectory") {
      const p = asFramesPayload(payload);
      if (!p) return fallback;
      return {
        node: (
          <TrajectoryView
            symbols={p.symbols}
            cell={p.cell}
            pbc={p.pbc}
            frames={p.frames}
            energies={p.energies}
            mobileIndex={p.mobile_index}
            fps={10}
            {...(frameIndex === null ? {} : { frameIndex, playing: false })}
          />
        ),
        signature: `trajectory:${artifact?.id ?? ""}:${p.frames.length}`,
        selfLit: true, // TrajectoryView mounts its own light rig
        framing: trajectoryFraming(p.frames, p.cell),
        frameCount: p.frames.length,
        drivesCamera: false,
        caption:
          p.barrier_ev !== undefined
            ? `${artifact?.label ?? "NEB path"} — barrier ${p.barrier_ev.toFixed(3)} eV`
            : (artifact?.label ?? null),
      };
    }

    if (view === "void") {
      const p = asVoidPayload(payload);
      if (!p) return fallback;
      return {
        node: (
          <VoidSurface cell={p.cell} shape={p.shape} values={p.values} isoLevel={0.5} />
        ),
        signature: `void:${artifact?.id ?? ""}:${p.shape.join("x")}`,
        selfLit: false, // VoidSurface mounts no lights — the shell lights it
        drivesCamera: false,
        caption:
          p.void_fraction !== undefined
            ? `void fraction ${(p.void_fraction * 100).toFixed(1)}%${p.pore_diameter_A ? ` · pore ${p.pore_diameter_A.toFixed(1)} A` : ""}`
            : (artifact?.label ?? null),
      };
    }

    if (view === "space") {
      const points = state.embedding;
      if (Object.keys(points).length === 0) return fallback;
      // Recovered from the data — the embedding's dimension order is not the
      // spec's objective order, so naming them by position would mislabel them.
      const axisLabels = embeddingAxisLabels(state);
      return {
        node: (
          <ChemicalSpace
            points={points}
            labels={candidateLabels(state)}
            axisLabels={axisLabels}
            paretoRank={paretoRankMap(state)}
            selectedId={selected}
            flythrough={flythrough}
            onSelect={selectCandidate}
          />
        ),
        signature: `space:${Object.keys(points).length}:${flythrough ? "fly" : "orbit"}`,
        selfLit: true,
        drivesCamera: flythrough,
        caption: `${Object.keys(points).length} candidates in property space`,
      };
    }

    if (view === "pareto") {
      if (state.pareto.length === 0) return fallback;
      const objectives = state.spec?.objectives ?? [];
      const keys = objectives.map((o) => o.property);
      const present = keys.filter((k) =>
        state.pareto.some((p) => typeof p.values[k] === "number"),
      );
      if (present.length < 3) {
        return { ...fallback, caption: "needs three scored objectives for a surface" };
      }
      const axes = present.slice(0, 3) as [string, string, string];
      const byKey = new Map(objectives.map((o) => [o.property, o]));
      return {
        node: (
          <ParetoSurface
            points={state.pareto.map((p) => ({
              candidate_id: p.candidate_id,
              rank: p.rank,
              values: p.values,
              scalar_score: p.scalar_score,
            }))}
            axes={axes}
            axisLabels={
              axes.map(
                (k) => `${byKey.get(k)?.label ?? k} (${byKey.get(k)?.unit ?? ""})`,
              ) as [string, string, string]
            }
            directions={
              axes.map((k) => byKey.get(k)?.direction ?? "min") as (
                | "min"
                | "max"
                | "target"
              )[]
            }
            selectedId={selected}
            onSelect={selectCandidate}
          />
        ),
        signature: `pareto:${state.pareto.length}:${axes.join(",")}`,
        selfLit: true,
        drivesCamera: false,
        caption: `${state.pareto.filter((p) => p.rank === 0).length} of ${state.pareto.length} on the frontier`,
      };
    }

    if (view === "tree") {
      const nodes = state.hypothesisIds
        .map((id) => state.hypotheses[id])
        .filter(Boolean)
        .map((r) => ({
          id: r.hypothesis.id,
          parent_id: r.hypothesis.parent_id ?? null,
          round: r.hypothesis.round,
          branch: r.hypothesis.branch ?? "main",
          statement: r.hypothesis.statement,
          verdict: r.status === "OPEN" ? null : r.status,
        }));
      if (nodes.length === 0) return fallback;
      return {
        node: (
          <HypothesisTree
            nodes={nodes}
            selectedId={selectedHypothesis}
            onSelect={selectHypothesis}
          />
        ),
        signature: `tree:${nodes.map((n) => `${n.id}${n.verdict ?? ""}`).join("|")}`,
        // A one-node tree is a single sphere; fitting it tightly fills the
        // frame with a blob. Pull back hard when the tree is sparse.
        margin: nodes.length <= 1 ? 4.5 : nodes.length <= 3 ? 2.2 : 1.4,
        selfLit: true,
        drivesCamera: false,
        caption: `${nodes.length} hypotheses · refuted branches go dark`,
      };
    }

    return fallback;
  }, [
    view,
    flythrough,
    frameIndex,
    payload,
    artifact,
    state,
    selected,
    selectedHypothesis,
    selectCandidate,
    selectHypothesis,
  ]);
}

export function Viewer() {
  const state = useCampaign((s) => s.state);
  const view = useCampaign((s) => s.view);
  const setView = useCampaign((s) => s.setView);
  const selected = useCampaign((s) => s.selectedCandidateId);
  const [frameIndex, setFrameIndex] = useState<number | null>(null);
  const scene = useScene(frameIndex);
  useEffect(() => {
    if (view !== "trajectory") setFrameIndex(null);
  }, [view]);
  const flythrough = useCampaign((s) => s.flythrough);
  const setFlythrough = useCampaign((s) => s.setFlythrough);

  const def = VIEWS.find((v) => v.name === view);

  return (
    <Panel
      id="panel-viewer"
      title="Viewer"
      eyebrow={def?.blurb}
      right={
        selected ? (
          <Chip color="#38bdf8">{state.candidates[selected]?.name ?? selected}</Chip>
        ) : null
      }
      scroll={false}
      className="h-full"
      bodyClassName="relative flex flex-col"
    >
      <div className="no-print flex shrink-0 flex-wrap gap-1 border-b border-rule bg-panel-2/60 px-2 py-1.5">
        {VIEWS.map((v) => {
          const ok = viewAvailable(state, v.name, selected);
          return (
            <Button
              key={v.name}
              size="sm"
              active={view === v.name}
              disabled={!ok}
              title={ok ? v.blurb : `${v.blurb} — no data at this point in the campaign`}
              onClick={() => setView(v.name as ViewName)}
            >
              {v.label}
            </Button>
          );
        })}
        {view === "space" && viewAvailable(state, "space", selected) ? (
          <>
            <div className="mx-0.5 h-5 w-px self-center bg-rule" />
            <Button
              size="sm"
              active={flythrough}
              onClick={() => setFlythrough(!flythrough)}
              title={
                flythrough
                  ? "Stop the camera and take back orbit control"
                  : "Fly the camera slowly through the candidate cloud"
              }
            >
              Flythrough
            </Button>
          </>
        ) : null}
      </div>

      {view === "trajectory" && scene.frameCount && scene.frameCount > 1 ? (
        <div className="no-print flex shrink-0 items-center gap-2 border-b border-rule bg-panel-2/40 px-2 py-1.5">
          <Button
            size="sm"
            active={frameIndex === null}
            onClick={() => setFrameIndex(frameIndex === null ? 0 : null)}
            title={frameIndex === null ? "Pause the hop" : "Play the hop"}
          >
            {frameIndex === null ? "Playing" : "Play"}
          </Button>
          <input
            type="range"
            min={0}
            max={scene.frameCount - 1}
            step={0.01}
            value={frameIndex ?? 0}
            aria-label="Migration path frame"
            onChange={(e) => setFrameIndex(Number(e.target.value))}
            className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-rule
              [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-1.5
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-sm
              [&::-webkit-slider-thumb]:bg-accent
              [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-1.5
              [&::-moz-range-thumb]:rounded-sm [&::-moz-range-thumb]:border-none
              [&::-moz-range-thumb]:bg-accent"
          />
          <span className="num w-16 text-right text-[0.625rem] text-ink-faint">
            {frameIndex === null
              ? `${scene.frameCount} frames`
              : `${frameIndex.toFixed(2)} / ${scene.frameCount - 1}`}
          </span>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <ErrorBoundary label="viewer">
          <Canvas
            dpr={[1, 1.75]}
            gl={{ antialias: true, powerPreference: "high-performance" }}
            camera={{ fov: 42, position: [12, 9, 16] }}
            onCreated={({ gl }) => gl.setClearColor("#06080c")}
          >
            {/* Only light the scenes that are not already lit by their own
                component, or agent F's views blow out. */}
            {scene.selfLit ? null : (
              <>
                <ambientLight intensity={0.65} />
                <directionalLight position={[8, 14, 10]} intensity={1.1} />
                <directionalLight position={[-10, -6, -8]} intensity={0.35} />
              </>
            )}
            {/* A component that drives the camera (the flythrough) must not
                fight OrbitControls for it. */}
            <OrbitControls
              enableDamping
              dampingFactor={0.09}
              makeDefault
              enabled={!scene.drivesCamera}
            />
            {scene.framing && !scene.drivesCamera ? (
              <FrameToSphere
                key={`${view}:${scene.signature}`}
                sphere={scene.framing}
              />
            ) : null}
            <FitOnChange
              signature={`${view}:${scene.signature}`}
              active={!scene.drivesCamera && !scene.framing}
              margin={scene.margin}
            >
              {scene.node}
            </FitOnChange>
          </Canvas>
        </ErrorBoundary>

        {scene.node === null ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
            <p className="max-w-xs text-xs leading-relaxed text-ink-faint">
              {scene.caption ??
                "No data for this view yet. Views unlock as the campaign produces the artifacts behind them."}
            </p>
          </div>
        ) : scene.caption ? (
          <div className="pointer-events-none absolute bottom-1.5 left-1.5 right-1.5 flex items-end justify-between gap-2">
            <span className="num rounded border border-rule bg-ground/85 px-1.5 py-1 text-[0.625rem] text-ink-dim backdrop-blur">
              {scene.caption}
            </span>
            <span className="label rounded border border-rule bg-ground/85 px-1.5 py-1 backdrop-blur">
              drag to orbit · scroll to zoom
            </span>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
