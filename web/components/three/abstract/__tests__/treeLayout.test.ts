/**
 * Layout and verdict-propagation tests for the hypothesis tree.
 *
 * Run with: see `run-tests.sh` in this directory (node's built-in test runner,
 * after a standalone tsc pass — the repo has no test framework installed).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { EMPTY_LAYOUT, layoutTree, nodeStates, type TreeNodeInput } from "../treeLayout";
import { FIXTURE_HYPOTHESES, FIXTURE_VERDICTS } from "./fixtures";

function node(
  id: string,
  parent_id: string | null,
  round: number,
  branch = "main",
  verdict: TreeNodeInput["verdict"] = null,
): TreeNodeInput {
  return { id, parent_id, round, branch, statement: `statement ${id}`, verdict };
}

/** The real campaign, as the app shell would assemble it. */
const fixtureNodes: TreeNodeInput[] = FIXTURE_HYPOTHESES.map((h) => ({
  id: h.id,
  parent_id: h.parent_id,
  round: h.round,
  branch: h.branch,
  statement: h.statement,
  verdict: FIXTURE_VERDICTS[h.id] ?? null,
}));

test("the real fixture campaign lays out", () => {
  const layout = layoutTree(fixtureNodes);
  assert.equal(layout.nodes.length, fixtureNodes.length);
  assert.equal(layout.nodes[0].depth, 0);
  assert.deepEqual(layout.nodes[0].position, [0, 0, 0]);
  assert.equal(layout.edges.length, 0); // one root hypothesis, no edges yet
});

test("empty, null and malformed inputs return an empty layout", () => {
  for (const input of [[], null, undefined]) {
    const layout = layoutTree(input as TreeNodeInput[] | null | undefined);
    assert.equal(layout.nodes.length, 0);
    assert.equal(layout.edges.length, 0);
  }
  // Entries without a usable id are dropped rather than throwing.
  const junk = layoutTree([
    { id: "", parent_id: null, round: 1, branch: "main", statement: "", verdict: null },
    node("ok", null, 1),
  ]);
  assert.deepEqual(
    junk.nodes.map((n) => n.id),
    ["ok"],
  );
});

test("a single node sits at the origin", () => {
  const layout = layoutTree([node("h1", null, 1)]);
  assert.deepEqual(layout.byId.h1.position, [0, 0, 0]);
  assert.equal(layout.maxDepth, 0);
});

test("a deep chain climbs monotonically in +Y with one edge per link", () => {
  const chain = Array.from({ length: 12 }, (_, i) =>
    node(`h${i}`, i === 0 ? null : `h${i - 1}`, i + 1),
  );
  const layout = layoutTree(chain);
  assert.equal(layout.edges.length, 11);
  for (let i = 1; i < chain.length; i++) {
    const prev = layout.byId[`h${i - 1}`];
    const cur = layout.byId[`h${i}`];
    assert.ok(cur.position[1] > prev.position[1], `h${i} must sit above h${i - 1}`);
    assert.equal(cur.depth, prev.depth + 1);
  }
});

test("parallel branches splay into different directions", () => {
  const nodes = [
    node("root", null, 1),
    node("a1", "root", 2, "anion-substitution"),
    node("b1", "root", 2, "framework-swap"),
    node("c1", "root", 2, "dopant-ladder"),
  ];
  const layout = layoutTree(nodes);
  const dirs = ["a1", "b1", "c1"].map((id) => {
    const p = layout.byId[id].position;
    return Math.atan2(p[2], p[0]);
  });
  for (let i = 0; i < dirs.length; i++) {
    for (let j = i + 1; j < dirs.length; j++) {
      const sep = Math.abs(Math.atan2(Math.sin(dirs[i] - dirs[j]), Math.cos(dirs[i] - dirs[j])));
      assert.ok(sep > 0.3, `branches ${i} and ${j} overlap (separation ${sep})`);
    }
  }
});

test("siblings in one branch and round do not collide", () => {
  const nodes = [
    node("root", null, 1),
    node("s1", "root", 2),
    node("s2", "root", 2),
    node("s3", "root", 2),
    node("s4", "root", 2),
  ];
  const layout = layoutTree(nodes);
  const ids = ["s1", "s2", "s3", "s4"];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = layout.byId[ids[i]].position;
      const b = layout.byId[ids[j]].position;
      assert.ok(Math.hypot(a[0] - b[0], a[2] - b[2]) > 0.3, `${ids[i]} and ${ids[j]} collide`);
    }
  }
});

test("a node whose parent_id points at nothing is placed as a root", () => {
  const layout = layoutTree([node("orphan", "does-not-exist", 3), node("root", null, 1)]);
  assert.equal(layout.nodes.length, 2);
  assert.equal(layout.byId.orphan.parentId, null);
  assert.equal(layout.edges.length, 0);
});

test("a child arriving before its parent still gets the parent's edge", () => {
  const layout = layoutTree([node("child", "parent", 2), node("parent", null, 1)]);
  assert.equal(layout.byId.child.parentId, "parent");
  assert.equal(layout.edges.length, 1);
  assert.ok(layout.byId.child.position[1] > layout.byId.parent.position[1]);
});

test("self-parents and parent cycles terminate", () => {
  const selfy = layoutTree([node("a", "a", 1)]);
  assert.equal(selfy.nodes.length, 1);
  assert.equal(selfy.byId.a.parentId, null);

  const cyclic = layoutTree([node("a", "b", 1), node("b", "a", 2)]);
  assert.equal(cyclic.nodes.length, 2);
  assert.equal(nodeStates([node("a", "b", 1), node("b", "a", 2)]).a.shadowed, false);
});

test("duplicate ids collapse to one node", () => {
  const layout = layoutTree([node("h1", null, 1), node("h1", null, 1), node("h2", "h1", 2)]);
  assert.equal(layout.nodes.length, 2);
  assert.equal(layout.edges.length, 1);
});

test("a non-finite round degrades to depth 0 without producing NaN positions", () => {
  const layout = layoutTree([
    node("h1", null, Number.NaN),
    node("h2", "h1", Number.POSITIVE_INFINITY),
  ]);
  for (const n of layout.nodes) {
    for (const c of n.position) assert.ok(Number.isFinite(c), `NaN coordinate on ${n.id}`);
  }
  assert.ok(layout.byId.h2.position[1] > layout.byId.h1.position[1]);
});

// ---------------------------------------------------------------------------
// Stability — the requirement that makes the growth animation readable.
// ---------------------------------------------------------------------------

function growingCampaign(n: number): TreeNodeInput[] {
  const branches = ["main", "halide-swap", "dopant", "framework"];
  const out: TreeNodeInput[] = [node("h0", null, 1)];
  for (let i = 1; i < n; i++) {
    out.push(
      node(
        `h${i}`,
        `h${Math.max(0, i - 1 - (i % 3))}`,
        1 + Math.floor(i / 3),
        branches[i % branches.length],
      ),
    );
  }
  return out;
}

test("layout for N nodes is unchanged by adding the N+1st (no previous state)", () => {
  for (let n = 1; n < 24; n++) {
    const a = layoutTree(growingCampaign(n));
    const b = layoutTree(growingCampaign(n + 1));
    for (const placed of a.nodes) {
      assert.deepEqual(
        b.byId[placed.id].position,
        placed.position,
        `node ${placed.id} moved when the tree grew from ${n} to ${n + 1}`,
      );
      assert.equal(b.byId[placed.id].order, placed.order);
    }
  }
});

test("incremental layout matches a from-scratch layout node for node", () => {
  let carried = EMPTY_LAYOUT;
  for (let n = 1; n <= 20; n++) {
    carried = layoutTree(growingCampaign(n), carried);
  }
  const fresh = layoutTree(growingCampaign(20));
  for (const placed of fresh.nodes) {
    assert.deepEqual(carried.byId[placed.id].position, placed.position, `drift on ${placed.id}`);
  }
});

test("re-ordering the nodes array does not move anything already placed", () => {
  const first = layoutTree(growingCampaign(15));
  const shuffled = [...growingCampaign(16)].reverse();
  const next = layoutTree(shuffled, first);
  for (const placed of first.nodes) {
    assert.deepEqual(
      next.byId[placed.id].position,
      placed.position,
      `node ${placed.id} moved when the array was re-ordered`,
    );
  }
  assert.equal(next.nodes.length, 16);
});

test("scrubbing the log back removes nodes but remembers where they were", () => {
  const full = layoutTree(growingCampaign(15));
  // The shell scrubs back to an earlier event: fewer nodes arrive.
  const rewound = layoutTree(growingCampaign(10), full);
  assert.equal(rewound.nodes.length, 10, "nodes dropped from the log must leave the scene");
  assert.equal(rewound.maxDepth, layoutTree(growingCampaign(10)).maxDepth);
  for (const n of rewound.nodes) {
    assert.deepEqual(n.position, full.byId[n.id].position, `${n.id} moved on scrub back`);
  }
  for (const e of rewound.edges) {
    assert.ok(rewound.byId[e.childId] && rewound.byId[e.parentId]);
    assert.ok(
      rewound.nodes.some((n) => n.id === e.childId) &&
        rewound.nodes.some((n) => n.id === e.parentId),
      "an edge must not dangle to a node that is no longer shown",
    );
  }

  // Scrubbed to the very start: nothing is rendered, even with a warm cache.
  const emptied = layoutTree([], rewound);
  assert.equal(emptied.nodes.length, 0);
  assert.equal(emptied.edges.length, 0);

  // And forward again: the same positions as the first time through.
  const replayed = layoutTree(growingCampaign(15), emptied);
  assert.equal(replayed.nodes.length, 15);
  for (const n of full.nodes) {
    assert.deepEqual(replayed.byId[n.id].position, n.position, `${n.id} drifted on replay`);
  }
});

test("a different campaign resets the cache instead of inheriting its shape", () => {
  const first = layoutTree(growingCampaign(12));
  const other = layoutTree(
    [node("x1", null, 1), node("x2", "x1", 2, "beta"), node("x3", "x1", 2, "beta")],
    first,
  );
  assert.equal(other.nodes.length, 3);
  assert.deepEqual(other.byId.x1.position, [0, 0, 0]);
  assert.equal(other.nodes[0].order, 0);
});

test("a verdict arriving changes nothing about the geometry", () => {
  const before = layoutTree(growingCampaign(10));
  const withVerdicts = growingCampaign(10).map((n, i) =>
    i % 4 === 0 ? { ...n, verdict: "REFUTED" as const } : n,
  );
  const after = layoutTree(withVerdicts, before);
  for (const placed of before.nodes) {
    assert.deepEqual(after.byId[placed.id].position, placed.position);
  }
});

// ---------------------------------------------------------------------------
// Verdict propagation — "a refuted branch visibly goes dark".
// ---------------------------------------------------------------------------

test("a refuted hypothesis dims itself hardest and its subtree a little less", () => {
  const nodes = [
    node("root", null, 1, "main", "SUPPORTED"),
    node("dead", "root", 2, "main", "REFUTED"),
    node("deadChild", "dead", 3, "main", null),
    node("deadGrand", "deadChild", 4, "main", "SUPPORTED"),
    node("alive", "root", 2, "other", "SUPPORTED"),
  ];
  const states = nodeStates(nodes);
  assert.equal(states.dead.refuted, true);
  assert.ok(states.dead.opacity <= 0.25 + 1e-9, "refuted node must drop to ~25% opacity");
  assert.equal(states.deadChild.shadowed, true);
  assert.equal(states.deadGrand.shadowed, true);
  assert.ok(states.deadChild.opacity > states.dead.opacity, "subtree must stay legible");
  assert.ok(states.deadChild.opacity < states.alive.opacity, "subtree must still be dimmed");
  assert.equal(states.alive.shadowed, false);
  assert.equal(states.root.opacity, 1);
});

test("the fixture's refuted root hypothesis goes dark", () => {
  const states = nodeStates(fixtureNodes);
  assert.equal(states.h1.refuted, true);
  assert.ok(states.h1.opacity <= 0.25 + 1e-9);
});

test("nodeStates survives empty and malformed input", () => {
  assert.deepEqual(nodeStates([]), {});
  assert.deepEqual(nodeStates(null), {});
  assert.deepEqual(nodeStates(undefined), {});
});
