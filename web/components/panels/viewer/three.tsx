"use client";

/**
 * ===========================================================================
 * THE SWAP FILE — the one place the app shell imports 3D components from.
 * ===========================================================================
 * All six contract components are now real. Nothing here is a placeholder.
 *
 *   structure views + element tables -> components/three/structure (agent E)
 *   abstract/reasoning views         -> components/three/abstract  (agent F)
 *
 * Lighting, which the shell has to get right per component:
 *   StructureView / TrajectoryView / AdsorptionSites mount their own rig
 *     (`lights` defaults to true)      -> the shell must NOT add lights
 *   VoidSurface mounts no lights       -> the shell MUST light it
 *   All of agent F's views are self-lit -> the shell must NOT add lights
 * `Viewer.tsx` encodes this as `selfLit` on each scene.
 */

// --- agent E: structural views, element tables, framing helpers ------------
export {
  StructureView,
  TrajectoryView,
  VoidSurface,
  AdsorptionSites,
  structureBoundingSphere,
  trajectoryFraming,
  ELEMENT_COLORS,
  ELEMENT_RADII,
  VDW_RADII,
  COVALENT_RADII,
  elementColor,
  elementRadius,
  covalentRadius,
  vdwRadius,
  normalizeElement,
} from "@/components/three/structure";

export type {
  StructureViewProps,
  TrajectoryViewProps,
  VoidSurfaceProps,
  AdsorptionSitesProps,
  BoundingSphere,
  Bond,
  Cell,
  Frame,
  StructureData,
  TrajectoryData,
  Vec3,
} from "@/components/three/structure";

// --- agent F: abstract reasoning-space views -------------------------------
export {
  HypothesisTree,
  ChemicalSpace,
  ParetoSurface,
} from "@/components/three/abstract";

export type {
  HypothesisTreeProps,
  ChemicalSpaceProps,
  ParetoSurfaceProps,
} from "@/components/three/abstract";
