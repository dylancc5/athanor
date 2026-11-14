/** Abstract (reasoning-space) 3D views. See ../CONTRACT.md. */

export { HypothesisTree, type HypothesisTreeProps } from "./HypothesisTree";
export { ChemicalSpace, type ChemicalSpaceProps } from "./ChemicalSpace";
export { ParetoSurface, type ParetoSurfaceProps, type ParetoPointInput } from "./ParetoSurface";

export { AxisFrame, type AxisFrameProps } from "./AxisFrame";
export { PointCloud, type CloudItem, type PointCloudProps } from "./PointCloud";

export {
  VERDICT_COLORS,
  verdictColor,
  CHROME,
  CLOUD,
  REFUTED_OPACITY,
  SHADOWED_OPACITY,
  TREE,
} from "./theme";
export {
  layoutTree,
  nodeStates,
  EMPTY_LAYOUT,
  type TreeLayout,
  type TreeNodeInput,
  type PlacedNode,
  type NodeState,
} from "./treeLayout";
export { delaunay, frontierMesh, type FrontierMesh, type Tri, type P2 } from "./delaunay";
export {
  axisRanges,
  normalizeAxis,
  normalizeVec3,
  formatValue,
  truncate,
  type Range,
  type Vec3,
} from "./math";
