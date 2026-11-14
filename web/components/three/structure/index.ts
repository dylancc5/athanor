/**
 * Public surface of the structural 3D components (agent E).
 *
 * The four components and the three element exports below are frozen by
 * `components/three/CONTRACT.md`. Everything else here is additive: helpers
 * the app shell and agent F may use, but which the contract does not promise.
 */

// --- contract: components --------------------------------------------------
export { StructureView, structureBoundingSphere } from "./StructureView";
export type { StructureViewProps } from "./StructureView";

export { TrajectoryView, trajectoryFraming } from "./TrajectoryView";
export type { TrajectoryViewProps } from "./TrajectoryView";

export { VoidSurface } from "./VoidSurface";
export type { VoidSurfaceProps } from "./VoidSurface";

export { AdsorptionSites } from "./AdsorptionSites";
export type { AdsorptionSitesProps } from "./AdsorptionSites";

// --- contract: element tables ---------------------------------------------
export {
  COVALENT_RADII,
  ELEMENT_COLORS,
  ELEMENT_RADII,
  IONIC_CATIONS,
  VDW_RADII,
  VERDICT_COLORS,
  covalentRadius,
  elementColor,
  elementRadius,
  normalizeElement,
  vdwRadius,
} from "../elements";

// --- contract: shared types -----------------------------------------------
export type {
  BoundingSphere,
  Bond,
  Cell,
  CellParameters,
  Frame,
  StructureData,
  TrajectoryData,
  Vec3,
} from "./types";

// --- additive: building blocks --------------------------------------------
export { AtomInstances } from "./AtomInstances";
export type { AtomInstancesHandle, AtomInstancesProps } from "./AtomInstances";
export { BondInstances } from "./BondInstances";
export type { BondInstancesHandle, BondInstancesProps } from "./BondInstances";
export { CoordinationPolyhedra } from "./CoordinationPolyhedra";
export { EnergyReadout } from "./EnergyReadout";
export { IonPath, SiteGhost, useGlowTexture, useIonCurve } from "./IonPath";
export { StructureLights } from "./Lights";
export { UnitCell } from "./UnitCell";

// --- additive: data helpers ------------------------------------------------
export { convexHullFaces } from "./convex-hull";
export { computeSmoothNormals, marchingTetrahedra } from "./marching-cubes";
export type { IsosurfaceResult } from "./marching-cubes";
export {
  normalizeGuests,
  normalizeIndices,
  normalizeStructure,
  normalizeSupercell,
  normalizeTrajectory,
  normalizeVoidGrid,
} from "./normalize";
export type { GuestData, VoidGridData } from "./normalize";
