/**
 * ARC AGI heuristic ML solver.
 *
 * Real (small) machine-learning approach:
 *   1. Define a library of geometric primitives (identity, hflip, vflip,
 *      transpose, rotate90/180/270).
 *   2. For each primitive, search for a per-color permutation π that maps
 *      `primitive(input)` onto `output` for every train pair simultaneously.
 *   3. The chosen (primitive, π) is the learned hypothesis. Apply it to the
 *      test input to produce a prediction.
 *
 * This is the same template-matching structure used by the strongest
 * non-neural baselines on the ARC AGI Kaggle challenge — it solves a real
 * subset of public tasks (identity, flips, rotations, color swaps) without
 * any external deps. It's intentionally small so it runs offline inside
 * the demo and is easy to read end-to-end.
 *
 * NB: ARC AGI grids are integer matrices in [0..9]; "color" = digit.
 */

export type Grid = number[][];

export interface ArcTask {
  /** Stable id used for logging & verdict aggregation. */
  id: string;
  train: Array<{ input: Grid; output: Grid }>;
  test: Array<{ input: Grid; output?: Grid }>;
}

export interface ArcAttempt {
  taskId: string;
  primitive: PrimitiveName;
  /** color permutation: map[c] = output color for input color c. -1 means
   *  "no mapping observed in train" — left unchanged at apply time. */
  colorMap: number[];
  /** Predicted outputs for each test pair. */
  predictions: Grid[];
  /** True iff every (primitive, π) hypothesis matched every train pair. */
  trainExact: boolean;
  /** Per-cell accuracy across train pairs after applying the hypothesis. */
  trainAccuracy: number;
}

export type PrimitiveName =
  | 'identity'
  | 'hflip'
  | 'vflip'
  | 'transpose'
  | 'rot90'
  | 'rot180'
  | 'rot270';

// ─── Primitives ───────────────────────────────────────────────

const PRIMITIVES: Record<PrimitiveName, (g: Grid) => Grid> = {
  identity: (g) => g.map((row) => [...row]),
  hflip: (g) => g.map((row) => [...row].reverse()),
  vflip: (g) => [...g].reverse().map((row) => [...row]),
  transpose: (g) => {
    if (g.length === 0) return [];
    const w = g[0]!.length;
    const out: Grid = [];
    for (let i = 0; i < w; i++) {
      const row: number[] = [];
      for (let j = 0; j < g.length; j++) row.push(g[j]![i]!);
      out.push(row);
    }
    return out;
  },
  rot90: (g) => PRIMITIVES.transpose(PRIMITIVES.vflip(g)),
  rot180: (g) => PRIMITIVES.hflip(PRIMITIVES.vflip(g)),
  rot270: (g) => PRIMITIVES.transpose(PRIMITIVES.hflip(g)),
};

// ─── Color permutation learner ────────────────────────────────

/**
 * Try to learn a per-color mapping π s.t. π(primitive(input)) == output for
 * EVERY train pair. Returns null if no consistent mapping exists.
 */
function learnColorMap(
  pairs: Array<{ input: Grid; output: Grid }>,
  primitive: (g: Grid) => Grid,
): number[] | null {
  // Initialise as "unknown" (-1).
  const map: number[] = Array(10).fill(-1);
  for (const pair of pairs) {
    const transformed = primitive(pair.input);
    if (
      transformed.length !== pair.output.length ||
      transformed[0]?.length !== pair.output[0]?.length
    ) {
      return null; // shape mismatch — primitive not a fit
    }
    for (let i = 0; i < transformed.length; i++) {
      for (let j = 0; j < transformed[i]!.length; j++) {
        const src = transformed[i]![j]!;
        const tgt = pair.output[i]![j]!;
        if (map[src] === -1) {
          map[src] = tgt;
        } else if (map[src] !== tgt) {
          return null; // contradiction — π not a function
        }
      }
    }
  }
  return map;
}

function applyColorMap(g: Grid, map: number[]): Grid {
  return g.map((row) => row.map((c) => (map[c] === -1 ? c : map[c]!)));
}

function gridsEqual(a: Grid, b: Grid): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.length !== b[i]!.length) return false;
    for (let j = 0; j < a[i]!.length; j++) {
      if (a[i]![j] !== b[i]![j]) return false;
    }
  }
  return true;
}

// ─── Main solver ──────────────────────────────────────────────

/**
 * Try every primitive × color permutation hypothesis. Returns the first
 * hypothesis that exactly solves all train pairs; if none does, returns
 * the hypothesis with the highest per-cell train accuracy (best-effort).
 */
export function solveArcTask(task: ArcTask): ArcAttempt {
  let best: ArcAttempt | null = null;

  for (const name of Object.keys(PRIMITIVES) as PrimitiveName[]) {
    const fn = PRIMITIVES[name];
    const map = learnColorMap(task.train, fn);
    if (!map) continue;

    // Score the learned hypothesis on train.
    let totalCells = 0;
    let matchedCells = 0;
    let allExact = true;
    for (const pair of task.train) {
      const pred = applyColorMap(fn(pair.input), map);
      if (!gridsEqual(pred, pair.output)) allExact = false;
      for (let i = 0; i < pair.output.length; i++) {
        for (let j = 0; j < pair.output[i]!.length; j++) {
          totalCells++;
          if (pred[i]?.[j] === pair.output[i]![j]) matchedCells++;
        }
      }
    }
    const acc = totalCells > 0 ? matchedCells / totalCells : 0;

    const predictions = task.test.map((t) => applyColorMap(fn(t.input), map));
    const attempt: ArcAttempt = {
      taskId: task.id,
      primitive: name,
      colorMap: map,
      predictions,
      trainExact: allExact,
      trainAccuracy: acc,
    };

    if (allExact) return attempt; // perfect — short-circuit
    if (!best || acc > best.trainAccuracy) best = attempt;
  }

  // Fallback: pure identity guess if nothing learned.
  if (!best) {
    best = {
      taskId: task.id,
      primitive: 'identity',
      colorMap: Array(10).fill(-1),
      predictions: task.test.map((t) => t.input.map((r) => [...r])),
      trainExact: false,
      trainAccuracy: 0,
    };
  }
  return best;
}

// ─── Sample real ARC-style tasks ─────────────────────────────
// 5 minimal tasks covering the four solvable transformation classes.
// These mirror the JSON shape of public ARC AGI corpus files
// (https://github.com/fchollet/ARC) without bundling the dataset.

export const SAMPLE_ARC_TASKS: ArcTask[] = [
  {
    id: 'identity-3x3',
    train: [
      { input: [[1, 0, 1], [0, 1, 0], [1, 0, 1]], output: [[1, 0, 1], [0, 1, 0], [1, 0, 1]] },
    ],
    test: [{ input: [[2, 0, 2], [0, 2, 0], [2, 0, 2]], output: [[2, 0, 2], [0, 2, 0], [2, 0, 2]] }],
  },
  {
    id: 'hflip-2x3',
    train: [
      { input: [[1, 2, 3], [4, 5, 6]], output: [[3, 2, 1], [6, 5, 4]] },
      { input: [[0, 0, 9], [9, 0, 0]], output: [[9, 0, 0], [0, 0, 9]] },
    ],
    test: [{ input: [[7, 8, 1], [2, 3, 4]], output: [[1, 8, 7], [4, 3, 2]] }],
  },
  {
    id: 'vflip-3x2',
    train: [
      { input: [[1, 2], [3, 4], [5, 6]], output: [[5, 6], [3, 4], [1, 2]] },
    ],
    test: [{ input: [[9, 0], [0, 9], [9, 9]], output: [[9, 9], [0, 9], [9, 0]] }],
  },
  {
    id: 'color-swap-2x2',
    train: [
      { input: [[1, 1], [2, 2]], output: [[3, 3], [4, 4]] },
      { input: [[2, 1], [1, 2]], output: [[4, 3], [3, 4]] },
    ],
    test: [{ input: [[1, 2], [2, 1]], output: [[3, 4], [4, 3]] }],
  },
  {
    id: 'rot90-2x2',
    train: [
      { input: [[1, 2], [3, 4]], output: [[3, 1], [4, 2]] },
    ],
    test: [{ input: [[5, 6], [7, 8]], output: [[7, 5], [8, 6]] }],
  },
];
