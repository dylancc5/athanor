/**
 * Deterministic, append-stable layout for the hypothesis tree.
 *
 * The campaign streams in: the tree is re-laid-out on every new hypothesis and
 * every verdict. So the one hard requirement is that a node, once placed, never
 * moves. Two mechanisms enforce that:
 *
 *  1. Positions are assigned from quantities that do not depend on the rest of
 *     the tree — a branch's direction is `branchIndex * GOLDEN_ANGLE` (not
 *     `i / branchCount`, which would rotate every branch when a new one opens),
 *     and a sibling's lateral offset comes from its own arrival slot.
 *  2. The caller may pass the previous `TreeLayout` back in; anything already
 *     placed is copied across verbatim, so even a re-sorted or rebuilt `nodes`
 *     array cannot shuffle the scene.
 *
 * Nothing here imports React or three, so it is unit-testable in plain node.
 */

import { GOLDEN_ANGLE, REFUTED_OPACITY, SHADOWED_OPACITY, TREE } from "./theme";
import { isFiniteNumber, type Vec3 } from "./math";

export type Verdict = "SUPPORTED" | "REFUTED" | "INCONCLUSIVE" | null;

export interface TreeNodeInput {
  id: string;
  parent_id: string | null;
  round: number;
  branch: string;
  statement: string;
  verdict: Verdict;
}

export interface PlacedNode {
  id: string;
  /** Index into the layout's arrival order; also the animation stagger slot. */
  order: number;
  position: Vec3;
  depth: number;
  branch: string;
  branchIndex: number;
  /** Resolved parent, or null when absent/missing/cyclic. */
  parentId: string | null;
}

export interface TreeLayout {
  nodes: PlacedNode[];
  byId: Record<string, PlacedNode>;
  edges: { id: string; from: Vec3; to: Vec3; childId: string; parentId: string }[];
  /** branch name -> stable index (arrival order). */
  branchIndex: Record<string, number>;
  /** (branch|round) -> how many nodes have claimed a lateral slot there. */
  slots: Record<string, number>;
  /** Max |xz| radius reached at each depth, for the round guide rings. */
  radiusByDepth: Record<number, number>;
  maxDepth: number;
}

export const EMPTY_LAYOUT: TreeLayout = {
  nodes: [],
  byId: {},
  edges: [],
  branchIndex: {},
  slots: {},
  radiusByDepth: {},
  maxDepth: 0,
};

/** 0, +1, -1, +2, -2, … — one-sided growth, so an added sibling never shifts
 *  the ones already placed (a centred fan would). */
function slotOffset(k: number): number {
  const step = Math.ceil(k / 2);
  return k % 2 === 1 ? step : -step;
}

function isUsableNode(n: unknown): n is TreeNodeInput {
  return !!n && typeof (n as TreeNodeInput).id === "string" && (n as TreeNodeInput).id.length > 0;
}

/**
 * Lay out `nodes`, reusing every placement present in `previous`.
 *
 * Called with no `previous` it is a pure function of the input order, which is
 * what the layout-stability tests assert.
 */
export function layoutTree(
  nodes: readonly TreeNodeInput[] | null | undefined,
  previous: TreeLayout = EMPTY_LAYOUT,
): TreeLayout {
  const input = Array.isArray(nodes) ? nodes.filter(isUsableNode) : [];

  // A different campaign (or a replay from scratch) shares no ids with the
  // cache: keeping the old placements would wedge the new tree into the shape
  // of the old one, so the cache is dropped.
  const cached = Object.keys(previous.byId);
  if (input.length && cached.length && !input.some((n) => previous.byId[n.id])) {
    previous = EMPTY_LAYOUT;
  }

  const byId: Record<string, PlacedNode> = { ...previous.byId };
  const branchIndex: Record<string, number> = { ...previous.branchIndex };
  const slots: Record<string, number> = { ...previous.slots };
  // Arrival order counts everything ever placed, not what is currently shown,
  // or a scrub back would hand two nodes the same order.
  let order = Object.keys(previous.byId).length;

  // De-duplicate ids, keeping the first occurrence (the stream may repeat one).
  const seen = new Set<string>();
  const unique: TreeNodeInput[] = [];
  for (const n of input) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    unique.push(n);
  }
  const present = new Map(unique.map((n) => [n.id, n] as const));

  const place = (n: TreeNodeInput) => {
    if (byId[n.id]) return;

    const branch = typeof n.branch === "string" && n.branch ? n.branch : "main";
    if (!(branch in branchIndex)) branchIndex[branch] = Object.keys(branchIndex).length;

    // A parent is only usable if it is actually placed; a missing or
    // not-yet-arrived parent makes this node a root of its own.
    const rawParent = typeof n.parent_id === "string" ? n.parent_id : null;
    const parent = rawParent && rawParent !== n.id ? byId[rawParent] : undefined;
    const parentId = parent ? parent.id : null;

    const roundDepth = isFiniteNumber(n.round) ? Math.max(0, Math.round(n.round) - 1) : 0;
    // Depth must strictly increase along an edge, or siblings and parents
    // collide when the backend reuses a round number for a branch.
    const depth = parent ? Math.max(roundDepth, parent.depth + 1) : roundDepth;

    const slotKey = `${branch}|${depth}`;
    const k = slots[slotKey] ?? 0;
    slots[slotKey] = k + 1;

    const theta = branchIndex[branch] * GOLDEN_ANGLE;
    const radius = depth === 0 ? 0 : TREE.radialStep * depth;
    const lateral = slotOffset(k) * TREE.siblingStep;
    // Lateral offsets run tangentially, so siblings fan out around the branch
    // direction instead of stacking along it.
    let x = Math.cos(theta) * radius - Math.sin(theta) * lateral;
    let z = Math.sin(theta) * radius + Math.cos(theta) * lateral;

    if (parent) {
      x = parent.position[0] + (x - parent.position[0]) * (1 - TREE.parentPull);
      z = parent.position[2] + (z - parent.position[2]) * (1 - TREE.parentPull);
    }

    byId[n.id] = {
      id: n.id,
      order: order++,
      position: [x, depth * TREE.levelHeight, z],
      depth,
      branch,
      branchIndex: branchIndex[branch],
      parentId,
    };
  };

  // Place parents before children where the input order does not already do so.
  // Repeat until a pass makes no progress, then place the rest as roots.
  let remaining = unique.filter((n) => !byId[n.id]);
  while (remaining.length) {
    const next: TreeNodeInput[] = [];
    for (const n of remaining) {
      const p = typeof n.parent_id === "string" ? n.parent_id : null;
      const waiting = !!p && p !== n.id && !byId[p] && present.has(p);
      if (waiting) next.push(n);
      else place(n);
    }
    if (next.length === remaining.length) {
      // A cycle (a -> b -> a): break it deterministically at the first node.
      place(next[0]);
      remaining = next.filter((n) => !byId[n.id]);
    } else {
      remaining = next;
    }
  }

  // `byId` is a position *cache* that outlives the current input; what gets
  // rendered is only what the input still contains. The app shell scrubs the
  // event log back and forth, so a node that is no longer in the log must
  // disappear, however firmly its position is remembered.
  const placed = unique
    .map((n) => byId[n.id])
    .filter((n): n is PlacedNode => !!n)
    .sort((a, b) => a.order - b.order)
    .map((n) => {
      // Re-resolve the parent against the *current* input: a child that
      // arrived one event before its parent would otherwise never get an edge.
      const raw = present.get(n.id)?.parent_id;
      const parentId =
        typeof raw === "string" && raw !== n.id && present.has(raw) && byId[raw] ? raw : null;
      return parentId === n.parentId ? n : { ...n, parentId };
    });

  const edges: TreeLayout["edges"] = [];
  const radiusByDepth: Record<number, number> = {};
  let maxDepth = 0;
  for (const node of placed) {
    maxDepth = Math.max(maxDepth, node.depth);
    const r = Math.hypot(node.position[0], node.position[2]);
    radiusByDepth[node.depth] = Math.max(radiusByDepth[node.depth] ?? 0, r);
    const parent = node.parentId ? byId[node.parentId] : undefined;
    // An edge is drawn only when both ends are on screen.
    if (parent && present.has(parent.id)) {
      edges.push({
        id: `${parent.id}->${node.id}`,
        from: parent.position,
        to: node.position,
        parentId: parent.id,
        childId: node.id,
      });
    }
  }

  return { nodes: placed, byId, edges, branchIndex, slots, radiusByDepth, maxDepth };
}

export interface NodeState {
  /** The node's own verdict color weight: 1 = full, lower = dimmed. */
  opacity: number;
  /** True when this node is itself refuted. */
  refuted: boolean;
  /** True when a refuted hypothesis sits somewhere above it. */
  shadowed: boolean;
}

/**
 * Resolve how dark each node should go.
 *
 * A refuted hypothesis drops to ~25% opacity; everything that grew out of it is
 * dimmed too, but less, so the branch stays readable — the point of the visual
 * is that you can still see what was learned from the dead end.
 *
 * The ancestor walk is bounded by a visited set, because `parent_id` arrives
 * from an LLM and a self- or mutual-parent is a real possibility.
 */
export function nodeStates(
  nodes: readonly TreeNodeInput[] | null | undefined,
): Record<string, NodeState> {
  const list = Array.isArray(nodes) ? nodes.filter(isUsableNode) : [];
  const verdict = new Map<string, Verdict>();
  const parent = new Map<string, string | null>();
  for (const n of list) {
    if (verdict.has(n.id)) continue;
    verdict.set(n.id, n.verdict ?? null);
    parent.set(n.id, typeof n.parent_id === "string" ? n.parent_id : null);
  }

  const out: Record<string, NodeState> = {};
  for (const n of list) {
    if (out[n.id]) continue;
    const refuted = verdict.get(n.id) === "REFUTED";
    let shadowed = false;
    const visited = new Set<string>([n.id]);
    let cursor = parent.get(n.id) ?? null;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      if (verdict.get(cursor) === "REFUTED") {
        shadowed = true;
        break;
      }
      cursor = parent.get(cursor) ?? null;
    }
    out[n.id] = {
      refuted,
      shadowed,
      opacity: refuted ? REFUTED_OPACITY : shadowed ? SHADOWED_OPACITY : 1,
    };
  }
  return out;
}
