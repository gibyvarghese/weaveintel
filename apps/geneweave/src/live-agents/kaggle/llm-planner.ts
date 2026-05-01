/**
 * LLM-driven planner for the Kaggle live-agents pipeline.
 *
 * Given the full competition context and prior iteration feedback, asks an
 * LLM to produce a structured plan with executable Python kernel code.
 *
 * The LLM is instructed to:
 *   - Read the competition description and evaluation metric
 *   - Use only the listed data files (paths under /kaggle/input/<slug>/)
 *   - Produce a self-contained Python script that writes submission.json
 *     (or submission.csv) into the kernel working directory
 *   - Print a short progress + scoring summary so the next iteration can
 *     learn from real numbers rather than guesses
 */

import { weaveContext } from '@weaveintel/core';
import type { Model } from '@weaveintel/core';

export interface CompetitionContext {
  id: string;
  title: string;
  description: string;
  evaluationMetric: string;
  deadline: string | null;
  reward: string | null;
  category: string | null;
  dataFiles: Array<{ name: string; size: number }>;
}

export interface IterationFeedback {
  iteration: number;
  strategyLabel: string;
  kernelStatus: string;
  failureMessage: string | null;
  outputFiles: string[];
  /** Raw kernel log JSON-array string from Kaggle (last ~4 KB). */
  rawLog: string;
  /** Extracted plain-text last lines of the log for quick LLM consumption. */
  logTail: string;
  hasSubmission: boolean;
  detectedScore: number | null;
}

export interface SolverPlan {
  /** Short label for this attempt (used in kernel slug + history). */
  label: string;
  /** One-paragraph rationale the LLM gives for this approach. */
  rationale: string;
  /** Full Python script body to push as a Kaggle kernel. */
  pythonCode: string;
  /** Whether the LLM thinks more iterations would help (validator hint). */
  expectsImprovement: boolean;
}

const SYSTEM_PROMPT = `You are a Kaggle Grandmaster acting as the planning brain for an autonomous agent that runs Python kernels on Kaggle.

You will receive:
  - The competition description, evaluation metric, and a listing of the data files Kaggle will mount at /kaggle/input/<competition-slug>/
  - (Optional) the result of a previous iteration: kernel status, output files, and the tail of the kernel log

Your job is to return a single JSON object with this exact shape:
{
  "label": "<3-6 word kebab-case identifier for this attempt>",
  "rationale": "<one paragraph explaining the approach>",
  "pythonCode": "<COMPLETE self-contained Python 3 script>",
  "expectsImprovement": <boolean: true if you believe another iteration could help>
}

Rules for the Python script:
  - Start by listing every file under /kaggle/input recursively and printing the tree (helps next iteration debug paths).
  - Use ONLY the data files listed in the prompt; reference them by full /kaggle/input/<slug>/<name> paths.
  - Stick to the standard Kaggle Python image (numpy, pandas, scikit-learn, scipy, pytorch, json, os, re). Do NOT pip install anything new.
  - Always write the submission file to the current working directory (e.g. ./submission.json or ./submission.csv) per the competition's required format.
  - Print a final line of the form "AGENT_RESULT: status=<ok|fail> score=<number-or-NA> notes=<short-string>" so the next iteration can parse it.
  - Wrap the main logic in try/except and on failure print "AGENT_RESULT: status=fail score=NA notes=<exception class + message>". Always exit 0 so the kernel itself does not error.
  - Keep runtime well under 5 minutes.

Return ONLY the JSON object — no markdown fences, no extra prose.`;

function renderUserPrompt(comp: CompetitionContext, feedback: IterationFeedback | null): string {
  const filesSummary = comp.dataFiles.length
    ? comp.dataFiles
        .slice(0, 50)
        .map((f) => `  - ${f.name} (${(f.size / 1024).toFixed(1)} KB)`)
        .join('\n')
    : '  (no data files reported by Kaggle API — agent must walk /kaggle/input at runtime)';

  const baseBlock = [
    `Competition: ${comp.title}`,
    `Slug: ${comp.id}`,
    `Category: ${comp.category ?? 'unknown'}`,
    `Evaluation metric: ${comp.evaluationMetric || 'unspecified'}`,
    `Deadline: ${comp.deadline ?? 'unspecified'}`,
    `Reward: ${comp.reward ?? 'unspecified'}`,
    ``,
    `Description:`,
    comp.description ? comp.description.slice(0, 4000) : '(empty)',
    ``,
    `Data files mounted at /kaggle/input/${comp.id}/:`,
    filesSummary,
  ].join('\n');

  if (!feedback) {
    return `${baseBlock}

This is iteration 1 (first attempt). Propose a STRONG baseline that is most likely to produce a valid submission file in the correct format. Explore the data structure inside the script and adapt.`;
  }

  return `${baseBlock}

PRIOR ITERATION ${feedback.iteration} ("${feedback.strategyLabel}") result:
  - kernelStatus: ${feedback.kernelStatus}
  - failureMessage: ${feedback.failureMessage ?? '(none)'}
  - outputFiles: ${JSON.stringify(feedback.outputFiles)}
  - hasSubmission: ${feedback.hasSubmission}
  - detectedScore: ${feedback.detectedScore ?? 'NA'}

Last ~30 lines of kernel log:
${feedback.logTail || '(no log captured)'}

Improve on the prior attempt. If it failed, fix the failure first. If it succeeded but produced a weak score, propose a substantively different approach (different model family, different feature engineering, smarter post-processing).`;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  // Strip optional ```json fences just in case the LLM ignores instructions.
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  // Find first { and last } to be tolerant of leading/trailing prose.
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s) as Record<string, unknown>;
}

export async function planSolverWithLLM(
  model: Model,
  comp: CompetitionContext,
  feedback: IterationFeedback | null,
): Promise<SolverPlan> {
  const ctx = weaveContext({ userId: 'kaggle-strategist' });
  const response = await model.generate(ctx, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: renderUserPrompt(comp, feedback) },
    ],
    temperature: 0.4,
    maxTokens: 4000,
  });
  const obj = parseJsonObject(response.content || '');
  const label = typeof obj['label'] === 'string' && obj['label'] ? (obj['label'] as string) : `iter-${(feedback?.iteration ?? 0) + 1}`;
  const rationale = typeof obj['rationale'] === 'string' ? (obj['rationale'] as string) : '';
  const pythonCode = typeof obj['pythonCode'] === 'string' ? (obj['pythonCode'] as string) : '';
  const expectsImprovement = obj['expectsImprovement'] === true;
  if (!pythonCode.trim()) {
    throw new Error('LLM planner returned empty pythonCode field');
  }
  return { label: label.slice(0, 40), rationale, pythonCode, expectsImprovement };
}

/**
 * Scout preamble — prepended to every kernel so we always log the data
 * inventory even if the LLM's generated code crashes early.
 */
export const SCOUT_PREAMBLE = `# === weaveintel scout preamble (auto-injected) ===
import os, sys, json
print("=== /kaggle/input tree ===")
for root, dirs, files in os.walk("/kaggle/input"):
    for f in files:
        try:
            p = os.path.join(root, f)
            size = os.path.getsize(p)
            print(f"FILE {p} {size}")
        except Exception as _e:
            print(f"FILE_ERR {root}/{f} {_e}")
print("=== end tree ===")
sys.stdout.flush()
# === end scout preamble ===

`;
